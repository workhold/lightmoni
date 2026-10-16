package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/lightmoni/lightmoni/internal/shared"
)

type reportingAddress struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	URL  string `json:"url"`
}
type reportingAddressBook struct {
	Endpoints         []reportingAddress `json:"endpoints"`
	DefaultEndpointID string             `json:"default_endpoint_id"`
}
type reportingSettings struct {
	Endpoint          string             `json:"endpoint"`
	DefaultEndpoint   string             `json:"default_endpoint"`
	EffectiveEndpoint string             `json:"effective_endpoint"`
	Endpoints         []reportingAddress `json:"endpoints"`
	DefaultEndpointID string             `json:"default_endpoint_id"`
}

func reportingSettingsFor(book reportingAddressBook, externalURL string) reportingSettings {
	settings := reportingSettings{DefaultEndpoint: strings.TrimRight(strings.TrimSpace(externalURL), "/"), Endpoints: book.Endpoints, DefaultEndpointID: book.DefaultEndpointID}
	for _, address := range book.Endpoints {
		if address.ID == book.DefaultEndpointID {
			settings.Endpoint = address.URL
		}
	}
	settings.EffectiveEndpoint = settings.Endpoint
	if settings.EffectiveEndpoint == "" {
		settings.EffectiveEndpoint = settings.DefaultEndpoint
		settings.Endpoints = []reportingAddress{{ID: "deployment", Name: "部署地址", URL: settings.DefaultEndpoint}}
		settings.DefaultEndpointID = "deployment"
	}
	return settings
}
func (s *Server) reportingSettings(ctx context.Context, externalURL string) (reportingSettings, error) {
	var raw string
	err := s.DB.QueryRowContext(ctx, "SELECT value FROM instance_settings WHERE name='reporting_endpoints'").Scan(&raw)
	if err == nil {
		var book reportingAddressBook
		if err = json.Unmarshal([]byte(raw), &book); err != nil {
			return reportingSettings{}, err
		}
		return reportingSettingsFor(book, externalURL), nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return reportingSettings{}, err
	}
	var endpoint string
	err = s.DB.QueryRowContext(ctx, "SELECT value FROM instance_settings WHERE name='reporting_endpoint'").Scan(&endpoint)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return reportingSettings{}, err
	}
	book := reportingAddressBook{Endpoints: []reportingAddress{}}
	if endpoint != "" {
		book.Endpoints = []reportingAddress{{ID: "default", Name: "默认地址", URL: endpoint}}
		book.DefaultEndpointID = "default"
	}
	return reportingSettingsFor(book, externalURL), nil
}
func validReportingEndpoint(endpoint string) bool {
	u, err := url.Parse(endpoint)
	return err == nil && len(endpoint) <= 2048 && (u.Scheme == "http" || u.Scheme == "https") && u.Hostname() != "" && u.User == nil && !u.ForceQuery && u.RawQuery == "" && !strings.ContainsAny(endpoint, "#\\\r\n\t ")
}
func validateReportingAddresses(book *reportingAddressBook) error {
	if len(book.Endpoints) > 20 {
		return errors.New("最多配置 20 个上报地址")
	}
	ids, urls := map[string]bool{}, map[string]bool{}
	for i := range book.Endpoints {
		address := &book.Endpoints[i]
		address.Name = strings.TrimSpace(address.Name)
		address.URL = strings.TrimSpace(address.URL)
		if !regexp.MustCompile(`^[a-zA-Z0-9_-]{1,64}$`).MatchString(address.ID) || ids[address.ID] {
			return errors.New("上报地址 ID 无效或重复")
		}
		if address.Name == "" || utf8.RuneCountInString(address.Name) > 64 || strings.IndexFunc(address.Name, unicode.IsControl) >= 0 {
			return errors.New("地址名称需要 1–64 个字符")
		}
		if !validReportingEndpoint(address.URL) {
			return fmt.Errorf("%s：请输入完整的 HTTP(S) 地址，不包含用户名、密码、查询参数或片段", address.Name)
		}
		address.URL = strings.TrimRight(address.URL, "/")
		if urls[address.URL] {
			return errors.New("请勿重复配置相同的上报地址")
		}
		ids[address.ID], urls[address.URL] = true, true
	}
	if len(book.Endpoints) == 0 {
		book.DefaultEndpointID = ""
		return nil
	}
	if !ids[book.DefaultEndpointID] {
		return errors.New("请选择列表中的默认上报地址")
	}
	return nil
}
func (s *Server) registerReportingSettings(externalURL string) error {
	if _, err := s.DB.Exec("CREATE TABLE IF NOT EXISTS instance_settings(name TEXT PRIMARY KEY,value TEXT NOT NULL)"); err != nil {
		return err
	}
	s.API.HandleFunc("GET /api/v1/settings/reporting", func(w http.ResponseWriter, r *http.Request) {
		settings, err := s.reportingSettings(r.Context(), externalURL)
		if err != nil {
			shared.Error(w, 500, "读取上报地址失败")
			return
		}
		shared.JSON(w, 200, settings)
	})
	s.API.HandleFunc("PUT /api/v1/settings/reporting", func(w http.ResponseWriter, r *http.Request) {
		if !shared.IsAdmin(r) {
			shared.Error(w, 403, "只有管理员可以配置上报地址")
			return
		}
		var input struct {
			Endpoint          *string             `json:"endpoint"`
			Endpoints         *[]reportingAddress `json:"endpoints"`
			DefaultEndpointID string              `json:"default_endpoint_id"`
		}
		if shared.Decode(r, &input) != nil || (input.Endpoint == nil && input.Endpoints == nil) {
			shared.Error(w, 400, "请填写上报地址列表")
			return
		}
		book := reportingAddressBook{Endpoints: []reportingAddress{}}
		if input.Endpoints != nil {
			book.Endpoints = *input.Endpoints
			book.DefaultEndpointID = input.DefaultEndpointID
		} else if endpoint := strings.TrimSpace(*input.Endpoint); endpoint != "" {
			book.Endpoints = []reportingAddress{{ID: "default", Name: "默认地址", URL: endpoint}}
			book.DefaultEndpointID = "default"
		}
		if err := validateReportingAddresses(&book); err != nil {
			shared.Error(w, 400, err.Error())
			return
		}
		settings := reportingSettingsFor(book, externalURL)
		raw, err := json.Marshal(book)
		if err != nil {
			shared.Error(w, 500, "保存上报地址失败")
			return
		}
		tx, err := s.DB.BeginTx(r.Context(), nil)
		if err != nil {
			shared.Error(w, 500, "保存上报地址失败")
			return
		}
		defer tx.Rollback()
		for name, value := range map[string]string{"reporting_endpoints": string(raw), "reporting_endpoint": settings.Endpoint} {
			if _, err = tx.ExecContext(r.Context(), "INSERT INTO instance_settings(name,value) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value", name, value); err != nil {
				shared.Error(w, 500, "保存上报地址失败")
				return
			}
		}
		if err = tx.Commit(); err != nil {
			shared.Error(w, 500, "保存上报地址失败")
			return
		}
		shared.JSON(w, 200, settings)
	})
	return nil
}
