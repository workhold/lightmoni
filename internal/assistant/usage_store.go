package assistant

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"
)

// The separate ledger survives session retention and is shared by all users.
// Seconds and nanoseconds preserve chronological ordering for every RFC3339
// timestamp, including fractions that RFC3339Nano omits when they are zero.
func (s *SQLiteStore) initUsageStore(ctx context.Context) error {
	if _, err := s.db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS assistant_usage (
		id TEXT PRIMARY KEY,
		timestamp_seconds INTEGER NOT NULL,
		timestamp_nanos INTEGER NOT NULL,
		value BLOB NOT NULL
	)`); err != nil {
		return fmt.Errorf("create assistant usage ledger: %w", err)
	}
	if _, err := s.db.ExecContext(ctx, `CREATE INDEX IF NOT EXISTS assistant_usage_timestamp ON assistant_usage(timestamp_seconds,timestamp_nanos,id)`); err != nil {
		return fmt.Errorf("index assistant usage ledger: %w", err)
	}
	if err := s.backfillUsage(ctx); err != nil {
		return err
	}
	return s.recoverInterruptedUsage(ctx)
}

// This store is initialized by the service composition root at startup. After
// replaying retained final events, any remaining pending request belonged to a
// worker lost with the prior host process. It must not remain active forever.
func (s *SQLiteStore) recoverInterruptedUsage(ctx context.Context) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin interrupted assistant usage recovery: %w", err)
	}
	defer tx.Rollback()
	rows, err := tx.QueryContext(ctx, `SELECT value FROM assistant_usage WHERE json_extract(CAST(value AS TEXT),'$.status')='pending'`)
	if err != nil {
		return fmt.Errorf("read interrupted assistant usage: %w", err)
	}
	var interrupted []UsageRecord
	for rows.Next() {
		var value []byte
		if err := rows.Scan(&value); err != nil {
			rows.Close()
			return err
		}
		var record UsageRecord
		if err := json.Unmarshal(value, &record); err != nil {
			rows.Close()
			return err
		}
		record.Status, record.CompletedAt, record.FailureReason = UsageFailed, now(), "service_interrupted"
		interrupted = append(interrupted, record)
	}
	readErr := rows.Err()
	closeErr := rows.Close()
	if readErr != nil {
		return readErr
	}
	if closeErr != nil {
		return closeErr
	}
	for _, record := range interrupted {
		if err := recordUsageTx(ctx, tx, record); err != nil {
			return fmt.Errorf("recover interrupted assistant usage: %w", err)
		}
	}
	return tx.Commit()
}

func (s *SQLiteStore) backfillUsage(ctx context.Context) error {
	// Store.List intentionally limits the session list to 200. Migration must
	// read every retained session, and release the reader before starting writes
	// because the main database can be configured with a single connection.
	rows, err := s.db.QueryContext(ctx, `SELECT id,value FROM assistant_records WHERE substr(id,1,8)='session/'`)
	if err != nil {
		return fmt.Errorf("read legacy assistant usage: %w", err)
	}
	var records []UsageRecord
	for rows.Next() {
		var key string
		var value []byte
		if err := rows.Scan(&key, &value); err != nil {
			rows.Close()
			return fmt.Errorf("read legacy assistant session: %w", err)
		}
		var session Session
		decoder := json.NewDecoder(bytes.NewReader(value))
		decoder.UseNumber()
		if err := decoder.Decode(&session); err != nil {
			continue
		}
		parts := strings.SplitN(key, "/", 3)
		if len(parts) == 3 {
			if session.UserID == "" {
				session.UserID = parts[1]
			}
			if session.ID == "" {
				session.ID = parts[2]
			}
		}
		for _, event := range session.Events {
			if event.SessionID == "" {
				event.SessionID = session.ID
			}
			record, ok := usageRecordFromEvent(event, "assistant")
			if !ok {
				continue
			}
			record.UserID = session.UserID
			// Old events did not all carry a timestamp. Session dates provide a
			// stable fallback; the current clock would misdate historical usage.
			validTimestamp := false
			for _, timestamp := range []string{record.Timestamp, session.UpdatedAt, session.CreatedAt} {
				if parsed, err := time.Parse(time.RFC3339Nano, timestamp); err == nil {
					record.Timestamp = parsed.UTC().Format(time.RFC3339Nano)
					validTimestamp = true
					break
				}
			}
			if validTimestamp {
				records = append(records, record)
			}
		}
	}
	readErr := rows.Err()
	closeErr := rows.Close()
	if readErr != nil {
		return fmt.Errorf("read legacy assistant usage: %w", readErr)
	}
	if closeErr != nil {
		return fmt.Errorf("close legacy assistant sessions: %w", closeErr)
	}
	if len(records) == 0 {
		return nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin assistant usage backfill: %w", err)
	}
	defer tx.Rollback()
	for _, record := range records {
		if err := recordUsageTx(ctx, tx, record); err != nil {
			return fmt.Errorf("backfill assistant usage: %w", err)
		}
	}
	return tx.Commit()
}

func (s *SQLiteStore) RecordUsage(ctx context.Context, record UsageRecord) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := recordUsageTx(ctx, tx, record); err != nil {
		return err
	}
	return tx.Commit()
}

func recordUsageTx(ctx context.Context, tx *sql.Tx, record UsageRecord) error {
	value, timestamp, err := usageStoreValue(record)
	if err != nil {
		return err
	}
	var previous []byte
	err = tx.QueryRowContext(ctx, `SELECT value FROM assistant_usage WHERE id=?`, record.ID).Scan(&previous)
	if errors.Is(err, sql.ErrNoRows) {
		_, err = tx.ExecContext(ctx, `INSERT OR IGNORE INTO assistant_usage(id,timestamp_seconds,timestamp_nanos,value) VALUES(?,?,?,?)`, record.ID, timestamp.Unix(), timestamp.Nanosecond(), value)
		return err
	}
	if err != nil {
		return err
	}
	var existing UsageRecord
	if err := json.Unmarshal(previous, &existing); err != nil {
		return err
	}
	merged, changed := mergeUsageRecord(existing, record)
	if !changed {
		return nil
	}
	value, _, err = usageStoreValue(merged)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `UPDATE assistant_usage SET value=? WHERE id=? AND json_extract(CAST(value AS TEXT),'$.status')='pending'`, value, record.ID)
	return err
}

// Only pending requests can transition, and they transition just once. Keep the
// original connection, timestamp and rates even if a later replay has new prices.
func mergeUsageRecord(existing, incoming UsageRecord) (UsageRecord, bool) {
	if existing.Status != UsagePending || !terminalUsageStatus(incoming.Status) || existing.RequestID != incoming.RequestID {
		return existing, false
	}
	merged := cloneUsageStoreRecord(existing)
	merged.Status = incoming.Status
	merged.FailureReason = incoming.FailureReason
	merged.CompletedAt = incoming.CompletedAt
	if merged.CompletedAt == "" {
		merged.CompletedAt = incoming.Timestamp
	}
	if incoming.InputTokens != nil {
		merged.InputTokens = incoming.InputTokens
	}
	if incoming.OutputTokens != nil {
		merged.OutputTokens = incoming.OutputTokens
	}
	if incoming.TotalTokens != nil {
		merged.TotalTokens = incoming.TotalTokens
	}
	if merged.TotalTokens == nil && merged.InputTokens != nil && merged.OutputTokens != nil && *merged.InputTokens <= math.MaxInt64-*merged.OutputTokens {
		total := *merged.InputTokens + *merged.OutputTokens
		merged.TotalTokens = &total
	}
	applyUsagePricing(&merged, Billing{InputPricePerMillion: existing.InputPricePerMillion, OutputPricePerMillion: existing.OutputPricePerMillion})
	return cloneUsageStoreRecord(merged), true
}

// ListUsage returns the half-open interval [from, to). Empty bounds are open.
func (s *SQLiteStore) ListUsage(ctx context.Context, from, to string) ([]UsageRecord, error) {
	return s.listUsage(ctx, from, to, 0)
}

func (s *SQLiteStore) ListUsageDetails(ctx context.Context, from, to string, limit int) ([]UsageRecord, error) {
	if limit < 1 || limit > 101 {
		return nil, errors.New("invalid assistant usage detail limit")
	}
	return s.listUsage(ctx, from, to, limit)
}

func (s *SQLiteStore) listUsage(ctx context.Context, from, to string, limit int) ([]UsageRecord, error) {
	lower, upper, err := usageStoreBounds(from, to)
	if err != nil {
		return nil, err
	}
	query := `SELECT value FROM assistant_usage WHERE 1=1`
	args := []any{}
	if from != "" {
		query += ` AND (timestamp_seconds,timestamp_nanos)>=(?,?)`
		args = append(args, lower.Unix(), lower.Nanosecond())
	}
	if to != "" {
		query += ` AND (timestamp_seconds,timestamp_nanos)<(?,?)`
		args = append(args, upper.Unix(), upper.Nanosecond())
	}
	if limit > 0 {
		query += ` ORDER BY timestamp_seconds DESC,timestamp_nanos DESC,id DESC LIMIT ?`
		args = append(args, limit)
	} else {
		query += ` ORDER BY timestamp_seconds,timestamp_nanos,id`
	}
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	records := []UsageRecord{}
	for rows.Next() {
		var value []byte
		if err := rows.Scan(&value); err != nil {
			return nil, err
		}
		var record UsageRecord
		if err := json.Unmarshal(value, &record); err != nil {
			return nil, fmt.Errorf("decode assistant usage: %w", err)
		}
		records = append(records, record)
	}
	return records, rows.Err()
}

func (s *MemoryStore) RecordUsage(ctx context.Context, record UsageRecord) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	_, timestamp, err := usageStoreValue(record)
	if err != nil {
		return err
	}
	record.Timestamp = timestamp.UTC().Format(time.RFC3339Nano)
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.usage == nil {
		s.usage = map[string]UsageRecord{}
	}
	if existing, exists := s.usage[record.ID]; !exists {
		s.usage[record.ID] = cloneUsageStoreRecord(record)
	} else if merged, changed := mergeUsageRecord(existing, record); changed {
		s.usage[record.ID] = merged
	}
	return nil
}

func (s *MemoryStore) ListUsage(ctx context.Context, from, to string) ([]UsageRecord, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	lower, upper, err := usageStoreBounds(from, to)
	if err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	records := []UsageRecord{}
	for _, record := range s.usage {
		timestamp, err := time.Parse(time.RFC3339Nano, record.Timestamp)
		if err != nil {
			return nil, fmt.Errorf("decode assistant usage timestamp: %w", err)
		}
		if from != "" && timestamp.Before(lower) || to != "" && !timestamp.Before(upper) {
			continue
		}
		records = append(records, cloneUsageStoreRecord(record))
	}
	sort.Slice(records, func(i, j int) bool {
		left, _ := time.Parse(time.RFC3339Nano, records[i].Timestamp)
		right, _ := time.Parse(time.RFC3339Nano, records[j].Timestamp)
		if left.Equal(right) {
			return records[i].ID < records[j].ID
		}
		return left.Before(right)
	})
	return records, nil
}

func (s *MemoryStore) ListUsageDetails(ctx context.Context, from, to string, limit int) ([]UsageRecord, error) {
	if limit < 1 || limit > 101 {
		return nil, errors.New("invalid assistant usage detail limit")
	}
	records, err := s.ListUsage(ctx, from, to)
	if err != nil {
		return nil, err
	}
	for left, right := 0, len(records)-1; left < right; left, right = left+1, right-1 {
		records[left], records[right] = records[right], records[left]
	}
	if len(records) > limit {
		records = records[:limit]
	}
	return records, nil
}

func usageStoreValue(record UsageRecord) ([]byte, time.Time, error) {
	if strings.TrimSpace(record.ID) == "" {
		return nil, time.Time{}, errors.New("assistant usage requires an ID")
	}
	timestamp, err := time.Parse(time.RFC3339Nano, record.Timestamp)
	if err != nil {
		return nil, time.Time{}, fmt.Errorf("invalid assistant usage timestamp: %w", err)
	}
	record.Timestamp = timestamp.UTC().Format(time.RFC3339Nano)
	value, err := json.Marshal(record)
	return value, timestamp, err
}

func usageStoreBounds(from, to string) (time.Time, time.Time, error) {
	var lower, upper time.Time
	var err error
	if from != "" {
		lower, err = time.Parse(time.RFC3339Nano, from)
		if err != nil {
			return lower, upper, fmt.Errorf("invalid assistant usage lower bound: %w", err)
		}
	}
	if to != "" {
		upper, err = time.Parse(time.RFC3339Nano, to)
		if err != nil {
			return lower, upper, fmt.Errorf("invalid assistant usage upper bound: %w", err)
		}
	}
	if from != "" && to != "" && upper.Before(lower) {
		return lower, upper, errors.New("assistant usage upper bound precedes lower bound")
	}
	return lower, upper, nil
}

func cloneUsageStoreRecord(record UsageRecord) UsageRecord {
	if record.InputTokens != nil {
		value := *record.InputTokens
		record.InputTokens = &value
	}
	if record.OutputTokens != nil {
		value := *record.OutputTokens
		record.OutputTokens = &value
	}
	if record.TotalTokens != nil {
		value := *record.TotalTokens
		record.TotalTokens = &value
	}
	if record.EstimatedCost != nil {
		value := *record.EstimatedCost
		record.EstimatedCost = &value
	}
	record.InputPricePerMillion = cloneUsagePrice(record.InputPricePerMillion)
	record.OutputPricePerMillion = cloneUsagePrice(record.OutputPricePerMillion)
	record.InputEstimatedCost = cloneUsagePrice(record.InputEstimatedCost)
	record.OutputEstimatedCost = cloneUsagePrice(record.OutputEstimatedCost)
	return record
}
