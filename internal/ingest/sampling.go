package ingest

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"

	moni "github.com/lightmoni/lightmoni/sdk/go"
)

var ErrInvalidSampling = moni.ErrInvalidSampling

type LogSamplingPolicy = moni.LogSamplingPolicy

func (c *Catalog) initSampling() error {
	_, err := c.DB.Exec(`CREATE TABLE IF NOT EXISTS log_sampling(logical_name TEXT PRIMARY KEY,policy_json TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1); CREATE TABLE IF NOT EXISTS sdk_reporting(id INTEGER PRIMARY KEY CHECK(id=1),disable_rules TEXT NOT NULL); INSERT OR IGNORE INTO sdk_reporting VALUES(1,'[]')`)
	return err
}

func (c *Catalog) SDKDisableRules(ctx context.Context) ([]moni.LogExcludeRule, error) {
	var raw string
	if err := c.DB.QueryRowContext(ctx, "SELECT disable_rules FROM sdk_reporting WHERE id=1").Scan(&raw); err != nil {
		return nil, err
	}
	var rules []moni.LogExcludeRule
	err := json.Unmarshal([]byte(raw), &rules)
	return rules, err
}
func (c *Catalog) SetSDKDisableRules(ctx context.Context, rules []moni.LogExcludeRule) error {
	if rules == nil {
		return fmt.Errorf("%w: disable_rules must be an array", ErrInvalidSampling)
	}
	if err := moni.ValidateExcludeRules(rules, true); err != nil {
		return err
	}
	raw, err := json.Marshal(rules)
	if err != nil || len(raw) > 64<<10 {
		return ErrInvalidSampling
	}
	_, err = c.DB.ExecContext(ctx, "UPDATE sdk_reporting SET disable_rules=? WHERE id=1", string(raw))
	return err
}

func (c *Catalog) samplingTable(ctx context.Context, id string) (string, error) {
	var logical, kind string
	if err := c.DB.QueryRowContext(ctx, "SELECT logical_name,kind FROM catalog WHERE id=?", id).Scan(&logical, &kind); err != nil {
		return "", err
	}
	if kind != "log" || SystemTable(logical) {
		return "", fmt.Errorf("%w: 仅业务日志表支持采样", ErrInvalidSampling)
	}
	return logical, nil
}

func (c *Catalog) TableLogSampling(ctx context.Context, id string) (LogSamplingPolicy, error) {
	logical, err := c.samplingTable(ctx, id)
	if err != nil {
		return LogSamplingPolicy{}, err
	}
	policy := moni.DefaultLogSampling()
	var raw string
	err = c.DB.QueryRowContext(ctx, "SELECT policy_json FROM log_sampling WHERE logical_name=?", logical).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return policy, nil
	}
	if err == nil {
		err = json.Unmarshal([]byte(raw), &policy)
	}
	return policy, err
}

func (c *Catalog) SetLogSampling(ctx context.Context, id string, policy LogSamplingPolicy) error {
	if err := policy.Validate(); err != nil {
		return err
	}
	logical, err := c.samplingTable(ctx, id)
	if err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	policies, err := c.LogSamplingPolicies(ctx)
	if err != nil {
		return err
	}
	policies[logical] = policy
	all, err := json.Marshal(policies)
	if err != nil || len(all) > 900<<10 {
		return fmt.Errorf("%w: 所有日志上报配置合计最多 900 KiB", ErrInvalidSampling)
	}
	_, err = c.DB.ExecContext(ctx, "INSERT INTO log_sampling(logical_name,policy_json) VALUES(?,?) ON CONFLICT(logical_name) DO UPDATE SET policy_json=excluded.policy_json,revision=revision+1", logical, jsonText(policy))
	return err
}

func (c *Catalog) LogSamplingPolicies(ctx context.Context) (map[string]LogSamplingPolicy, error) {
	rows, err := c.DB.QueryContext(ctx, "SELECT logical_name,policy_json FROM log_sampling ORDER BY logical_name")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	policies := map[string]LogSamplingPolicy{}
	for rows.Next() {
		var logical, raw string
		if err = rows.Scan(&logical, &raw); err != nil {
			return nil, err
		}
		var policy LogSamplingPolicy
		if err = json.Unmarshal([]byte(raw), &policy); err != nil {
			return nil, err
		}
		policies[logical] = policy
	}
	return policies, rows.Err()
}
