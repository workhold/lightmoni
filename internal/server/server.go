package server

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"github.com/lightmoni/lightmoni/internal/auth"
	"github.com/lightmoni/lightmoni/internal/ingest"
	"github.com/lightmoni/lightmoni/internal/query"
	"github.com/lightmoni/lightmoni/internal/shared"
	"github.com/lightmoni/lightmoni/internal/storage"
	"io/fs"
	"net/http"
	"path/filepath"
	"strings"
)

//go:embed dist agent-dist
var assets embed.FS

type Config struct{ DataDir, CHURL, CHUser, CHPassword, ExternalURL string }
type Server struct {
	DB          *sql.DB
	Auth        *auth.Auth
	Catalog     *ingest.Catalog
	Executor    *query.Executor
	API, Public *http.ServeMux
	deps        shared.Dependencies
	Runtime     *RuntimeMonitor
}

func New(ctx context.Context, cfg Config) (*Server, error) {
	db, e := storage.Open(filepath.Join(cfg.DataDir, "lightmoni.db"))
	if e != nil {
		return nil, e
	}
	a, e := auth.New(db, cfg.DataDir, cfg.ExternalURL)
	if e != nil {
		db.Close()
		return nil, e
	}
	writer := storage.NewClickHouse(cfg.CHURL, cfg.CHUser, cfg.CHPassword)
	writer.Database = ""
	if e = writer.Exec(ctx, "CREATE DATABASE IF NOT EXISTS lightmoni"); e != nil {
		db.Close()
		return nil, e
	}
	writer.Database = "lightmoni"
	sum := sha256.Sum256(a.Master)
	readerPassword := hex.EncodeToString(sum[:])
	reader := storage.NewClickHouse(cfg.CHURL, "lightmoni_reader", readerPassword)
	if e = writer.Exec(ctx, "CREATE USER IF NOT EXISTS lightmoni_reader IDENTIFIED WITH sha256_password BY '"+readerPassword+"'"); e != nil {
		db.Close()
		return nil, e
	}
	if e = writer.Exec(ctx, "ALTER USER lightmoni_reader SETTINGS readonly=2"); e != nil {
		db.Close()
		return nil, e
	}
	catalog, e := ingest.NewCatalog(db, writer, reader)
	if e != nil {
		db.Close()
		return nil, e
	}
	if e = catalog.Migrate(ctx); e != nil {
		db.Close()
		return nil, e
	}
	q := query.New(reader, catalog.List)
	s := &Server{DB: db, Auth: a, Catalog: catalog, Executor: q, API: http.NewServeMux(), Public: http.NewServeMux()}
	s.deps = shared.Dependencies{DB: db, Query: q.Execute, ReferencedTables: q.ReferencedTables, Catalog: catalog.List, ExternalURL: cfg.ExternalURL, Encrypt: a.Encrypt, Decrypt: a.Decrypt}
	if e = s.initRuntime(ctx); e != nil {
		db.Close()
		return nil, e
	}
	a.RegisterPublic(s.Public)
	a.Register(s.API)
	(&ingest.Ingest{Catalog: catalog, Auth: a, Accepted: s.Runtime.accepted}).Register(s.Public)
	if e = s.registerCore(); e != nil {
		db.Close()
		return nil, e
	}
	s.registerTemplates()
	if e = s.registerAgentInstall(cfg.ExternalURL); e != nil {
		db.Close()
		return nil, e
	}
	return s, nil
}
func (s *Server) Dependencies() shared.Dependencies { return s.deps }
func (s *Server) Handler() http.Handler {
	protected := s.Auth.Middleware(s.API)
	sub, _ := fs.Sub(assets, "dist")
	files := http.FileServer(http.FS(sub))
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, pattern := s.Public.Handler(r); pattern != "" {
			s.Public.ServeHTTP(w, r)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/") {
			protected.ServeHTTP(w, r)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/v1/") {
			shared.Error(w, 404, "unknown signal")
			return
		}
		if _, e := fs.Stat(sub, strings.TrimPrefix(r.URL.Path, "/")); e != nil {
			r.URL.Path = "/"
		}
		files.ServeHTTP(w, r)
	})
	if s.Runtime != nil {
		return s.Runtime.middleware(handler)
	}
	return handler
}
func (s *Server) registerCore() error {
	s.registerRetention()
	s.registerLogSampling()
	if _, e := s.DB.Exec("CREATE TABLE IF NOT EXISTS agents(id TEXT PRIMARY KEY,host_id TEXT NOT NULL,hostname TEXT NOT NULL,version TEXT NOT NULL,platform TEXT NOT NULL,arch TEXT NOT NULL,last_seen TEXT NOT NULL,heartbeat TEXT NOT NULL,group_id TEXT NOT NULL DEFAULT 'default');"); e != nil {
		return e
	}
	if e := s.initAgentTasks(); e != nil {
		return e
	}
	if _, e := s.DB.Exec("CREATE TABLE IF NOT EXISTS agent_runtime_events(agent_id TEXT NOT NULL,event_id TEXT NOT NULL,key_id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(agent_id,event_id))"); e != nil {
		return e
	}
	s.Public.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { shared.JSON(w, 200, map[string]string{"status": "ok"}) })
	s.API.HandleFunc("GET /api/v1/settings/instance", func(w http.ResponseWriter, r *http.Request) {
		shared.JSON(w, 200, map[string]any{"external_url": s.deps.ExternalURL, "version": "0.1.0"})
	})
	s.API.HandleFunc("GET /api/v1/catalog/tables", func(w http.ResponseWriter, r *http.Request) {
		tables, e := s.Catalog.List(r.Context())
		if e != nil {
			shared.Error(w, 500, e.Error())
			return
		}
		shared.JSON(w, 200, tables)
	})
	s.API.HandleFunc("PUT /api/v1/catalog/tables/{id}", func(w http.ResponseWriter, r *http.Request) {
		var v struct {
			AlertGroupID string `json:"alert_group_id"`
		}
		if shared.Decode(r, &v) != nil {
			shared.Error(w, 400, "invalid table config")
			return
		}
		if v.AlertGroupID != "" {
			var n int
			if e := s.DB.QueryRow("SELECT count(*) FROM alert_groups WHERE id=?", v.AlertGroupID).Scan(&n); e != nil || n != 1 {
				shared.Error(w, 400, "alert group not found")
				return
			}
		}
		result, e := s.DB.Exec("UPDATE catalog SET alert_group_id=? WHERE id=?", v.AlertGroupID, r.PathValue("id"))
		if e != nil {
			shared.Error(w, 500, e.Error())
			return
		}
		if n, _ := result.RowsAffected(); n == 0 {
			shared.Error(w, 404, "table not found")
			return
		}
		shared.JSON(w, 200, map[string]bool{"ok": true})
	})
	s.API.HandleFunc("POST /api/v1/query", func(w http.ResponseWriter, r *http.Request) {
		var v shared.QueryRequest
		if shared.Decode(r, &v) != nil {
			shared.Error(w, 400, "invalid query request")
			return
		}
		if v.RequestID == "" {
			v.RequestID = auth.ID()
		}
		result, e := s.Executor.Execute(r.Context(), v)
		if e != nil {
			shared.Error(w, 400, e.Error())
			return
		}
		shared.JSON(w, 200, result)
	})
	s.API.HandleFunc("GET /api/v1/overview", func(w http.ResponseWriter, r *http.Request) {
		tables, e := s.Catalog.List(r.Context())
		if e != nil {
			shared.Error(w, 500, e.Error())
			return
		}
		var agents, users, keys int
		_ = s.DB.QueryRow("SELECT count(*) FROM agents").Scan(&agents)
		_ = s.DB.QueryRow("SELECT count(*) FROM users WHERE active=1").Scan(&users)
		_ = s.DB.QueryRow("SELECT count(*) FROM ingest_keys WHERE active=1").Scan(&keys)
		shared.JSON(w, 200, map[string]any{"tables": tables, "agent_count": agents, "user_count": users, "key_count": keys})
	})
	for _, path := range []string{"POST /api/v1/agents/register", "POST /api/v1/agents/{id}/heartbeat"} {
		s.Public.HandleFunc(path, func(w http.ResponseWriter, r *http.Request) {
			key, e := s.Auth.ValidateKey(r)
			if e != nil {
				shared.Error(w, 401, "invalid write key")
				return
			}
			var v map[string]any
			if shared.Decode(r, &v) != nil {
				shared.Error(w, 400, "invalid heartbeat")
				return
			}
			id := fmt.Sprint(v["agent_id"])
			if r.PathValue("id") != "" {
				id = r.PathValue("id")
			}
			if id == "" || id == "<nil>" {
				shared.Error(w, 400, "agent_id required")
				return
			}
			if e = s.storeAgentEvents(r.Context(), id, key, v); e != nil {
				shared.Error(w, 503, "执行节点运行事件暂不可用")
				return
			}
			if e = s.recordAgentHeartbeat(id, v, key); e != nil {
				status := agentErrorStatus(e)
				if status == 500 {
					shared.Error(w, 503, "执行节点记录暂不可用")
					return
				}
				shared.Error(w, status, e.Error())
				return
			}
			shared.JSON(w, 200, map[string]any{"agent_id": id, "ok": true})
		})
	}
	s.Public.HandleFunc("GET /api/v1/agents/{id}/config", func(w http.ResponseWriter, r *http.Request) {
		if _, e := s.Auth.ValidateKey(r); e != nil {
			shared.Error(w, 401, "invalid write key")
			return
		}
		compiled, err := s.nodeEffectiveAgentTasks(r.PathValue("id"))
		if err != nil {
			respondAgentError(w, err)
			return
		}
		// Additional metadata is ignored by older LightMoni Agent binaries.
		raw, _ := json.Marshal(compiled.Config)
		var config map[string]any
		_ = json.Unmarshal(raw, &config)
		config["task_ids"] = compiled.TaskIDs
		config["task_labels"] = compiled.Labels
		shared.JSON(w, 200, config)
	})
	s.API.HandleFunc("GET /api/v1/agents", func(w http.ResponseWriter, r *http.Request) {
		nodes, err := s.listExecutionNodes()
		if err != nil {
			respondAgentError(w, err)
			return
		}
		shared.JSON(w, 200, nodes)
	})
	s.registerAgentConfig()
	return nil
}
