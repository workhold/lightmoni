package query

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	parser "github.com/AfterShip/clickhouse-sql-parser/parser"
	"github.com/lightmoni/lightmoni/internal/shared"
	"github.com/lightmoni/lightmoni/internal/storage"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

type Executor struct {
	CH      *storage.ClickHouse
	Catalog func(context.Context) ([]shared.Table, error)
	slots   chan struct{}
}

func New(ch *storage.ClickHouse, cat func(context.Context) ([]shared.Table, error)) *Executor {
	return &Executor{CH: ch, Catalog: cat, slots: make(chan struct{}, 4)}
}

var identifier = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)?$`)

func expand(sql string, r shared.Range, interval int64) (string, map[string]string, error) {
	from, e := time.Parse(time.RFC3339Nano, r.From)
	if e != nil {
		return "", nil, errors.New("invalid from time")
	}
	to, e := time.Parse(time.RFC3339Nano, r.To)
	if e != nil || !to.After(from) {
		return "", nil, errors.New("invalid time range")
	}
	if interval < 1 {
		interval = 60000
	}
	values := map[string]string{"__lm_from": from.UTC().Format("2006-01-02 15:04:05.999999999"), "__lm_to": to.UTC().Format("2006-01-02 15:04:05.999999999"), "__lm_interval": strconv.FormatInt(interval, 10)}
	var out strings.Builder
	for i := 0; i < len(sql); {
		if sql[i] == '\'' || sql[i] == '"' || sql[i] == '`' {
			quote := sql[i]
			start := i
			i++
			for i < len(sql) {
				if sql[i] == '\\' {
					i += 2
					continue
				}
				if sql[i] == quote {
					i++
					if i < len(sql) && sql[i] == quote {
						i++
						continue
					}
					break
				}
				i++
			}
			if i > len(sql) {
				i = len(sql)
			}
			out.WriteString(sql[start:i])
			continue
		}
		if strings.HasPrefix(sql[i:], "--") {
			end := strings.IndexByte(sql[i:], '\n')
			if end < 0 {
				out.WriteString(sql[i:])
				break
			}
			out.WriteString(sql[i : i+end+1])
			i += end + 1
			continue
		}
		if strings.HasPrefix(sql[i:], "/*") {
			end := strings.Index(sql[i+2:], "*/")
			if end < 0 {
				return "", nil, errors.New("unterminated SQL comment")
			}
			end += i + 4
			out.WriteString(sql[i:end])
			i = end
			continue
		}
		matched := false
		for _, macro := range []string{"$__timeFilter(", "$__timeInterval("} {
			if strings.HasPrefix(sql[i:], macro) {
				start := i + len(macro)
				n := strings.IndexByte(sql[start:], ')')
				if n < 0 {
					return "", nil, errors.New("unterminated time macro")
				}
				column := strings.TrimSpace(sql[start : start+n])
				if !identifier.MatchString(column) {
					return "", nil, errors.New("time macro requires a field identifier")
				}
				if macro == "$__timeFilter(" {
					out.WriteString("(" + column + ">={__lm_from:DateTime64(9,'UTC')} AND " + column + "<{__lm_to:DateTime64(9,'UTC')})")
				} else {
					out.WriteString("toStartOfInterval(" + column + ", toIntervalMillisecond({__lm_interval:Int64}))")
				}
				i = start + n + 1
				matched = true
				break
			}
		}
		if !matched {
			out.WriteByte(sql[i])
			i++
		}
	}
	return out.String(), values, nil
}
func ReferencedTables(sql string, allowed map[string]bool) ([]string, error) {
	stmts, e := parser.NewParser(sql).ParseStmts()
	if e != nil {
		return nil, e
	}
	if len(stmts) != 1 {
		return nil, errors.New("only one SQL statement is allowed")
	}
	if _, ok := stmts[0].(*parser.SelectQuery); !ok {
		return nil, errors.New("only SELECT/WITH queries are allowed")
	}
	ctes := map[string]bool{}
	parser.Walk(stmts[0], func(n parser.Expr) bool {
		if c, ok := n.(*parser.CTEStmt); ok && c.Alias != nil {
			if _, isQuery := c.Alias.(*parser.SelectQuery); isQuery {
				ctes[strings.Trim(parser.Format(c.Expr), "`\"")] = true
			}
		}
		return true
	})
	refs := map[string]bool{}
	var violation error
	parser.Walk(stmts[0], func(n parser.Expr) bool {
		if violation != nil {
			return false
		}
		switch v := n.(type) {
		case *parser.SelectQuery:
			if v.Settings != nil || v.Format != nil {
				violation = errors.New("SQL SETTINGS/FORMAT are controlled by LightMoni")
			}
		case *parser.TableFunctionExpr:
			violation = errors.New("table functions are not allowed")
		case *parser.TableIdentifier:
			name := v.Table.Name
			if v.Database != nil && v.Database.Name != "lightmoni" {
				violation = errors.New("only LightMoni tables are allowed")
				break
			}
			if ctes[name] && v.Database == nil {
				break
			}
			if !allowed[name] {
				violation = fmt.Errorf("table %s is not in the public catalog", name)
				break
			}
			refs[name] = true
		case *parser.FunctionExpr:
			name := strings.ToLower(v.Name.Name)
			if strings.HasPrefix(name, "dict") || strings.Contains(name, "file") || name == "url" || strings.HasPrefix(name, "remote") {
				violation = errors.New("external access functions are not allowed")
			}
		}
		return violation == nil
	})
	if violation != nil {
		return nil, violation
	}
	names := []string{}
	for name := range refs {
		names = append(names, name)
	}
	sort.Strings(names)
	return names, nil
}
func paramValue(p shared.Parameter) (string, error) {
	switch p.Type {
	case "String":
		if v, ok := p.Value.(string); ok {
			return v, nil
		}
	case "Int64":
		v := fmt.Sprint(p.Value)
		if _, err := strconv.ParseInt(v, 10, 64); err == nil {
			return v, nil
		}
	case "UInt64", "UInt8":
		v := fmt.Sprint(p.Value)
		bits := 64
		if p.Type == "UInt8" {
			bits = 8
		}
		if _, err := strconv.ParseUint(v, 10, bits); err == nil {
			return v, nil
		}
	case "Bool":
		switch fmt.Sprint(p.Value) {
		case "true", "1":
			return "1", nil
		case "false", "0":
			return "0", nil
		}
	case "Float64", "Float32":
		v := fmt.Sprint(p.Value)
		f, err := strconv.ParseFloat(v, 64)
		if err == nil && !math.IsNaN(f) && !math.IsInf(f, 0) {
			return v, nil
		}
	case "Decimal(38,9)":
		v := fmt.Sprint(p.Value)
		if regexp.MustCompile(`^-?[0-9]{1,29}(\.[0-9]{1,9})?$`).MatchString(v) {
			return v, nil
		}
	case "Array(String)":
		var values []string
		switch a := p.Value.(type) {
		case []string:
			values = a
		case []any:
			values = make([]string, 0, len(a))
			for _, v := range a {
				s, ok := v.(string)
				if !ok {
					return "", errors.New("array must contain strings")
				}
				values = append(values, s)
			}
		}
		if values == nil {
			return "", errors.New("invalid string array")
		}
		escaped := []string{}
		for _, v := range values {
			escaped = append(escaped, "'"+strings.NewReplacer("\\", "\\\\", "'", "\\'").Replace(v)+"'")
		}
		return "[" + strings.Join(escaped, ",") + "]", nil
	}
	return "", fmt.Errorf("unsupported/invalid parameter type %s", p.Type)
}
func (e *Executor) Execute(ctx context.Context, req shared.QueryRequest) (shared.QueryResponse, error) {
	response := shared.QueryResponse{RequestID: req.RequestID, Results: []shared.QueryResult{}}
	if len(req.Queries) < 1 || len(req.Queries) > 8 {
		return response, errors.New("one to eight queries are required")
	}
	tables, err := e.Catalog(ctx)
	if err != nil {
		return response, err
	}
	allowed := map[string]bool{}
	for _, t := range tables {
		allowed[t.Name] = true
	}
	for _, q := range req.Queries {
		start := time.Now()
		r := shared.QueryResult{RefID: q.RefID, Status: "error", Frames: []shared.Frame{}}
		sql, params, err := expand(q.SQL, req.Range, req.IntervalMS)
		if err == nil {
			_, err = ReferencedTables(sql, allowed)
			if err == nil {
				stmts, _ := parser.NewParser(sql).ParseStmts()
				sql = parser.Format(stmts[0])
			}
		}
		if err == nil {
			for k, p := range q.Params {
				if strings.HasPrefix(k, "__lm_") || !identifier.MatchString(k) {
					err = errors.New("invalid parameter name")
					break
				}
				params[k], err = paramValue(p)
				if err != nil {
					break
				}
			}
		}
		if err == nil {
			select {
			case e.slots <- struct{}{}:
			case <-ctx.Done():
				err = ctx.Err()
			}
			if err == nil {
				qctx, cancel := context.WithTimeout(ctx, 10*time.Second)
				result, qerr := e.CH.Query(qctx, sql, params)
				cancel()
				<-e.slots
				err = qerr
				if err == nil {
					frame := shared.Frame{Columns: []shared.Column{}, Rows: [][]any{}}
					for _, col := range result.Meta {
						frame.Columns = append(frame.Columns, shared.Column{Name: col.Name, Type: col.Type, Nullable: strings.HasPrefix(col.Type, "Nullable(")})
					}
					r.Truncated = len(result.Data) > 10000
					if r.Truncated {
						result.Data = result.Data[:10000]
					}
					for _, row := range result.Data {
						values := []any{}
						for _, col := range result.Meta {
							val := row[col.Name]
							if strings.Contains(col.Type, "DateTime") {
								if s, ok := val.(string); ok {
									if t, parseErr := time.ParseInLocation("2006-01-02 15:04:05.999999999", s, time.UTC); parseErr == nil {
										val = t.Format(time.RFC3339Nano)
									}
								}
							}
							if n, ok := val.(json.Number); ok {
								val, _ = n.Float64()
							}
							values = append(values, val)
						}
						frame.Rows = append(frame.Rows, values)
					}
					r.Frames = []shared.Frame{frame}
					r.Complete = !r.Truncated
					r.Status = "success"
					if len(frame.Rows) == 0 {
						r.Status = "empty"
					}
				}
			}
		}
		if err != nil {
			r.Error = err.Error()
			if errors.Is(err, context.Canceled) {
				r.Status = "cancelled"
			}
		}
		r.ElapsedMS = time.Since(start).Milliseconds()
		response.Results = append(response.Results, r)
	}
	return response, nil
}

func (e *Executor) ReferencedTables(ctx context.Context, sql string) ([]string, error) {
	now := time.Now().UTC()
	expanded, _, err := expand(sql, shared.Range{From: now.Add(-time.Hour).Format(time.RFC3339Nano), To: now.Format(time.RFC3339Nano)}, 60000)
	if err != nil {
		return nil, err
	}
	tables, err := e.Catalog(ctx)
	if err != nil {
		return nil, err
	}
	allowed := map[string]bool{}
	for _, t := range tables {
		allowed[t.Name] = true
	}
	return ReferencedTables(expanded, allowed)
}
