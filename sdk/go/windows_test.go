package moni

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

func TestAlignedMetricWindowPolicies(t *testing.T) {
	at := time.Date(2026, 10, 19, 12, 0, 17, 999000000, time.UTC)
	for _, seconds := range []int64{10, 30, 60, 300, 600, 1800, 3600} {
		policies := map[string][]MetricWindow{"app": {{Seconds: seconds, EffectiveAt: 0}}}
		if err := validMetricWindows(policies); err != nil {
			t.Fatal(err)
		}
		start, p := metricWindowAt(policies, "app", at)
		if p != seconds || start.Unix()%seconds != 0 || start.After(at) || !at.Before(start.Add(time.Duration(seconds)*time.Second)) {
			t.Fatal("unaligned window", start, p)
		}
	}
	if validMetricWindows(map[string][]MetricWindow{"app": {{Seconds: 20}}}) == nil {
		t.Fatal("invalid period accepted")
	}
}

func TestMetricWindowsChooseOneCurrentPeriodPerTable(t *testing.T) {
	policies := map[string][]MetricWindow{"fast": {{Seconds: 10}, {Seconds: 60, EffectiveAt: 1800000000}}, "slow": {{Seconds: 300}}}
	for _, c := range []struct {
		table    string
		at, want int64
	}{{"fast", 1799999999, 10}, {"fast", 1800000000, 60}, {"slow", 1800000000, 300}, {"default", 1800000000, 30}} {
		_, seconds := metricWindowAt(policies, c.table, time.Unix(c.at, 0))
		if seconds != c.want {
			t.Fatalf("%s: got %d, want %d", c.table, seconds, c.want)
		}
	}
}

func TestRemoteMetricWindowsDriveExportedPeriodsAndKeepValidSnapshot(t *testing.T) {
	var mu sync.Mutex
	raw := `{"revision":"windows","log_sampling":{},"disable_rules":[],"metric_windows":{`
	periods := []int64{10, 30, 60, 300, 600, 1800, 3600}
	for i, seconds := range periods {
		if i > 0 {
			raw += ","
		}
		raw += fmt.Sprintf(`"table_%d":[{"seconds":%d,"effective_at":0}]`, seconds, seconds)
	}
	raw += "}}"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.String() != "/v1/sdk-config" || r.Header.Get("Authorization") != "Bearer windows" {
			t.Error("invalid config negotiation")
		}
		mu.Lock()
		defer mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, raw)
	}))
	defer server.Close()
	sink := &recorder{}
	client, err := New(Config{Service: "periods", Env: "test", Exporter: sink, ConfigEndpoint: server.URL, ConfigKey: "windows", ConfigInterval: time.Hour, Interval: time.Hour, DisableSelfTelemetry: true})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Shutdown(context.Background())
	if err := client.RefreshConfig(context.Background()); err != nil {
		t.Fatal(err)
	}
	for _, seconds := range periods {
		client.Record(fmt.Sprintf("table_%d", seconds), fmt.Sprintf("duration_%d", seconds), nil, 10, 1)
	}
	mu.Lock()
	raw = `{"revision":"invalid","log_sampling":{},"disable_rules":[],"metric_windows":{"table_10":[{"seconds":20,"effective_at":0}]}}`
	mu.Unlock()
	if err := client.RefreshConfig(context.Background()); err == nil {
		t.Fatal("invalid update accepted")
	}
	client.Record("table_10", "duration_10", nil, 20, 1)
	client.Record("default_table", "duration_30", nil, 30, 1)
	flush(t, client)
	samples := uint64(0)
	for name, metrics := range decodedMetrics(t, sink.snapshot()) {
		var expected int64
		if _, err := fmt.Sscanf(name, "duration_%d", &expected); err != nil {
			t.Fatal(err)
		}
		for _, metric := range metrics {
			for _, point := range metric.GetExponentialHistogram().GetDataPoints() {
				found := false
				for _, attr := range point.Attributes {
					if attr.Key == "lightmoni.window_seconds" {
						found = attr.Value.GetIntValue() == expected
					}
				}
				if !found || point.StartTimeUnixNano%(uint64(expected)*1000000000) != 0 {
					t.Fatal("invalid exported period", name)
				}
				samples += point.Count
			}
		}
	}
	if samples != 9 || client.Stats().InvalidRecords != 0 {
		t.Fatal("samples lost or counted twice", samples, client.Stats())
	}
}
