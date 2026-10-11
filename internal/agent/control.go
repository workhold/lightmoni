package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/lightmoni/lightmoni/internal/shared"
)

type RemoteConfig struct {
	Revision               string      `json:"revision"`
	CollectIntervalSeconds int         `json:"collect_interval_seconds"`
	Probes                 []Probe     `json:"probes"`
	HostEnabled            *bool       `json:"host_enabled"`
	HostCollectors         []string    `json:"host_collectors"`
	HostTable              string      `json:"host_table"`
	ProbeTable             string      `json:"probe_table"`
	ProcessNames           []string    `json:"process_names"`
	GroupID                string      `json:"group_id,omitempty"`
	LogsEnabled            *bool       `json:"logs_enabled"`
	LogTable               string      `json:"log_table"`
	LogSources             []LogSource `json:"log_sources"`
}

type LogSource struct {
	Directory     string `json:"directory"`
	Pattern       string `json:"pattern"`
	Recursive     bool   `json:"recursive"`
	FromBeginning bool   `json:"from_beginning"`
}

func NormalizeRemoteConfig(c RemoteConfig) RemoteConfig {
	if c.LogsEnabled == nil {
		enabled := false
		c.LogsEnabled = &enabled
	}
	if c.LogTable == "" {
		c.LogTable = "files"
	}
	if c.LogSources == nil {
		c.LogSources = []LogSource{}
	}
	// Copy before normalizing so readers of the previous task snapshot stay immutable.
	c.LogSources = append([]LogSource{}, c.LogSources...)
	for i := range c.LogSources {
		c.LogSources[i].Directory = strings.TrimSpace(c.LogSources[i].Directory)
		if c.LogSources[i].Pattern == "" {
			c.LogSources[i].Pattern = "*.log*"
		}
	}
	if c.HostEnabled == nil {
		enabled := true
		c.HostEnabled = &enabled
	}
	if c.HostCollectors == nil {
		c.HostCollectors = []string{"cpu", "memory", "filesystem", "disk", "network", "system"}
		if len(c.ProcessNames) > 0 {
			c.HostCollectors = append(c.HostCollectors, "process")
		}
	}
	if c.HostTable == "" {
		c.HostTable = "host"
	}
	if c.ProbeTable == "" {
		c.ProbeTable = "probe"
	}
	if c.Probes == nil {
		c.Probes = []Probe{}
	}
	if c.ProcessNames == nil {
		c.ProcessNames = []string{}
	}
	return c
}

func (a *Agent) taskConfig() RemoteConfig {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.tasks
}

func (a *Agent) controlRequest(ctx context.Context, method, path string, body any) ([]byte, error) {
	var encoded []byte
	var err error
	if body != nil {
		encoded, err = json.Marshal(body)
		if err != nil {
			return nil, err
		}
	}
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(a.cfg.Endpoint, "/")+path, bytes.NewReader(encoded))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+a.cfg.Key)
	req.Header.Set("Content-Type", "application/json")
	response, err := a.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("control endpoint unreachable")
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotModified {
		return nil, nil
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	if response.StatusCode < 200 || response.StatusCode > 299 {
		return nil, fmt.Errorf("control HTTP %d", response.StatusCode)
	}
	return data, nil
}

func (a *Agent) applyRemote(c RemoteConfig, persist bool) error {
	c = NormalizeRemoteConfig(c)
	if err := ValidateRemoteConfig(c); err != nil {
		return err
	}
	if persist {
		data, err := json.Marshal(c)
		if err != nil {
			return err
		}
		if err = atomicWrite(filepath.Join(a.cfg.DataDir, "remote-config.json"), data, 0600); err != nil {
			return err
		}
	}
	a.mu.Lock()
	a.revision = c.Revision
	a.collectInterval = c.CollectIntervalSeconds
	a.probes = append([]Probe(nil), c.Probes...)
	a.tasks = c
	a.collectors = map[string]string{}
	a.mu.Unlock()
	if a.tasksReady != nil {
		a.tasksReadyOnce.Do(func() { close(a.tasksReady) })
	}
	select {
	case a.tasksChanged <- struct{}{}:
	default:
	}
	return nil
}

func ValidateRemoteConfig(c RemoteConfig) error {
	c = NormalizeRemoteConfig(c)
	if c.Revision == "" || c.CollectIntervalSeconds < 1 || c.CollectIntervalSeconds > 86400 {
		return fmt.Errorf("invalid remote configuration revision or interval")
	}
	if err := validateProbes(c.Probes); err != nil {
		return err
	}
	if !shared.ValidLogicalTable(c.HostTable) || !shared.ValidLogicalTable(c.ProbeTable) || !shared.ValidLogicalTable(c.LogTable) {
		return fmt.Errorf("上报表名必须是合法的逻辑 table，不带 log_/metric_/trace_ 前缀")
	}
	if *c.HostEnabled && len(c.HostCollectors) == 0 {
		return fmt.Errorf("开启机器指标后至少选择一项采集数据")
	}
	seen := map[string]bool{}
	for _, collector := range c.HostCollectors {
		switch collector {
		case "cpu", "memory", "filesystem", "disk", "network", "system", "process":
		default:
			return fmt.Errorf("未知的机器采集项：%s", collector)
		}
		if seen[collector] {
			return fmt.Errorf("机器采集项不能重复")
		}
		seen[collector] = true
	}
	if len(c.ProcessNames) > 32 {
		return fmt.Errorf("最多配置 32 个进程名称")
	}
	for _, pattern := range c.ProcessNames {
		if pattern == "" || len(pattern) > 128 {
			return fmt.Errorf("进程名称无效")
		}
		if _, err := filepath.Match(pattern, "process"); err != nil {
			return fmt.Errorf("进程名称匹配规则无效")
		}
	}
	if *c.HostEnabled && seen["process"] && len(c.ProcessNames) == 0 {
		return fmt.Errorf("采集指定进程时请填写进程名称")
	}
	if len(c.LogSources) > 32 {
		return fmt.Errorf("最多配置 32 个日志目录")
	}
	if *c.LogsEnabled && len(c.LogSources) == 0 {
		return fmt.Errorf("开启目录日志后至少配置一个日志目录")
	}
	sources := map[string]bool{}
	for _, source := range c.LogSources {
		if !filepath.IsAbs(source.Directory) || len(source.Directory) > 4096 {
			return fmt.Errorf("日志目录必须填写绝对路径")
		}
		if len(source.Pattern) > 256 || strings.ContainsAny(source.Pattern, "/\\") {
			return fmt.Errorf("日志文件规则只能匹配文件名")
		}
		if _, err := filepath.Match(source.Pattern, "app.log"); err != nil {
			return fmt.Errorf("日志文件匹配规则无效")
		}
		key := logSourceID(source)
		if sources[key] {
			return fmt.Errorf("日志目录和匹配规则不能重复")
		}
		sources[key] = true
	}
	return nil
}

func (a *Agent) controlLoop(ctx context.Context) {
	path := filepath.Join(a.cfg.DataDir, "remote-config.json")
	if data, err := os.ReadFile(path); err == nil {
		var c RemoteConfig
		if err = json.Unmarshal(data, &c); err == nil {
			err = a.applyRemote(c, false)
		}
		if err != nil {
			a.setError("cached configuration invalid")
		}
	}
	ticker := time.NewTicker(time.Duration(a.cfg.ControlIntervalSeconds) * time.Second)
	defer ticker.Stop()
	registered := false
	for {
		status, err := a.Status(ctx)
		if err == nil && !registered {
			_, err = a.controlRequest(ctx, http.MethodPost, "/api/v1/agents/register", status)
			registered = err == nil
		}
		if err == nil && registered {
			_, err = a.controlRequest(ctx, http.MethodPost, "/api/v1/agents/"+a.ID()+"/heartbeat", status)
			if err == nil {
				var data []byte
				data, err = a.controlRequest(ctx, http.MethodGet, "/api/v1/agents/"+a.ID()+"/config", nil)
				if err == nil && len(data) > 0 {
					var c RemoteConfig
					err = json.Unmarshal(data, &c)
					if err == nil {
						a.mu.RLock()
						changed := a.revision != c.Revision || a.tasks.GroupID != c.GroupID
						a.mu.RUnlock()
						if changed {
							err = a.applyRemote(c, true)
						}
					}
				}
			}
		}
		if err != nil && ctx.Err() == nil {
			a.setError("control: " + err.Error())
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (a *Agent) waitForTasks(ctx context.Context) bool {
	select {
	case <-a.tasksReady:
		return true
	case <-ctx.Done():
		return false
	}
}

func atomicWrite(path string, data []byte, mode os.FileMode) error {
	f, err := os.CreateTemp(filepath.Dir(path), ".lightmoni-tmp-")
	if err != nil {
		return err
	}
	name := f.Name()
	defer os.Remove(name)
	if err = f.Chmod(mode); err == nil {
		_, err = f.Write(data)
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err = os.Rename(name, path); err != nil {
		return err
	}
	d, err := os.Open(filepath.Dir(path))
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}
