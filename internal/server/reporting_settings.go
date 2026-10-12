package server

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"net/url"
	"strings"

	"github.com/lightmoni/lightmoni/internal/shared"
)

type reportingSettings struct {
	Endpoint          string `json:"endpoint"`
	DefaultEndpoint   string `json:"default_endpoint"`
	EffectiveEndpoint string `json:"effective_endpoint"`
}

func (s *Server) reportingSettings(ctx context.Context, externalURL string) (reportingSettings, error) {
	settings := reportingSettings{DefaultEndpoint: strings.TrimRight(strings.TrimSpace(externalURL), "/")}
	err := s.DB.QueryRowContext(ctx, "SELECT value FROM instance_settings WHERE name='reporting_endpoint'").Scan(&settings.Endpoint)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return settings, err
	}
	settings.EffectiveEndpoint = settings.Endpoint
	if settings.EffectiveEndpoint == "" {
		settings.EffectiveEndpoint = settings.DefaultEndpoint
	}
	return settings, nil
}

func validReportingEndpoint(endpoint string) bool {
	u, err := url.Parse(endpoint)
	return err == nil && len(endpoint) <= 2048 && (u.Scheme == "http" || u.Scheme == "https") && u.Hostname() != "" && u.User == nil && !u.ForceQuery && u.RawQuery == "" && !strings.ContainsAny(endpoint, "#\\\r\n\t ")
}

func (s *Server) registerReportingSettings(externalURL string) error {
	if _, err := s.DB.Exec("CREATE TABLE IF NOT EXISTS instance_settings(name TEXT PRIMARY KEY,value TEXT NOT NULL)"); err != nil {
		return err
	}
	s.API.HandleFunc("GET /api/v1/settings/reporting", func(w http.ResponseWriter, r *http.Request) {
		settings, err := s.reportingSettings(r.Context(), externalURL)
		if err != nil {
			shared.Error(w, 500, "读取默认上报地址失败")
			return
		}
		shared.JSON(w, 200, settings)
	})
	s.API.HandleFunc("PUT /api/v1/settings/reporting", func(w http.ResponseWriter, r *http.Request) {
		if !shared.IsAdmin(r) {
			shared.Error(w, 403, "只有管理员可以设置默认上报地址")
			return
		}
		var input struct {
			Endpoint *string `json:"endpoint"`
		}
		if shared.Decode(r, &input) != nil || input.Endpoint == nil {
			shared.Error(w, 400, "请填写默认上报地址，或留空使用部署地址")
			return
		}
		endpoint := strings.TrimSpace(*input.Endpoint)
		if endpoint != "" && !validReportingEndpoint(endpoint) {
			shared.Error(w, 400, "请输入完整的 HTTP(S) 地址，不包含用户名、密码、查询参数或片段")
			return
		}
		endpoint = strings.TrimRight(endpoint, "/")
		if _, err := s.DB.ExecContext(r.Context(), "INSERT INTO instance_settings(name,value) VALUES('reporting_endpoint',?) ON CONFLICT(name) DO UPDATE SET value=excluded.value", endpoint); err != nil {
			shared.Error(w, 500, "保存默认上报地址失败")
			return
		}
		settings := reportingSettings{Endpoint: endpoint, DefaultEndpoint: strings.TrimRight(strings.TrimSpace(externalURL), "/"), EffectiveEndpoint: endpoint}
		if endpoint == "" {
			settings.EffectiveEndpoint = settings.DefaultEndpoint
		}
		shared.JSON(w, 200, settings)
	})
	return nil
}
