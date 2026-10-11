package alerts

import (
	"database/sql"
	"time"
)

func normalizeQueueTimes(db *sql.DB) error {
	rows, e := db.Query("SELECT id,next_attempt,created_at FROM alert_outbox WHERE next_attempt<>''")
	if e != nil {
		return e
	}
	type item struct{ id, next, created string }
	updates := []item{}
	for rows.Next() {
		var v item
		if e = rows.Scan(&v.id, &v.next, &v.created); e != nil {
			rows.Close()
			return e
		}
		next, err := time.Parse(time.RFC3339Nano, v.next)
		if err != nil {
			continue
		}
		created, err := time.Parse(time.RFC3339Nano, v.created)
		if err != nil {
			continue
		}
		if v.next != stamp(next) || v.created != stamp(created) {
			v.next = stamp(next)
			v.created = stamp(created)
			updates = append(updates, v)
		}
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return e
	}
	if len(updates) == 0 {
		return nil
	}
	tx, e := db.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	for _, v := range updates {
		if _, e = tx.Exec("UPDATE alert_outbox SET next_attempt=?,created_at=? WHERE id=?", v.next, v.created, v.id); e != nil {
			return e
		}
	}
	return tx.Commit()
}
