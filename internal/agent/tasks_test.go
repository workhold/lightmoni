package agent

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	metriccollector "go.opentelemetry.io/proto/otlp/collector/metrics/v1"
	"google.golang.org/protobuf/proto"
)

func queuedMetricNames(t *testing.T, a *Agent, table string) map[string]bool {
	t.Helper()
	rows, err := a.queue.db.Query("SELECT table_name,payload FROM batches WHERE signal='metrics'")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	names := map[string]bool{}
	for rows.Next() {
		var target string
		var body []byte
		rows.Scan(&target, &body)
		if target != table {
			t.Fatalf("metrics reached unexpected table %s", target)
		}
		var request metriccollector.ExportMetricsServiceRequest
		if err = proto.Unmarshal(body, &request); err != nil {
			t.Fatal(err)
		}
		for _, resource := range request.ResourceMetrics {
			for _, scope := range resource.ScopeMetrics {
				for _, metric := range scope.Metrics {
					names[metric.Name] = true
				}
			}
		}
	}
	return names
}

func TestGroupHostTasksUseSelectedCollectorsAndDestination(t *testing.T) {
	a := newTestAgent(t, testConfig(t))
	tasks := NormalizeRemoteConfig(RemoteConfig{Revision: "memory-only", CollectIntervalSeconds: 15, HostTable: "custom_host", HostCollectors: []string{"memory"}})
	if err := a.applyRemote(tasks, true); err != nil {
		t.Fatal(err)
	}
	if err := a.CollectOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	names := queuedMetricNames(t, a, "custom_host")
	if !names["host.memory.total"] || names["host.load.average"] || names["host.cpu.utilization"] || names["host.uptime"] {
		t.Fatal(names)
	}
	a.queue.db.Exec("DELETE FROM batches")
	off := false
	tasks.HostEnabled = &off
	tasks.Revision = "off"
	if err := a.applyRemote(tasks, true); err != nil {
		t.Fatal(err)
	}
	if err := a.CollectOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(queuedMetricNames(t, a, "custom_host")) != 0 {
		t.Fatal("disabled host collection emitted metrics")
	}
}

func TestProbesWaitForGroupTasksAndUseResultTable(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }))
	defer server.Close()
	a := newTestAgent(t, testConfig(t))
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); a.probeLoop(ctx) }()
	defer func() { cancel(); <-done }()
	// Before receiving a group configuration the loops cannot emit default-table data.
	if ready := a.waitForTasksWithCanceledContextForTest(); ready {
		t.Fatal("tasks ready before enrollment")
	}
	tasks := NormalizeRemoteConfig(RemoteConfig{Revision: "check-group", CollectIntervalSeconds: 15, ProbeTable: "custom_checks", Probes: []Probe{{ID: "homepage", Kind: "http", Target: server.URL, IntervalSeconds: 86400, TimeoutMS: 1000, ExpectedStatus: []int{204}}}})
	if err := a.applyRemote(tasks, true); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		if err := a.moni.Flush(context.Background()); err != nil {
			return false
		}
		names := queuedMetricNames(t, a, "custom_checks")
		return names["probe.success"] && names["probe.duration"]
	})
	a.queue.db.Exec("DELETE FROM batches")
	tasks.Revision = "new-group"
	tasks.ProbeTable = "custom_checks_new"
	if err := a.applyRemote(tasks, true); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		if err := a.moni.Flush(context.Background()); err != nil {
			return false
		}
		return queuedMetricNames(t, a, "custom_checks_new")["probe.success"]
	})
}

func (a *Agent) waitForTasksWithCanceledContextForTest() bool {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	return a.waitForTasks(ctx)
}
