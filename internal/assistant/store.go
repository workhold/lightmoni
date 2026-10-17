package assistant

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"sync"
)

type SQLiteStore struct{ db *sql.DB }

func NewSQLiteStore(db *sql.DB) (*SQLiteStore, error) {
	if db == nil {
		return nil, errors.New("assistant requires the main SQLite database")
	}
	_, err := db.Exec(`CREATE TABLE IF NOT EXISTS assistant_records (id TEXT PRIMARY KEY, value BLOB NOT NULL)`)
	if err != nil {
		return nil, err
	}
	store := &SQLiteStore{db: db}
	if err := store.initUsageStore(context.Background()); err != nil {
		return nil, err
	}
	return store, nil
}

func (s *SQLiteStore) Get(ctx context.Context, id string) ([]byte, error) {
	var value []byte
	err := s.db.QueryRowContext(ctx, `SELECT value FROM assistant_records WHERE id=?`, id).Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return value, err
}

func (s *SQLiteStore) Put(ctx context.Context, id string, value []byte) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO assistant_records(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value`, id, value)
	return err
}

func (s *SQLiteStore) List(ctx context.Context, prefix string) (map[string][]byte, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id,value FROM assistant_records WHERE substr(id,1,?)=? ORDER BY COALESCE(json_extract(CAST(value AS TEXT),'$.updated_at'),'') DESC,id LIMIT 200`, len(prefix), prefix)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := map[string][]byte{}
	for rows.Next() {
		var id string
		var value []byte
		if err := rows.Scan(&id, &value); err != nil {
			return nil, err
		}
		result[id] = value
	}
	return result, rows.Err()
}

// MemoryStore is intentionally not used by New. It isolates protocol tests.
type MemoryStore struct {
	mu    sync.RWMutex
	data  map[string][]byte
	usage map[string]UsageRecord
}

func NewMemoryStore() *MemoryStore {
	return &MemoryStore{data: map[string][]byte{}, usage: map[string]UsageRecord{}}
}
func (s *MemoryStore) Get(_ context.Context, id string) ([]byte, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	b, ok := s.data[id]
	if !ok {
		return nil, ErrNotFound
	}
	return append([]byte(nil), b...), nil
}
func (s *MemoryStore) Put(_ context.Context, id string, b []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.data == nil {
		s.data = map[string][]byte{}
	}
	s.data[id] = append([]byte(nil), b...)
	return nil
}
func (s *MemoryStore) List(_ context.Context, prefix string) (map[string][]byte, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	result := map[string][]byte{}
	for id, b := range s.data {
		if strings.HasPrefix(id, prefix) {
			result[id] = append([]byte(nil), b...)
		}
	}
	return result, nil
}
