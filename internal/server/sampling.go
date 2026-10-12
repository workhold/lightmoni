package server

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/lightmoni/lightmoni/internal/auth"
	"github.com/lightmoni/lightmoni/internal/ingest"
	"github.com/lightmoni/lightmoni/internal/shared"
	moni "github.com/lightmoni/lightmoni/sdk/go"
)

func samplingError(w http.ResponseWriter, err error) {
	status := http.StatusInternalServerError
	if errors.Is(err, ingest.ErrInvalidSampling) {
		status = http.StatusBadRequest
	} else if errors.Is(err, sql.ErrNoRows) {
		status = http.StatusNotFound
	}
	shared.Error(w, status, err.Error())
}

func (s *Server) registerLogSampling() {
	s.Public.HandleFunc("GET /v1/sdk-config", func(w http.ResponseWriter, r *http.Request) {
		key, err := s.Auth.ValidateKey(r)
		if err != nil {
			shared.Error(w, 401, "invalid write key")
			return
		}
		policies, err := s.Catalog.LogSamplingPolicies(r.Context())
		if err != nil {
			shared.Error(w, 503, "SDK configuration unavailable")
			return
		}
		for table := range policies {
			if err = s.Auth.AuthorizeTable(key, table); err != nil {
				if !errors.Is(err, auth.ErrTableNotAllowed) {
					shared.Error(w, 503, "key permissions unavailable")
					return
				}
				delete(policies, table)
			}
		}
		disable, err := s.Catalog.SDKDisableRules(r.Context())
		if err != nil {
			shared.Error(w, 503, "SDK configuration unavailable")
			return
		}
		config := moni.SDKConfig{LogSampling: policies, DisableRules: disable}
		raw, _ := json.Marshal(config)
		hash := sha256.Sum256(raw)
		w.Header().Set("Cache-Control", "no-store")
		config.Revision = hex.EncodeToString(hash[:])
		shared.JSON(w, 200, config)
	})
	s.API.HandleFunc("GET /api/v1/settings/sdk-reporting", func(w http.ResponseWriter, r *http.Request) {
		rules, err := s.Catalog.SDKDisableRules(r.Context())
		if err != nil {
			samplingError(w, err)
			return
		}
		shared.JSON(w, 200, map[string]any{"disable_rules": rules})
	})
	s.API.HandleFunc("PUT /api/v1/settings/sdk-reporting", func(w http.ResponseWriter, r *http.Request) {
		if !shared.IsAdmin(r) {
			shared.Error(w, 403, "只有管理员可以设置 SDK 上报规则")
			return
		}
		var input struct {
			Rules []moni.LogExcludeRule `json:"disable_rules"`
		}
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
		decoder.UseNumber()
		decoder.DisallowUnknownFields()
		if decoder.Decode(&input) != nil {
			shared.Error(w, 400, "无效的 SDK 停报规则")
			return
		}
		var extra any
		if err := decoder.Decode(&extra); err != io.EOF {
			shared.Error(w, 400, "请只提交一个配置对象")
			return
		}
		if err := s.Catalog.SetSDKDisableRules(r.Context(), input.Rules); err != nil {
			samplingError(w, err)
			return
		}
		shared.JSON(w, 200, input)
	})
	s.API.HandleFunc("GET /api/v1/catalog/tables/{id}/log-sampling", func(w http.ResponseWriter, r *http.Request) {
		settings, err := s.Catalog.TableLogSampling(r.Context(), r.PathValue("id"))
		if err != nil {
			samplingError(w, err)
			return
		}
		shared.JSON(w, 200, settings)
	})
	s.API.HandleFunc("PUT /api/v1/catalog/tables/{id}/log-sampling", func(w http.ResponseWriter, r *http.Request) {
		if !shared.IsAdmin(r) {
			shared.Error(w, 403, "只有管理员可以设置日志采样策略")
			return
		}
		policy, err := moni.DecodeLogSampling(r.Body)
		if err != nil {
			samplingError(w, err)
			return
		}
		if err = s.Catalog.SetLogSampling(r.Context(), r.PathValue("id"), policy); err != nil {
			samplingError(w, err)
			return
		}
		shared.JSON(w, 200, policy)
	})
}
