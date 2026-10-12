package ingest

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"github.com/lightmoni/lightmoni/internal/shared"
	moni "github.com/lightmoni/lightmoni/sdk/go"
	"strings"
	"time"
)

func SystemTable(table string) bool { return shared.SystemLogicalTable(table) }

// SDK diagnostics keep the business route for authentication and Agent replay;
// only recognized self telemetry is routed to the dedicated system table.
func sdkRuntime(n normalized, source string) bool {
	attrs, _ := n.Row["attributes"].(map[string]string)
	if attrs["lightmoni.component"] != "sdk" {
		return false
	}
	switch attrs["sdk.language"] {
	case "go", "typescript", "python", "java", "dotnet", "php", "ruby", "rust":
	default:
		return false
	}
	if n.Kind == "metric" && n.Subtype == "gauge" {
		switch strings.TrimPrefix(fmt.Sprint(n.Row["name"]), "lightmoni.sdk.") {
		case "heartbeat", "pending_batches", "pending_bytes", "retried_batches", "dropped_records", "rejected_records", "invalid_records", "overflow_records":
		default:
			return false
		}
		if !strings.HasPrefix(fmt.Sprint(n.Row["name"]), "lightmoni.sdk.") {
			return false
		}
	} else if n.Kind == "log" {
		if attrs["event"] != "started" && attrs["event"] != "diagnostics_changed" {
			return false
		}
	} else {
		return false
	}
	attrs["source_table"] = source
	n.Row["attributes_json"] = jsonText(attrs)
	return true
}

// InternalExporter is only injected into the center's embedded SDK. Public
// ingest always authenticates the business route and denies reserved tables.
func (c *Catalog) InternalExporter() moni.Exporter {
	return moni.ExporterFunc(func(ctx context.Context, b moni.FrozenBatch) error {
		if !SystemTable(b.Table) {
			return fmt.Errorf("internal telemetry requires a system table")
		}
		rows, err := normalize(b.Signal, b.Payload, b.ContentType, time.Now().UTC().Format("2006-01-02 15:04:05.000000000"), "system")
		if err != nil {
			return err
		}
		grouped := map[string][]map[string]any{}
		for i, n := range rows {
			public, err := c.Ensure(ctx, n.Kind, b.Table, n.Subtype, fmt.Sprint(n.Row["service"]))
			if err != nil {
				return err
			}
			hash := sha256.Sum256([]byte(b.ID + "/" + fmt.Sprint(i)))
			n.Row["event_id"] = hex.EncodeToString(hash[:])
			grouped["_lm_"+public] = append(grouped["_lm_"+public], n.Row)
		}
		for target, rows := range grouped {
			if err = c.CH.Insert(ctx, target, rows); err != nil {
				return err
			}
		}
		return nil
	})
}
