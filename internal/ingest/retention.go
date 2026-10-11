package ingest

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/lightmoni/lightmoni/internal/shared"
)

var ErrInvalidRetention = errors.New("保留时长必须为 0 到 36500 的整数天数，0 表示永久保留")

func (c *Catalog) initRetention() error {
	tx, err := c.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.Exec("CREATE TABLE IF NOT EXISTS retention_config(id INTEGER PRIMARY KEY CHECK(id=1),default_days INTEGER NOT NULL); INSERT OR IGNORE INTO retention_config(id,default_days) VALUES(1,7)"); err != nil {
		return err
	}
	var exists int
	if err = tx.QueryRow("SELECT count(*) FROM pragma_table_info('catalog') WHERE name='retention_days'").Scan(&exists); err != nil {
		return err
	}
	if exists == 0 {
		if _, err = tx.Exec("ALTER TABLE catalog ADD COLUMN retention_days INTEGER; UPDATE catalog SET retention_days=30 WHERE kind='metric'"); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (c *Catalog) DefaultRetention(ctx context.Context) (int, error) {
	var days int
	err := c.DB.QueryRowContext(ctx, "SELECT default_days FROM retention_config WHERE id=1").Scan(&days)
	return days, err
}

func validRetention(days int) error {
	if days < 0 || days > 36500 {
		return ErrInvalidRetention
	}
	return nil
}

func (c *Catalog) applyRetention(ctx context.Context, table shared.Table, days int) error {
	expected := table.Kind + "_" + table.LogicalName
	if table.Kind == "metric" {
		expected += "_" + table.MetricType
	}
	if !ValidTable(table.LogicalName) || table.Name != expected || (table.Kind != "log" && table.Kind != "metric" && table.Kind != "trace") || (table.Kind == "metric" && table.MetricType != "gauge" && table.MetricType != "sum" && table.MetricType != "histogram") {
		return errors.New("invalid retention table")
	}
	query := "ALTER TABLE _lm_" + table.Name + " REMOVE TTL"
	if days > 0 {
		query = fmt.Sprintf("ALTER TABLE _lm_%s MODIFY TTL event_time + INTERVAL %d DAY", table.Name, days)
	}
	return c.CH.Exec(ctx, query)
}

// ClickHouse DDL cannot join the SQLite transaction. Apply it first and
// compensate all attempted tables on failure, including an ambiguous HTTP ack.
func (c *Catalog) restoreRetention(tables []shared.Table, cause error) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	for _, table := range tables {
		if err := c.applyRetention(ctx, table, table.EffectiveRetentionDays); err != nil {
			cause = errors.Join(cause, fmt.Errorf("恢复 %s 的保留规则失败：%w", table.Name, err))
		}
	}
	return cause
}

func (c *Catalog) SetDefaultRetention(ctx context.Context, days int) error {
	if err := validRetention(days); err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	current, err := c.DefaultRetention(ctx)
	if err != nil || current == days {
		return err
	}
	tables, err := c.List(ctx)
	if err != nil {
		return err
	}
	attempted := []shared.Table{}
	for _, table := range tables {
		if table.RetentionDays != nil {
			continue
		}
		attempted = append(attempted, table)
		if err = c.applyRetention(ctx, table, days); err != nil {
			return c.restoreRetention(attempted, err)
		}
	}
	if _, err = c.DB.ExecContext(ctx, "UPDATE retention_config SET default_days=? WHERE id=1", days); err != nil {
		return c.restoreRetention(attempted, err)
	}
	return nil
}

// nil inherits the global default; zero keeps data indefinitely.
func (c *Catalog) SetTableRetention(ctx context.Context, id string, days *int) error {
	if days != nil {
		if err := validRetention(*days); err != nil {
			return err
		}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	tables, err := c.List(ctx)
	if err != nil {
		return err
	}
	for _, table := range tables {
		if table.ID != id {
			continue
		}
		effective, err := c.DefaultRetention(ctx)
		if err != nil {
			return err
		}
		if days != nil {
			effective = *days
		}
		if effective != table.EffectiveRetentionDays {
			if err = c.applyRetention(ctx, table, effective); err != nil {
				return c.restoreRetention([]shared.Table{table}, err)
			}
		}
		if _, err = c.DB.ExecContext(ctx, "UPDATE catalog SET retention_days=? WHERE id=?", days, id); err != nil {
			return c.restoreRetention([]shared.Table{table}, err)
		}
		return nil
	}
	return sql.ErrNoRows
}
