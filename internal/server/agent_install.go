package server

import (
	"github.com/lightmoni/lightmoni/internal/shared"
	"io/fs"
	"net/http"
	"regexp"
	"strings"
)

func (s *Server) registerAgentInstall(externalURL string) error {
	if err := s.registerReportingSettings(externalURL); err != nil {
		return err
	}
	s.Public.HandleFunc("GET /downloads/agent/{file}", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "private, no-store")
		w.Header().Set("Vary", "Authorization")
		if s.Auth == nil || !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") {
			shared.Error(w, 401, "下载 Agent 需要有效的上报 Key")
			return
		}
		if _, err := s.Auth.ValidateKey(r); err != nil {
			shared.Error(w, 401, "上报 Key 无效或已禁用")
			return
		}
		file := r.PathValue("file")
		if file != "install.sh" && file != "uninstall.sh" && file != "SHA256SUMS" && !regexp.MustCompile(`^lightmoni-agent_[0-9A-Za-z._-]+_linux_(amd64|arm64)\.tar\.gz$`).MatchString(file) {
			http.NotFound(w, r)
			return
		}
		raw, e := fs.ReadFile(assets, "agent-dist/"+file)
		if e != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Disposition", `attachment; filename="`+file+`"`)
		w.Header().Set("Content-Type", "application/octet-stream")
		_, _ = w.Write(raw)
	})
	s.Public.HandleFunc("GET /downloads/sdk/{file}", func(w http.ResponseWriter, r *http.Request) {
		file := r.PathValue("file")
		if !allowedSDKFile(file) {
			http.NotFound(w, r)
			return
		}
		raw, err := fs.ReadFile(assets, "agent-dist/"+file)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Disposition", `attachment; filename="`+file+`"`)
		w.Header().Set("Content-Type", "application/octet-stream")
		_, _ = w.Write(raw)
	})
	s.API.HandleFunc("GET /api/v1/sdk-install", func(w http.ResponseWriter, r *http.Request) {
		settings, err := s.reportingSettings(r.Context(), externalURL)
		if err != nil {
			shared.Error(w, 500, "读取默认上报地址失败")
			return
		}
		base := settings.EffectiveEndpoint
		shared.JSON(w, 200, map[string]any{"version": sdkVersion, "endpoint": base, "endpoints": settings.Endpoints, "default_endpoint_id": settings.DefaultEndpointID, "node_url": base + "/downloads/sdk/lightmoni-sdk-" + sdkVersion + ".tgz", "go_url": base + "/downloads/sdk/lightmoni-go-sdk_" + sdkVersion + ".tar.gz", "packages": sdkPackages(base), "checksums_url": base + "/downloads/sdk/SDK_SHA256SUMS"})
	})
	s.API.HandleFunc("GET /api/v1/agent-install", func(w http.ResponseWriter, r *http.Request) {
		entries, _ := fs.ReadDir(assets, "agent-dist")
		bundles := []string{}
		for _, entry := range entries {
			if strings.HasPrefix(entry.Name(), "lightmoni-agent_") && strings.HasSuffix(entry.Name(), ".tar.gz") {
				bundles = append(bundles, entry.Name())
			}
		}
		settings, err := s.reportingSettings(r.Context(), externalURL)
		if err != nil {
			shared.Error(w, 500, "读取默认上报地址失败")
			return
		}
		base := settings.EffectiveEndpoint
		shared.JSON(w, 200, map[string]any{"version": "0.1.0", "endpoint": base, "endpoints": settings.Endpoints, "default_endpoint_id": settings.DefaultEndpointID, "release_url": base + "/downloads/agent", "install_url": base + "/downloads/agent/install.sh", "bundles": bundles, "requires_key": true})
	})
	return nil
}
