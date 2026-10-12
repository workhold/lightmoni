package ingest

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"github.com/lightmoni/lightmoni/internal/shared"
	"github.com/lightmoni/lightmoni/internal/storage"
	"strings"
	"sync"
)

type Catalog struct {
	DB     *sql.DB
	CH     *storage.ClickHouse
	Reader *storage.ClickHouse
	mu     sync.Mutex
}

const commonColumns = "event_id String,event_time DateTime64(9,'UTC'),ingested_at DateTime64(9,'UTC'),service LowCardinality(String),instance_id String,host_id String,agent_id String,key_id String,resource_json String,attributes Map(String,String),attributes_json String"

func ValidTable(name string) bool {
	return shared.ValidLogicalTable(name)
}
func NewCatalog(db *sql.DB, ch, reader *storage.ClickHouse) (*Catalog, error) {
	_, e := db.Exec("CREATE TABLE IF NOT EXISTS catalog(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,logical_name TEXT NOT NULL,kind TEXT NOT NULL,metric_type TEXT NOT NULL,columns_json TEXT NOT NULL,services_json TEXT NOT NULL DEFAULT '[]',alert_group_id TEXT NOT NULL DEFAULT ''); CREATE TABLE IF NOT EXISTS ingest_batches(id TEXT PRIMARY KEY,digest TEXT NOT NULL,first_received_at TEXT NOT NULL,key_id TEXT NOT NULL,completed INTEGER NOT NULL DEFAULT 0);")
	c := &Catalog{DB: db, CH: ch, Reader: reader}
	if e == nil {
		e = c.initRetention()
	}
	if e == nil {
		e = c.initSampling()
	}
	return c, e
}
func (c *Catalog) Ensure(ctx context.Context, kind, name, metricType, service string) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !ValidTable(name) {
		return "", fmt.Errorf("invalid logical table name")
	}
	public := kind + "_" + name
	if metricType != "" {
		public += "_" + metricType
	}
	var servicesRaw string
	err := c.DB.QueryRow("SELECT services_json FROM catalog WHERE name=?", public).Scan(&servicesRaw)
	if err == nil {
		var services []string
		_ = json.Unmarshal([]byte(servicesRaw), &services)
		exists := false
		for _, s := range services {
			if s == service {
				exists = true
			}
		}
		if !exists && service != "" {
			services = append(services, service)
			raw, _ := json.Marshal(services)
			_, err = c.DB.Exec("UPDATE catalog SET services_json=? WHERE name=?", string(raw), public)
		}
		return public, err
	}
	var n int
	_ = c.DB.QueryRow("SELECT count(*) FROM catalog").Scan(&n)
	if n >= 200 {
		return "", fmt.Errorf("maximum table count reached")
	}
	extra := ""
	ttl, err := c.DefaultRetention(ctx)
	if err != nil {
		return "", err
	}
	switch kind {
	case "log":
		extra = "severity LowCardinality(String),severity_number UInt8,body String,body_json String,trace_id String,span_id String,source_id String,source_seq Nullable(UInt64)"
	case "metric":
		extra = "name LowCardinality(String),unit LowCardinality(String),start_time DateTime64(9,'UTC')"
		switch metricType {
		case "sum":
			extra += ",value Decimal(38,9),value_type String,value_int Nullable(Int64) DEFAULT if(value_type='int',toInt64(value),NULL),value_float Float64 DEFAULT toFloat64(value),temporality String,monotonic Bool"
		case "gauge":
			extra += ",value Decimal(38,9),value_type String,value_int Nullable(Int64) DEFAULT if(value_type='int',toInt64(value),NULL),value_float Float64 DEFAULT toFloat64(value)"
		case "histogram":
			extra += ",bounds Array(Float64),bucket_counts Array(UInt64),count UInt64,sum Nullable(Float64),min Nullable(Float64),max Nullable(Float64),temporality String"
		default:
			return "", fmt.Errorf("unsupported metric type")
		}
	case "trace":
		extra = "trace_id String,span_id String,parent_span_id String,name String,kind String,start_time DateTime64(9,'UTC'),end_time DateTime64(9,'UTC'),duration_ns UInt64,status String,events_json String,links_json String"
	default:
		return "", fmt.Errorf("unsupported signal")
	}
	internal := "_lm_" + public
	ttlClause := ""
	if ttl > 0 {
		ttlClause = fmt.Sprintf(" TTL event_time + INTERVAL %d DAY", ttl)
	}
	sql := fmt.Sprintf("CREATE TABLE IF NOT EXISTS %s (%s,%s) ENGINE=ReplacingMergeTree PARTITION BY toDate(event_time) ORDER BY (service,toDate(event_time),event_time,event_id)%s SETTINGS fsync_after_insert=1,fsync_part_directory=1", internal, commonColumns, extra, ttlClause)
	if err = c.CH.Exec(ctx, sql); err != nil {
		return "", err
	}
	owner := strings.ReplaceAll(c.CH.User, "`", "``")
	if err = c.CH.Exec(ctx, "CREATE OR REPLACE VIEW "+public+" DEFINER=`"+owner+"` SQL SECURITY DEFINER AS "+viewQuery(kind, metricType, internal)); err != nil {
		return "", err
	}
	if err = c.CH.Exec(ctx, "GRANT SELECT ON lightmoni."+public+" TO `"+strings.ReplaceAll(c.Reader.User, "`", "``")+"`"); err != nil {
		return "", err
	}
	result, err := c.CH.Query(ctx, "SELECT name,type FROM system.columns WHERE database='lightmoni' AND table={table:String} ORDER BY position", map[string]string{"table": public})
	if err != nil {
		return "", err
	}
	cols := []shared.Column{}
	for _, row := range result.Data {
		cols = append(cols, shared.Column{Name: fmt.Sprint(row["name"]), Type: fmt.Sprint(row["type"])})
	}
	raw, _ := json.Marshal(cols)
	initialServices := []string{}
	if service != "" {
		initialServices = append(initialServices, service)
	}
	services, _ := json.Marshal(initialServices)
	_, err = c.DB.Exec("INSERT INTO catalog(id,name,logical_name,kind,metric_type,columns_json,services_json) VALUES(?,?,?,?,?,?,?)", public, public, name, kind, metricType, string(raw), string(services))
	return public, err
}
func (c *Catalog) List(ctx context.Context) ([]shared.Table, error) {
	rows, e := c.DB.QueryContext(ctx, "SELECT id,name,logical_name,kind,metric_type,columns_json,services_json,alert_group_id,retention_days,COALESCE(retention_days,(SELECT default_days FROM retention_config WHERE id=1)) FROM catalog ORDER BY name")
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	list := []shared.Table{}
	for rows.Next() {
		var t shared.Table
		var cols, services string
		if e = rows.Scan(&t.ID, &t.Name, &t.LogicalName, &t.Kind, &t.MetricType, &cols, &services, &t.AlertGroupID, &t.RetentionDays, &t.EffectiveRetentionDays); e != nil {
			return nil, e
		}
		_ = json.Unmarshal([]byte(cols), &t.Columns)
		_ = json.Unmarshal([]byte(services), &t.Services)
		t.System = shared.SystemLogicalTable(t.LogicalName)
		list = append(list, t)
	}
	return list, rows.Err()
}
