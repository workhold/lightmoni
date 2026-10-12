package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"time"

	"github.com/lightmoni/lightmoni/internal/agent"
)

func (s *Server) storeAgentEvents(ctx context.Context, id, key string, v map[string]any) error {
	raw, err := json.Marshal(v["runtime_events"])
	if err != nil {
		return err
	}
	var events []agent.RuntimeEvent
	if err = json.Unmarshal(raw, &events); err != nil {
		return fmt.Errorf("invalid runtime events")
	}
	if len(events) > 64 {
		return fmt.Errorf("too many runtime events")
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var pending int
	if err = tx.QueryRow("SELECT count(*) FROM agent_runtime_events").Scan(&pending); err != nil {
		return err
	}
	for _, event := range events {
		if event.ID == "" || len(event.ID) > 128 || len(event.Event) > 128 || len(event.Body) > 1024 || (event.Severity != "INFO" && event.Severity != "WARN" && event.Severity != "ERROR") || event.Time.After(time.Now().Add(5*time.Minute)) || event.Time.Before(time.Now().Add(-7*24*time.Hour)) {
			return fmt.Errorf("invalid runtime event")
		}
		payload, _ := json.Marshal(event)
		var exists int
		err = tx.QueryRow("SELECT count(*) FROM agent_runtime_events WHERE agent_id=? AND event_id=?", id, event.ID).Scan(&exists)
		if err != nil {
			return err
		}
		if exists == 0 {
			if pending >= 10000 {
				return fmt.Errorf("runtime event buffer full")
			}
			pending++
		}
		if _, err = tx.Exec("INSERT OR IGNORE INTO agent_runtime_events(agent_id,event_id,key_id,payload) VALUES(?,?,?,?)", id, event.ID, key, string(payload)); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func runtimeRow(id, host, key, group string, at time.Time, identity string) map[string]any {
	hash := sha256.Sum256([]byte(identity))
	stamp := at.UTC().Format("2006-01-02 15:04:05.000000000")
	resource, _ := json.Marshal(map[string]string{"service.name": "lightmoni-agent", "service.instance.id": id, "host.id": host, "lightmoni.agent_id": id})
	attrs := map[string]string{"lightmoni.component": "agent", "group_id": group}
	encoded, _ := json.Marshal(attrs)
	return map[string]any{"event_id": hex.EncodeToString(hash[:]), "event_time": stamp, "ingested_at": time.Now().UTC().Format("2006-01-02 15:04:05.000000000"), "service": "lightmoni-agent", "instance_id": id, "host_id": host, "agent_id": id, "key_id": key, "resource_json": string(resource), "attributes": attrs, "attributes_json": string(encoded)}
}
func runtimeNumber(v any) float64 {
	n, _ := v.(float64)
	if math.IsNaN(n) || math.IsInf(n, 0) || n < 0 {
		return 0
	}
	return n
}

// RunAgentTelemetry converts control-plane heartbeats to normal queryable
// telemetry. Diagnostics are retained in SQLite until ClickHouse acknowledges
// them; a telemetry storage outage does not stop configuration polling.
func (s *Server) RunAgentTelemetry(ctx context.Context) {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	sent := map[string]string{}
	for {
		if err := s.publishAgentTelemetry(ctx, sent); err != nil && ctx.Err() == nil {
			slog.Warn("Agent runtime telemetry export failed", "error", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
func (s *Server) publishAgentTelemetry(ctx context.Context, sent map[string]string) error {
	for _, kind := range []string{"metric", "log"} {
		subtype := ""
		if kind == "metric" {
			subtype = "gauge"
		}
		if _, err := s.Catalog.Ensure(ctx, kind, "lightmoni_agent", subtype, "lightmoni-agent"); err != nil {
			return err
		}
	}
	rows, err := s.DB.QueryContext(ctx, "SELECT id,host_id,last_seen,heartbeat,group_id FROM agents")
	if err != nil {
		return err
	}
	type snapshot struct{ id, host, seen, raw, group string }
	var snapshots []snapshot
	for rows.Next() {
		var v snapshot
		if err = rows.Scan(&v.id, &v.host, &v.seen, &v.raw, &v.group); err != nil {
			rows.Close()
			return err
		}
		snapshots = append(snapshots, v)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, v := range snapshots {
		signature := v.seen + "/" + v.group
		if sent[v.id] == signature {
			continue
		}
		at, err := time.Parse(time.RFC3339Nano, v.seen)
		if err != nil {
			continue
		}
		var status map[string]any
		if json.Unmarshal([]byte(v.raw), &status) != nil {
			continue
		}
		values := map[string]float64{"heartbeat": 1, "queue_batches": runtimeNumber(status["queue_batches"]), "queue_bytes": runtimeNumber(status["queue_bytes"]), "quarantine_batches": runtimeNumber(status["quarantine_batches"]), "oldest_age_seconds": runtimeNumber(status["oldest_age_seconds"])}
		values["collector_errors"] = 0
		if collectors, ok := status["collectors_status"].(map[string]any); ok {
			for _, state := range collectors {
				if state != "ok" && state != "disabled" {
					values["collector_errors"]++
				}
			}
		}
		var metrics []map[string]any
		for name, value := range values {
			row := runtimeRow(v.id, v.host, fmt.Sprint(status["runtime_key_id"]), v.group, at, v.id+signature+name)
			row["name"] = "lightmoni.agent." + name
			row["unit"] = ""
			row["start_time"] = row["event_time"]
			row["value"] = value
			row["value_type"] = "double"
			row["value_int"] = nil
			row["value_float"] = value
			attrs := row["attributes"].(map[string]string)
			attrs["heartbeat_timeout_seconds"] = fmt.Sprint(math.Max(90, 3*runtimeNumber(status["control_interval_seconds"])))
			encoded, _ := json.Marshal(attrs)
			row["attributes_json"] = string(encoded)
			metrics = append(metrics, row)
		}
		if err = s.Catalog.CH.Insert(ctx, "_lm_metric_lightmoni_agent_gauge", metrics); err != nil {
			return err
		}
		sent[v.id] = signature
	}
	events, err := s.DB.QueryContext(ctx, "SELECT e.agent_id,e.event_id,e.key_id,e.payload,COALESCE(a.host_id,''),COALESCE(a.group_id,'default') FROM agent_runtime_events e LEFT JOIN agents a ON a.id=e.agent_id ORDER BY e.rowid LIMIT 256")
	if err != nil {
		return err
	}
	type pending struct{ id, event, key, raw, host, group string }
	var batch []pending
	for events.Next() {
		var v pending
		if err = events.Scan(&v.id, &v.event, &v.key, &v.raw, &v.host, &v.group); err != nil {
			events.Close()
			return err
		}
		batch = append(batch, v)
	}
	err = events.Err()
	events.Close()
	if err != nil {
		return err
	}
	for _, v := range batch {
		var event agent.RuntimeEvent
		if json.Unmarshal([]byte(v.raw), &event) != nil {
			return fmt.Errorf("invalid persisted runtime event")
		}
		row := runtimeRow(v.id, v.host, v.key, v.group, event.Time, v.id+"/"+event.ID)
		row["severity"] = event.Severity
		row["severity_number"] = map[string]int{"INFO": 9, "WARN": 13, "ERROR": 17}[event.Severity]
		row["body"] = event.Body
		body, _ := json.Marshal(event.Body)
		row["body_json"] = string(body)
		row["source_id"] = v.id
		row["source_seq"] = nil
		row["trace_id"] = ""
		row["span_id"] = ""
		attrs := row["attributes"].(map[string]string)
		attrs["event"] = event.Event
		encoded, _ := json.Marshal(attrs)
		row["attributes_json"] = string(encoded)
		if err = s.Catalog.CH.Insert(ctx, "_lm_log_lightmoni_agent", []map[string]any{row}); err != nil {
			return err
		}
		if _, err = s.DB.ExecContext(ctx, "DELETE FROM agent_runtime_events WHERE agent_id=? AND event_id=?", v.id, v.event); err != nil {
			return err
		}
	}
	return nil
}
