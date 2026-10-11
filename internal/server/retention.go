package server

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/lightmoni/lightmoni/internal/ingest"
	"github.com/lightmoni/lightmoni/internal/shared"
)

func retentionError(w http.ResponseWriter, err error) {
	status := http.StatusInternalServerError
	if errors.Is(err, ingest.ErrInvalidRetention) {
		status = http.StatusBadRequest
	}
	if errors.Is(err, sql.ErrNoRows) {
		status = http.StatusNotFound
	}
	shared.Error(w, status, err.Error())
}

func (s *Server) registerRetention() {
	s.API.HandleFunc("GET /api/v1/settings/retention", func(w http.ResponseWriter, r *http.Request) {
		days, err := s.Catalog.DefaultRetention(r.Context())
		if err != nil {
			retentionError(w, err)
			return
		}
		shared.JSON(w, 200, map[string]int{"default_days": days})
	})
	s.API.HandleFunc("PUT /api/v1/settings/retention", func(w http.ResponseWriter, r *http.Request) {
		if !shared.IsAdmin(r) {
			shared.Error(w, 403, "只有管理员可以设置数据保留时长")
			return
		}
		var input struct {
			Days *int `json:"default_days"`
		}
		if shared.Decode(r, &input) != nil || input.Days == nil {
			shared.Error(w, 400, "请填写默认保留天数")
			return
		}
		if err := s.Catalog.SetDefaultRetention(r.Context(), *input.Days); err != nil {
			retentionError(w, err)
			return
		}
		shared.JSON(w, 200, map[string]int{"default_days": *input.Days})
	})
	s.API.HandleFunc("PUT /api/v1/catalog/tables/{id}/retention", func(w http.ResponseWriter, r *http.Request) {
		if !shared.IsAdmin(r) {
			shared.Error(w, 403, "只有管理员可以设置数据保留时长")
			return
		}
		var input struct {
			Days json.RawMessage `json:"retention_days"`
		}
		if shared.Decode(r, &input) != nil || len(input.Days) == 0 {
			shared.Error(w, 400, "请填写保留天数，或使用 null 跟随全局默认")
			return
		}
		var days *int
		if json.Unmarshal(input.Days, &days) != nil {
			shared.Error(w, 400, "无效的保留天数")
			return
		}
		if err := s.Catalog.SetTableRetention(r.Context(), r.PathValue("id"), days); err != nil {
			retentionError(w, err)
			return
		}
		shared.JSON(w, 200, map[string]any{"retention_days": days})
	})
}
