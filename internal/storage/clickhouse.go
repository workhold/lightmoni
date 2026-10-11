package storage

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type ClickHouse struct {
	URL, User, Password, Database string
	Client                        *http.Client
}

func NewClickHouse(endpoint, user, password string) *ClickHouse {
	return &ClickHouse{URL: strings.TrimRight(endpoint, "/"), User: user, Password: password, Database: "lightmoni", Client: &http.Client{Timeout: 15 * time.Second}}
}
func (c *ClickHouse) request(ctx context.Context, query string, params map[string]string, data []byte, reader bool) ([]byte, error) {
	u, e := url.Parse(c.URL)
	if e != nil {
		return nil, e
	}
	v := u.Query()
	if c.Database != "" {
		v.Set("database", c.Database)
	}
	v.Set("query", query)
	if reader {
		v.Set("max_execution_time", "10")
		v.Set("max_memory_usage", "268435456")
		v.Set("max_rows_to_read", "5000000")
		v.Set("read_overflow_mode", "throw")
		v.Set("max_result_rows", "10001")
		v.Set("result_overflow_mode", "break")
		v.Set("output_format_json_quote_64bit_integers", "1")
		v.Set("output_format_json_quote_decimals", "1")
		v.Set("output_format_json_quote_denormals", "0")
	}
	for k, val := range params {
		v.Set("param_"+k, val)
	}
	u.RawQuery = v.Encode()
	req, e := http.NewRequestWithContext(ctx, "POST", u.String(), bytes.NewReader(data))
	if e != nil {
		return nil, e
	}
	req.SetBasicAuth(c.User, c.Password)
	res, e := c.Client.Do(req)
	if e != nil {
		return nil, e
	}
	defer res.Body.Close()
	b, e := io.ReadAll(io.LimitReader(res.Body, 32<<20))
	if e != nil {
		return nil, e
	}
	if res.StatusCode >= 300 {
		return nil, fmt.Errorf("ClickHouse (%d): %s", res.StatusCode, strings.TrimSpace(string(b)))
	}
	return b, nil
}
func (c *ClickHouse) Exec(ctx context.Context, sql string) error {
	_, e := c.request(ctx, sql, nil, nil, false)
	return e
}
func (c *ClickHouse) Insert(ctx context.Context, table string, rows []map[string]any) error {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	for _, row := range rows {
		if e := enc.Encode(row); e != nil {
			return e
		}
	}
	_, e := c.request(ctx, "INSERT INTO "+table+" FORMAT JSONEachRow", nil, b.Bytes(), false)
	return e
}

type CHColumn struct {
	Name string `json:"name"`
	Type string `json:"type"`
}
type CHResult struct {
	Meta []CHColumn       `json:"meta"`
	Data []map[string]any `json:"data"`
	Rows int              `json:"rows"`
}

func (c *ClickHouse) Query(ctx context.Context, sql string, params map[string]string) (CHResult, error) {
	var r CHResult
	b, e := c.request(ctx, sql+" FORMAT JSON", params, nil, true)
	if e != nil {
		return r, e
	}
	d := json.NewDecoder(bytes.NewReader(b))
	d.UseNumber()
	e = d.Decode(&r)
	return r, e
}
