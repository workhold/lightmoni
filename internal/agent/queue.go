package agent

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"github.com/shirou/gopsutil/v4/disk"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite"
)

var ErrCapacity = errors.New("durable queue or receipt capacity exhausted")
var ErrConflict = errors.New("batch ID conflicts with previously accepted payload")

type Batch struct {
	ID          string    `json:"id"`
	Signal      string    `json:"signal"`
	Table       string    `json:"table"`
	Service     string    `json:"service"`
	CreatedAt   time.Time `json:"created_at"`
	Payload     []byte    `json:"payload"`
	ContentType string    `json:"content_type"`
}

type Receipt struct {
	InputHash   string
	ForwardHash string
	Identity    Identity
	ReceivedAt  time.Time
}
type Queued struct {
	Batch
	Attempts  int
	LastError string
}
type QueueStats struct {
	Bytes            int64 `json:"queue_bytes"`
	Batches          int   `json:"queue_batches"`
	Quarantine       int   `json:"quarantine_batches"`
	Receipts         int   `json:"receipts"`
	OldestAgeSeconds int64 `json:"oldest_age_seconds"`
}

type Queue struct {
	db  *sql.DB
	cfg Config
}

func OpenQueue(cfg Config) (*Queue, error) {
	db, err := sql.Open("sqlite", filepath.Join(cfg.DataDir, "queue.sqlite"))
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	q := &Queue{db: db, cfg: cfg}
	for _, stmt := range []string{
		`PRAGMA journal_mode=WAL`, `PRAGMA synchronous=FULL`, `PRAGMA busy_timeout=5000`,
		`CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY,input_hash TEXT NOT NULL,forward_hash TEXT NOT NULL,agent_id TEXT NOT NULL,host_id TEXT NOT NULL,received_ns INTEGER NOT NULL,expires_ns INTEGER NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS batches(id TEXT PRIMARY KEY,signal TEXT NOT NULL,table_name TEXT NOT NULL,service TEXT NOT NULL,created_ns INTEGER NOT NULL,payload BLOB NOT NULL,content_type TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,next_ns INTEGER NOT NULL DEFAULT 0,last_error TEXT NOT NULL DEFAULT '',FOREIGN KEY(id) REFERENCES receipts(id))`,
		`CREATE INDEX IF NOT EXISTS batches_due ON batches(state,next_ns,created_ns)`,
		`CREATE TABLE IF NOT EXISTS queue_actions(id INTEGER PRIMARY KEY,batch_id TEXT NOT NULL,action TEXT NOT NULL,at_ns INTEGER NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS log_cursors(id TEXT PRIMARY KEY,offset INTEGER NOT NULL,generation INTEGER NOT NULL,prefix BLOB NOT NULL,path TEXT NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS log_sources(id TEXT PRIMARY KEY)`,
	} {
		if _, err = db.Exec(stmt); err != nil {
			db.Close()
			return nil, err
		}
	}
	var integrity string
	if err = db.QueryRow(`PRAGMA quick_check`).Scan(&integrity); err != nil || integrity != "ok" {
		db.Close()
		return nil, fmt.Errorf("queue integrity failure: %v %s", err, integrity)
	}
	return q, nil
}

func (q *Queue) Close() error   { return q.db.Close() }
func digest(data []byte) string { sum := sha256.Sum256(data); return hex.EncodeToString(sum[:]) }

func (q *Queue) Receipt(ctx context.Context, id string) (Receipt, bool, error) {
	var r Receipt
	var ns int64
	err := q.db.QueryRowContext(ctx, `SELECT input_hash,forward_hash,agent_id,host_id,received_ns FROM receipts WHERE id=?`, id).Scan(&r.InputHash, &r.ForwardHash, &r.Identity.AgentID, &r.Identity.HostID, &ns)
	if err == sql.ErrNoRows {
		return r, false, nil
	}
	r.ReceivedAt = time.Unix(0, ns).UTC()
	return r, err == nil, err
}

func (q *Queue) Enqueue(ctx context.Context, b Batch, inputHash string, id Identity, received time.Time) error {
	return q.enqueue(ctx, b, inputHash, id, received, nil)
}

func (q *Queue) enqueue(ctx context.Context, b Batch, inputHash string, id Identity, received time.Time, cursor *logCursor) error {
	tx, err := q.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var oldInput, oldForward string
	err = tx.QueryRowContext(ctx, `SELECT input_hash,forward_hash FROM receipts WHERE id=?`, b.ID).Scan(&oldInput, &oldForward)
	if err == nil {
		if oldInput != inputHash || oldForward != digest(b.Payload) {
			return ErrConflict
		}
		return nil
	}
	if err != sql.ErrNoRows {
		return err
	}
	if q.cfg.MinFreeBytes > 0 {
		usage, err := disk.UsageWithContext(ctx, q.cfg.DataDir)
		if err != nil {
			return fmt.Errorf("queue filesystem check: %w", err)
		}
		if usage.Free < uint64(q.cfg.MinFreeBytes)+uint64(len(b.Payload))*2 {
			return ErrCapacity
		}
	}
	// Never evict receipts for batches still awaiting delivery or quarantine review.
	_, err = tx.ExecContext(ctx, `DELETE FROM receipts WHERE expires_ns<? AND id NOT IN (SELECT id FROM batches)`, time.Now().UnixNano())
	if err != nil {
		return err
	}
	var bytes int64
	var count, receipts int
	if err = tx.QueryRowContext(ctx, `SELECT COALESCE(SUM(LENGTH(payload)),0),COUNT(*) FROM batches`).Scan(&bytes, &count); err != nil {
		return err
	}
	if err = tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM receipts`).Scan(&receipts); err != nil {
		return err
	}
	if bytes+int64(len(b.Payload)) > q.cfg.MaxQueueBytes || count >= q.cfg.MaxQueueBatches || receipts >= q.cfg.MaxReceipts {
		return ErrCapacity
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO receipts VALUES(?,?,?,?,?,?,?)`, b.ID, inputHash, digest(b.Payload), id.AgentID, id.HostID, received.UnixNano(), received.Add(time.Duration(q.cfg.ReceiptSeconds)*time.Second).UnixNano())
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO batches(id,signal,table_name,service,created_ns,payload,content_type) VALUES(?,?,?,?,?,?,?)`, b.ID, b.Signal, b.Table, b.Service, b.CreatedAt.UnixNano(), b.Payload, b.ContentType)
	if err != nil {
		return err
	}
	if cursor != nil {
		if err = saveLogCursor(ctx, tx, *cursor); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (q *Queue) Next(ctx context.Context) (Queued, bool, error) {
	var b Queued
	var ns int64
	err := q.db.QueryRowContext(ctx, `SELECT id,signal,table_name,service,created_ns,payload,content_type,attempts,last_error FROM batches WHERE state='pending' AND next_ns<=? ORDER BY created_ns,id LIMIT 1`, time.Now().UnixNano()).Scan(&b.ID, &b.Signal, &b.Table, &b.Service, &ns, &b.Payload, &b.ContentType, &b.Attempts, &b.LastError)
	if err == sql.ErrNoRows {
		return b, false, nil
	}
	b.CreatedAt = time.Unix(0, ns).UTC()
	return b, err == nil, err
}

func (q *Queue) Complete(ctx context.Context, id string) error {
	_, err := q.db.ExecContext(ctx, `DELETE FROM batches WHERE id=?`, id)
	return err
}
func (q *Queue) Retry(ctx context.Context, id, message string, next time.Time) error {
	_, err := q.db.ExecContext(ctx, `UPDATE batches SET attempts=attempts+1,last_error=?,next_ns=? WHERE id=?`, message, next.UnixNano(), id)
	return err
}
func (q *Queue) Quarantine(ctx context.Context, id, message string) error {
	_, err := q.db.ExecContext(ctx, `UPDATE batches SET state='quarantine',attempts=attempts+1,last_error=? WHERE id=?`, message, id)
	return err
}

func (q *Queue) Stats(ctx context.Context) (QueueStats, error) {
	var s QueueStats
	var oldest sql.NullInt64
	err := q.db.QueryRowContext(ctx, `SELECT COALESCE(SUM(LENGTH(payload)),0),COUNT(*),COALESCE(SUM(CASE WHEN state='quarantine' THEN 1 ELSE 0 END),0),MIN(created_ns) FROM batches`).Scan(&s.Bytes, &s.Batches, &s.Quarantine, &oldest)
	if err != nil {
		return s, err
	}
	if oldest.Valid {
		s.OldestAgeSeconds = int64(time.Since(time.Unix(0, oldest.Int64)).Seconds())
		if s.OldestAgeSeconds < 0 {
			s.OldestAgeSeconds = 0
		}
	}
	err = q.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM receipts`).Scan(&s.Receipts)
	return s, err
}

func (q *Queue) Quarantined(ctx context.Context) ([]map[string]any, error) {
	rows, err := q.db.QueryContext(ctx, `SELECT id,signal,table_name,service,created_ns,last_error,LENGTH(payload) FROM batches WHERE state='quarantine' ORDER BY created_ns LIMIT 100`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []map[string]any{}
	for rows.Next() {
		var id, signal, table, service, message string
		var ns, size int64
		if err = rows.Scan(&id, &signal, &table, &service, &ns, &message, &size); err != nil {
			return nil, err
		}
		result = append(result, map[string]any{"id": id, "signal": signal, "table": table, "service": service, "created_at": time.Unix(0, ns).UTC(), "error": message, "bytes": size})
	}
	return result, rows.Err()
}

// Resolve requires an operator action. Accepted telemetry is never discarded
// merely because its destination currently rejects it.
func (q *Queue) Resolve(ctx context.Context, id string, discard bool) error {
	tx, err := q.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var state string
	if err = tx.QueryRowContext(ctx, `SELECT state FROM batches WHERE id=?`, id).Scan(&state); err != nil {
		return err
	}
	if state != "quarantine" {
		return errors.New("batch is not quarantined")
	}
	action := "retry"
	if discard {
		action = "discard"
		_, err = tx.ExecContext(ctx, `DELETE FROM batches WHERE id=?`, id)
	} else {
		_, err = tx.ExecContext(ctx, `UPDATE batches SET state='pending',next_ns=0,last_error='' WHERE id=?`, id)
	}
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO queue_actions(batch_id,action,at_ns) VALUES(?,?,?)`, id, action, time.Now().UnixNano())
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `DELETE FROM queue_actions WHERE id NOT IN (SELECT id FROM queue_actions ORDER BY id DESC LIMIT 10000)`)
	if err != nil {
		return err
	}
	return tx.Commit()
}
