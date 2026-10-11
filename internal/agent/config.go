package agent

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"time"

	"github.com/google/uuid"
)

type Probe struct {
	ID              string `json:"id"`
	Kind            string `json:"kind"`
	Target          string `json:"target"`
	IntervalSeconds int    `json:"interval_seconds"`
	TimeoutMS       int    `json:"timeout_ms"`
	ExpectedStatus  []int  `json:"expected_status,omitempty"`
}

type Config struct {
	Listen                 string   `json:"listen"`
	Endpoint               string   `json:"endpoint"`
	Key                    string   `json:"key"`
	GroupID                string   `json:"group_id,omitempty"`
	LocalToken             string   `json:"local_token,omitempty"`
	DataDir                string   `json:"data_dir"`
	MaxBatchBytes          int64    `json:"max_batch_bytes"`
	MaxQueueBytes          int64    `json:"max_queue_bytes"`
	MaxQueueBatches        int      `json:"max_queue_batches"`
	MinFreeBytes           int64    `json:"min_free_bytes"`
	MaxReceipts            int      `json:"max_receipts"`
	MaxAgeSeconds          int      `json:"max_age_seconds"`
	ReceiptSeconds         int      `json:"receipt_seconds"`
	CollectIntervalSeconds int      `json:"collect_interval_seconds"`
	ControlIntervalSeconds int      `json:"control_interval_seconds"`
	ProcessNames           []string `json:"process_names,omitempty"`
	Probes                 []Probe  `json:"probes,omitempty"`
}

func DefaultConfig() Config {
	return Config{Listen: "127.0.0.1:4318", DataDir: "./agent-data", MaxBatchBytes: 4 << 20, MaxQueueBytes: 256 << 20, MaxQueueBatches: 10000, MinFreeBytes: 32 << 20, MaxReceipts: 100000, MaxAgeSeconds: 86400, ReceiptSeconds: 172800, CollectIntervalSeconds: 15, ControlIntervalSeconds: 30}
}

func LoadConfig(path string) (Config, error) {
	c := DefaultConfig()
	data, err := os.ReadFile(path)
	if err != nil {
		return c, err
	}
	if err = json.Unmarshal(data, &c); err != nil {
		return c, fmt.Errorf("config: %w", err)
	}
	return c, c.Validate()
}

func SaveConfig(path string, c Config) error {
	if err := c.Validate(); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	return atomicWrite(path, raw, 0600)
}

func (c Config) Validate() error {
	u, urlErr := url.Parse(c.Endpoint)
	if urlErr != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return errors.New("endpoint must be an http(s) URL")
	}
	if c.Key == "" {
		return errors.New("default key is required")
	}
	if len(c.GroupID) > 64 {
		return errors.New("invalid agent group")
	}
	host, _, err := net.SplitHostPort(c.Listen)
	if err != nil {
		return fmt.Errorf("listen: %w", err)
	}
	ip := net.ParseIP(host)
	if host != "localhost" && (ip == nil || !ip.IsLoopback()) && c.LocalToken == "" {
		return errors.New("non-loopback receiver requires local_token")
	}
	if c.DataDir == "" || c.MaxBatchBytes <= 0 || c.MaxQueueBytes < c.MaxBatchBytes || c.MaxQueueBatches <= 0 || c.MaxReceipts <= 0 || c.MinFreeBytes < 0 {
		return errors.New("invalid storage limits")
	}
	if c.MaxAgeSeconds <= 0 || c.ReceiptSeconds < c.MaxAgeSeconds || c.CollectIntervalSeconds < 1 || c.ControlIntervalSeconds < 1 {
		return errors.New("invalid age or interval configuration")
	}
	if len(c.ProcessNames) > 32 {
		return errors.New("at most 32 process matchers are allowed")
	}
	for _, pattern := range c.ProcessNames {
		if pattern == "" || len(pattern) > 128 {
			return errors.New("invalid process matcher")
		}
		if _, err := filepath.Match(pattern, ""); err != nil {
			return fmt.Errorf("process matcher: %w", err)
		}
	}
	return validateProbes(c.Probes)
}

type Identity struct {
	AgentID string `json:"agent_id"`
	HostID  string `json:"host_id"`
}

func loadIdentity(dir string) (Identity, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return Identity{}, err
	}
	path := filepath.Join(dir, "identity.json")
	data, err := os.ReadFile(path)
	if err == nil {
		var id Identity
		if e := json.Unmarshal(data, &id); e != nil {
			return id, e
		}
		if id.AgentID == "" || id.HostID == "" {
			return id, errors.New("invalid identity file")
		}
		return id, nil
	}
	if !os.IsNotExist(err) {
		return Identity{}, err
	}
	id := Identity{AgentID: uuid.NewString(), HostID: uuid.NewString()}
	data, _ = json.Marshal(id)
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return id, err
	}
	if _, err = f.Write(data); err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return id, err
	}
	if closeErr != nil {
		return id, closeErr
	}
	d, err := os.Open(dir)
	if err != nil {
		return id, err
	}
	defer d.Close()
	err = d.Sync()
	return id, err
}

func (c Config) maxAge() time.Duration { return time.Duration(c.MaxAgeSeconds) * time.Second }
