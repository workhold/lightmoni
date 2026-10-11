package agent

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	logcollector "go.opentelemetry.io/proto/otlp/collector/logs/v1"
	logpb "go.opentelemetry.io/proto/otlp/logs/v1"
	"google.golang.org/protobuf/proto"
)

func logTasks(dir string, beginning bool) RemoteConfig {
	on := true
	return NormalizeRemoteConfig(RemoteConfig{Revision: "logs-1", CollectIntervalSeconds: 15, LogsEnabled: &on, LogTable: "directory_logs", GroupID: "production", LogSources: []LogSource{{Directory: dir, Pattern: "*.log*", FromBeginning: beginning}}})
}
func appendLog(t *testing.T, path, body string) {
	t.Helper()
	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if _, err = file.WriteString(body); err != nil {
		t.Fatal(err)
	}
}
func writeLog(t *testing.T, path, body string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(body), 0600); err != nil {
		t.Fatal(err)
	}
}
func pollLogs(t *testing.T, r *fileLogReader, tasks RemoteConfig) {
	t.Helper()
	if err := r.poll(context.Background(), tasks); err != nil {
		t.Fatal(err)
	}
}
func drainLogs(t *testing.T, a *Agent) []*logpb.LogRecord {
	t.Helper()
	ctx := context.Background()
	var result []*logpb.LogRecord
	for {
		batch, ok, err := a.queue.Next(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if !ok {
			return result
		}
		if batch.Signal != "logs" || batch.Table != "directory_logs" {
			t.Fatalf("wrong destination: %+v", batch)
		}
		var request logcollector.ExportLogsServiceRequest
		if err = proto.Unmarshal(batch.Payload, &request); err != nil {
			t.Fatal(err)
		}
		resource := request.ResourceLogs[0].Resource
		if resourceString(resource, "host.id") != a.identity.HostID || resourceString(resource, "lightmoni.group_id") != "production" {
			t.Fatal("missing host/group identity")
		}
		for _, scope := range request.ResourceLogs[0].ScopeLogs {
			for _, record := range scope.LogRecords {
				if record.TimeUnixNano != 0 || record.ObservedTimeUnixNano == 0 || logAttribute(record, "event_time_source") != "observed" {
					t.Fatal("file collection pretended to know the original event time")
				}
			}
			result = append(result, scope.LogRecords...)
		}
		if err = a.queue.Complete(ctx, batch.ID); err != nil {
			t.Fatal(err)
		}
	}
}
func logBodies(records []*logpb.LogRecord) []string {
	result := []string{}
	for _, record := range records {
		result = append(result, record.Body.GetStringValue())
	}
	return result
}
func logAttribute(record *logpb.LogRecord, key string) string {
	for _, attr := range record.Attributes {
		if attr.Key == key {
			return attr.Value.GetStringValue()
		}
	}
	return ""
}

func TestDirectoryLogsIncrementalRestartAndNewFiles(t *testing.T) {
	cfg := testConfig(t)
	a, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "app.log")
	writeLog(t, path, "historical line\n")
	tasks := logTasks(dir, false)
	reader := newFileLogReader(a)
	pollLogs(t, reader, tasks)
	if len(drainLogs(t, a)) != 0 {
		t.Fatal("default collection replayed history")
	}
	appendLog(t, path, "new 中文\r\npartial")
	pollLogs(t, reader, tasks)
	if got := logBodies(drainLogs(t, a)); len(got) != 1 || got[0] != "new 中文" {
		t.Fatal(got)
	}
	reader.close()
	if err = a.Close(); err != nil {
		t.Fatal(err)
	}
	a, err = New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	reader = newFileLogReader(a)
	defer reader.close()
	appendLog(t, path, " completed\n")
	pollLogs(t, reader, tasks)
	if got := logBodies(drainLogs(t, a)); len(got) != 1 || got[0] != "partial completed" {
		t.Fatal(got)
	}
	writeLog(t, filepath.Join(dir, "new.log"), "created later\n")
	pollLogs(t, reader, tasks)
	if got := logBodies(drainLogs(t, a)); len(got) != 1 || got[0] != "created later" {
		t.Fatal(got)
	}
	pollLogs(t, reader, tasks)
	if len(drainLogs(t, a)) != 0 {
		t.Fatal("duplicate read")
	}
}

func TestDirectoryLogsRotationTruncationAndFilters(t *testing.T) {
	a := newTestAgent(t, testConfig(t))
	dir := t.TempDir()
	path := filepath.Join(dir, "app.log")
	writeLog(t, path, "original\n")
	tasks := logTasks(dir, true)
	tasks.LogSources[0].Pattern = "*.log"
	reader := newFileLogReader(a)
	defer reader.close()
	pollLogs(t, reader, tasks)
	first := drainLogs(t, a)
	source := logAttribute(first[0], "lightmoni.source_id")
	appendLog(t, path, "old unread\n")
	if err := os.Rename(path, path+".1"); err != nil {
		t.Fatal(err)
	}
	writeLog(t, path, "new file\n")
	writeLog(t, filepath.Join(dir, "ignored.txt"), "ignored\n")
	if err := os.Mkdir(filepath.Join(dir, "nested"), 0700); err != nil {
		t.Fatal(err)
	}
	writeLog(t, filepath.Join(dir, "nested", "child.log"), "nested\n")
	pollLogs(t, reader, tasks)
	got := strings.Join(logBodies(drainLogs(t, a)), "|")
	if !strings.Contains(got, "old unread") || !strings.Contains(got, "new file") || strings.Contains(got, "ignored") || strings.Contains(got, "nested") {
		t.Fatal(got)
	}
	writeLog(t, path, "rewritten after truncate and regrowth\n")
	pollLogs(t, reader, tasks)
	rewritten := drainLogs(t, a)
	if len(rewritten) != 1 || rewritten[0].Body.GetStringValue() != "rewritten after truncate and regrowth" || logAttribute(rewritten[0], "lightmoni.source_id") == source {
		t.Fatal(logBodies(rewritten))
	}
	tasks.LogSources[0].Recursive = true
	pollLogs(t, reader, tasks)
	if got := logBodies(drainLogs(t, a)); len(got) != 1 || got[0] != "nested" {
		t.Fatal(got)
	}
	off := false
	tasks.LogsEnabled = &off
	appendLog(t, path, "paused\n")
	pollLogs(t, reader, tasks)
	if len(drainLogs(t, a)) != 0 {
		t.Fatal("disabled collector ran")
	}
}

func TestDirectoryLogCheckpointCommitsWithQueueAndSurvivesCrash(t *testing.T) {
	cfg := testConfig(t)
	cfg.MaxQueueBatches = 1
	a, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "app.log")
	writeLog(t, path, "first\n")
	tasks := logTasks(dir, true)
	reader := newFileLogReader(a)
	pollLogs(t, reader, tasks)
	appendLog(t, path, "second\n")
	if err = reader.poll(context.Background(), tasks); err == nil {
		t.Fatal("full queue accepted logs")
	}
	var offset int64
	if err = a.queue.db.QueryRow("SELECT offset FROM log_cursors").Scan(&offset); err != nil || offset != 6 {
		t.Fatalf("advanced checkpoint without durable batch: %d %v", offset, err)
	}
	reader.close()
	a.Close()
	a, err = New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	reader = newFileLogReader(a)
	defer reader.close()
	if got := logBodies(drainLogs(t, a)); len(got) != 1 || got[0] != "first" {
		t.Fatal(got)
	}
	pollLogs(t, reader, tasks)
	if got := logBodies(drainLogs(t, a)); len(got) != 1 || got[0] != "second" {
		t.Fatal(got)
	}
	pollLogs(t, reader, tasks)
	if len(drainLogs(t, a)) != 0 {
		t.Fatal("committed offset replayed")
	}
}

func TestDirectoryLogsBoundedFragmentsAndRotationAfterRestart(t *testing.T) {
	cfg := testConfig(t)
	a, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "app.log")
	body := strings.Repeat("中文", 12000)
	writeLog(t, path, body+"\n")
	tasks := logTasks(dir, true)
	reader := newFileLogReader(a)
	pollLogs(t, reader, tasks)
	first := drainLogs(t, a)
	if len(first) != 1 {
		t.Fatal(len(first))
	}
	appendLog(t, path, "after rotation\n")
	reader.close()
	a.Close()
	if err = os.Rename(path, path+".1"); err != nil {
		t.Fatal(err)
	}
	writeLog(t, path, "fresh\n")
	a, err = New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	reader = newFileLogReader(a)
	defer reader.close()
	pollLogs(t, reader, tasks)
	rest := drainLogs(t, a)
	var remainder string
	fresh := false
	rotated := false
	for _, record := range rest {
		text := record.Body.GetStringValue()
		if text == "fresh" {
			fresh = true
		} else if text == "after rotation" {
			rotated = true
		} else {
			remainder += text
		}
	}
	if first[0].Body.GetStringValue()+remainder != body || !fresh || !rotated {
		t.Fatal("fragment/restart rotation lost content")
	}
}

func TestDirectoryLogConfigurationValidation(t *testing.T) {
	good := logTasks(t.TempDir(), false)
	if err := ValidateRemoteConfig(good); err != nil {
		t.Fatal(err)
	}
	for _, mutate := range []func(*RemoteConfig){
		func(c *RemoteConfig) { c.LogSources = nil }, func(c *RemoteConfig) { c.LogTable = "log_bad" },
		func(c *RemoteConfig) { c.LogSources[0].Directory = "relative" }, func(c *RemoteConfig) { c.LogSources[0].Pattern = "[" },
		func(c *RemoteConfig) { c.LogSources[0].Pattern = "nested/*.log" }, func(c *RemoteConfig) { c.LogSources = append(c.LogSources, c.LogSources[0]) },
	} {
		bad := NormalizeRemoteConfig(good)
		mutate(&bad)
		if ValidateRemoteConfig(bad) == nil {
			t.Fatal("invalid source accepted", bad)
		}
	}
}
