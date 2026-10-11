package alerts

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"net"
	"net/http"
	"net/http/httptrace"
	"net/smtp"
	"net/textproto"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type sendResult struct {
	Status, ProviderID, Error string
	Retryable                 bool
	RetryAfter                time.Duration
	BlockAccount              bool
}

func rateKey(c Channel) string {
	credential := c.Config["token"] + c.Config["access_key_id"] + c.Config["username"]
	if credential == "" {
		credential = c.Config["url"]
	}
	sum := sha256.Sum256([]byte(c.Type + credential))
	return hex.EncodeToString(sum[:])
}
func feishuSign(timestamp, secret string) string {
	h := hmac.New(sha256.New, []byte(timestamp+"\n"+secret))
	return base64.StdEncoding.EncodeToString(h.Sum(nil))
}
func dingSign(timestamp, secret string) string {
	h := hmac.New(sha256.New, []byte(secret))
	_, _ = h.Write([]byte(timestamp + "\n" + secret))
	return base64.StdEncoding.EncodeToString(h.Sum(nil))
}
func (m *Module) SendPending(ctx context.Context) (resultErr error) {
	// Separate provider accounts can progress while one SMTP server is slow.
	var workers sync.WaitGroup
	var errorMu sync.Mutex
	var workerErr error
	slots := make(chan struct{}, 4)
	launch := func(job func() error) error {
		select {
		case slots <- struct{}{}:
		case <-ctx.Done():
			return ctx.Err()
		}
		workers.Add(1)
		go func() {
			defer workers.Done()
			defer func() { <-slots }()
			if err := job(); err != nil {
				errorMu.Lock()
				if workerErr == nil {
					workerErr = err
				}
				errorMu.Unlock()
			}
		}()
		return nil
	}
	defer func() {
		workers.Wait()
		if resultErr == nil {
			resultErr = workerErr
		}
	}()
	// Terminal accepted records and not-yet-due retries must not occupy the worker batch.
	nowTick := m.now()
	ds, e := listBodies[Delivery](ctx, m.deps.DB, "SELECT body FROM alert_outbox WHERE status IN ('queued','retry','accepted') AND next_attempt<>'' AND next_attempt<=? ORDER BY created_at,rowid LIMIT 100", stamp(nowTick))
	if e != nil {
		return e
	}
	if _, e = m.deps.DB.ExecContext(ctx, "DELETE FROM alert_send_attempts WHERE attempted_at<?", stamp(nowTick.Add(-5*time.Minute))); e != nil {
		return e
	}
	// Track this tick by account as well as each configured channel.
	accountSent := map[string]bool{}
	for _, d := range ds {
		now := m.now()
		if parse(d.NextAttempt).After(now) {
			continue
		}
		c, e := m.channel(ctx, d.ChannelID, true)
		if e != nil || !c.Enabled {
			if d.Status == "accepted" {
				d.NextAttempt = ""
				d.Error = "已受理；渠道不可用，不能继续查询回执"
			} else {
				d.Status = "cancelled"
				d.Error = "渠道已禁用或删除"
			}
			_ = m.updateDelivery(ctx, d)
			continue
		}
		if now.Sub(parse(d.CreatedAt)) > 24*time.Hour {
			if d.Status == "accepted" {
				d.NextAttempt = ""
				if e = m.updateDelivery(ctx, d); e != nil {
					return e
				}
				continue
			}
			d.Status = "expired"
			d.Error = "通知超过24小时有效期"
			_ = m.updateDelivery(ctx, d)
			continue
		}
		if d.Status == "accepted" {
			if c.Type != "aliyun_sms" && (c.Type != "pushplus" || c.Config["access_key"] == "") {
				d.NextAttempt = ""
				if e = m.updateDelivery(ctx, d); e != nil {
					return e
				}
				continue
			}
			key := rateKey(c)
			if accountSent[key] {
				continue
			}
			accountSent[key] = true
			if e = launch(func() error {
				result := m.receipt(ctx, c, d)
				if result.Status != "" {
					d.Status = result.Status
					d.Error = result.Error
				}
				d.NextAttempt = stamp(now.Add(time.Minute))
				d.UpdatedAt = stamp(now)
				return m.updateDelivery(ctx, d)
			}); e != nil {
				return e
			}
			continue
		}
		if d.RuleID != "" {
			rules, e := m.rules(ctx)
			if e != nil {
				return e
			}
			valid := false
			silenced := false
			for _, r := range rules {
				if r.ID == d.RuleID && r.Enabled {
					if parse(r.SilenceUntil).After(now) {
						silenced = true
						break
					}
					routes, _, _ := m.route(ctx, r)
					for _, route := range routes {
						if route.Target.ChannelID == d.ChannelID && recipientKey(route.Target.Recipient) == recipientKey(d.Recipient) {
							valid = true
						}
					}
				}
			}
			if silenced {
				d.Status = "suppressed"
				d.Error = "规则处于静默期"
				if e = m.updateDelivery(ctx, d); e != nil {
					return e
				}
				continue
			}
			if !valid {
				d.Status = "cancelled"
				d.Error = "告警目标已解绑或规则禁用"
				_ = m.updateDelivery(ctx, d)
				continue
			}
		}
		if d.Payload.Episode != "" {
			var earlier int
			e = m.deps.DB.QueryRowContext(ctx, `SELECT count(*) FROM alert_outbox WHERE channel_id=? AND target=? AND status IN ('queued','retry','sending') AND json_extract(body,'$.payload.episode')=? AND rowid<(SELECT rowid FROM alert_outbox WHERE id=?)`, d.ChannelID, recipientKey(d.Recipient), d.Payload.Episode, d.ID).Scan(&earlier)
			if e != nil {
				return e
			}
			if earlier > 0 {
				continue
			}
		}
		key := rateKey(c)
		var blockedReason string
		if e = m.deps.DB.QueryRowContext(ctx, "SELECT reason FROM alert_rate_blocks WHERE rate_key=?", key).Scan(&blockedReason); e == nil {
			d.Status = "failed"
			d.Error = "渠道账号已暂停，请修正并保存渠道配置：" + blockedReason
			if e = m.updateDelivery(ctx, d); e != nil {
				return e
			}
			continue
		}
		if accountSent[key] {
			continue
		}
		rate := 20
		if c.Type == "pushplus" {
			rate = 5
		}
		if v, _ := strconv.Atoi(c.Config["rate_per_minute"]); v > 0 && v < 600 {
			rate = v
		}
		sent := 0
		if e = m.deps.DB.QueryRowContext(ctx, "SELECT count(*) FROM alert_send_attempts WHERE rate_key=? AND attempted_at>=?", key, stamp(now.Add(-time.Minute))).Scan(&sent); e != nil {
			return e
		}
		if sent >= rate {
			continue
		}
		accountSent[key] = true
		d.Status = "sending"
		d.Attempts++
		d.UpdatedAt = stamp(now)
		d.SentAt = stamp(now)
		if e = m.updateDelivery(ctx, d); e != nil {
			return e
		}
		if _, e = m.deps.DB.ExecContext(ctx, "INSERT INTO alert_send_attempts(id,rate_key,attempted_at) VALUES(?,?,?)", id(), key, stamp(now)); e != nil {
			return e
		}
		if e = launch(func() error { return m.sendDelivery(ctx, c, d, key, now) }); e != nil {
			return e
		}
	}
	return nil
}
func (m *Module) sendDelivery(ctx context.Context, c Channel, d Delivery, key string, now time.Time) error {
	result := m.send(ctx, c, d)
	if result.BlockAccount {
		if _, e := m.deps.DB.ExecContext(ctx, "INSERT INTO alert_rate_blocks(rate_key,reason) VALUES(?,?) ON CONFLICT(rate_key) DO UPDATE SET reason=excluded.reason", key, result.Error); e != nil {
			return e
		}
	}
	d.Status = result.Status
	d.ProviderID = result.ProviderID
	d.Error = result.Error
	d.UpdatedAt = stamp(m.now())
	if d.Status == "accepted" {
		d.NextAttempt = ""
		if c.Type == "aliyun_sms" || c.Type == "pushplus" && c.Config["access_key"] != "" {
			d.NextAttempt = stamp(now.Add(time.Minute))
		}
	}
	if result.Retryable {
		if d.Attempts >= 6 {
			d.Status = "failed"
		} else {
			d.Status = "retry"
			wait := time.Duration(1<<d.Attempts) * time.Second
			if result.RetryAfter > wait {
				wait = result.RetryAfter
			}
			d.NextAttempt = stamp(now.Add(wait))
		}
	}
	return m.updateDelivery(ctx, d)
}
func (m *Module) send(ctx context.Context, c Channel, d Delivery) sendResult {
	if c.Type == "smtp" {
		return m.sendSMTP(ctx, c, d)
	}
	if c.Type == "aliyun_sms" {
		params := map[string]string{"PhoneNumbers": d.Recipient.Value, "SignName": c.Config["sign_name"], "TemplateCode": c.Config["template_code"]}
		vars := map[string]string{"rule": d.Payload.RuleName, "status": d.Payload.Kind, "value": d.Payload.State.Value}
		if mapping := c.Config["template_params"]; mapping != "" {
			custom := map[string]string{}
			if json.Unmarshal([]byte(mapping), &custom) != nil {
				return sendResult{Status: "failed", Error: "invalid SMS template_params JSON"}
			}
			for k, v := range custom {
				v = strings.ReplaceAll(v, "{{rule}}", vars["rule"])
				v = strings.ReplaceAll(v, "{{status}}", vars["status"])
				v = strings.ReplaceAll(v, "{{value}}", vars["value"])
				custom[k] = v
			}
			vars = custom
		}
		params["TemplateParam"] = encode(vars)
		return m.smsRequest(ctx, c, "SendSms", params)
	}
	endpoint := c.Config["url"]
	text := d.Payload.Message
	if m.deps.ExternalURL != "" {
		text += "\n" + strings.TrimRight(m.deps.ExternalURL, "/") + "/alerts"
	}
	body := map[string]any{}
	now := m.now()
	switch c.Type {
	case "feishu":
		for _, mention := range d.Recipient.Mentions {
			text += "\n<at user_id=\"" + html.EscapeString(mention) + "\"></at>"
		}
		body = map[string]any{"msg_type": "text", "content": map[string]string{"text": text}}
		if c.Config["secret"] != "" {
			ts := strconv.FormatInt(now.Unix(), 10)
			body["timestamp"] = ts
			body["sign"] = feishuSign(ts, c.Config["secret"])
		}
	case "dingtalk":
		mobiles := []string{}
		users := []string{}
		for _, v := range d.Recipient.Mentions {
			if _, e := strconv.ParseUint(v, 10, 64); e == nil {
				mobiles = append(mobiles, v)
			} else {
				users = append(users, v)
			}
		}
		body = map[string]any{"msgtype": "text", "text": map[string]string{"content": text}, "at": map[string]any{"atMobiles": mobiles, "atUserIds": users}}
		if c.Config["secret"] != "" {
			u, e := url.Parse(endpoint)
			if e != nil {
				return sendResult{Status: "failed", Error: "invalid URL"}
			}
			q := u.Query()
			ts := strconv.FormatInt(now.UnixMilli(), 10)
			q.Set("timestamp", ts)
			q.Set("sign", dingSign(ts, c.Config["secret"]))
			u.RawQuery = q.Encode()
			endpoint = u.String()
		}
	case "wecom":
		body = map[string]any{"msgtype": "text", "text": map[string]any{"content": text, "mentioned_list": d.Recipient.Mentions}}
	case "pushplus":
		endpoint = c.Config["endpoint"]
		if endpoint == "" {
			endpoint = "https://www.pushplus.plus/send"
		}
		body = map[string]any{"token": c.Config["token"], "title": d.Payload.RuleName, "content": text, "channel": c.Config["push_channel"], "template": "txt"}
		if d.Recipient.Kind == "topic" {
			body["topic"] = d.Recipient.Value
		} else if d.Recipient.Kind == "friend" {
			body["to"] = d.Recipient.Value
		}
	default:
		body = map[string]any{"event_id": d.EventID, "notification_id": d.ID, "event": d.Payload, "recipient": d.Recipient}
	}
	raw := []byte(encode(body))
	req, e := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(raw))
	if e != nil {
		return sendResult{Status: "failed", Error: "invalid endpoint"}
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-LightMoni-Event-ID", d.EventID)
	if c.Type == "webhook" {
		if headers := c.Config["headers"]; headers != "" {
			var hs map[string]string
			if json.Unmarshal([]byte(headers), &hs) != nil {
				return sendResult{Status: "failed", Error: "invalid headers JSON"}
			}
			for k, v := range hs {
				req.Header.Set(k, v)
			}
		}
		if sec := c.Config["secret"]; sec != "" {
			h := hmac.New(sha256.New, []byte(sec))
			_, _ = h.Write(raw)
			req.Header.Set("X-LightMoni-Signature", "sha256="+hex.EncodeToString(h.Sum(nil)))
		}
	}
	var wroteRequest atomic.Bool
	req = req.WithContext(httptrace.WithClientTrace(req.Context(), &httptrace.ClientTrace{WroteRequest: func(httptrace.WroteRequestInfo) { wroteRequest.Store(true) }}))
	resp, e := m.client.Do(req)
	if e != nil {
		if !wroteRequest.Load() {
			return sendResult{Status: "failed", Error: "无法连接通知服务，等待重试", Retryable: true}
		}
		return sendResult{Status: "unknown", Error: "网络请求结果不确定，可能已被受理"}
	}
	defer resp.Body.Close()
	data, e := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if e != nil {
		return sendResult{Status: "unknown", Error: "供应商响应读取失败"}
	}
	retry := resp.StatusCode == 429 || resp.StatusCode >= 500
	wait := time.Duration(0)
	if sec, e := strconv.Atoi(resp.Header.Get("Retry-After")); e == nil {
		wait = time.Duration(sec) * time.Second
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return sendResult{Status: "failed", Error: fmt.Sprintf("HTTP %d", resp.StatusCode), Retryable: retry, RetryAfter: wait}
	}
	if c.Type == "webhook" {
		return sendResult{Status: "accepted"}
	}
	var result map[string]json.RawMessage
	if json.Unmarshal(data, &result) != nil {
		return sendResult{Status: "failed", Error: "供应商响应不是有效JSON"}
	}
	var code int
	field := "errcode"
	if c.Type == "feishu" {
		field = "code"
	}
	if c.Type == "pushplus" {
		field = "code"
	}
	if e = json.Unmarshal(result[field], &code); e != nil {
		return sendResult{Status: "failed", Error: "供应商响应缺少业务状态码"}
	}
	expected := 0
	if c.Type == "pushplus" {
		expected = 200
	}
	if code != expected {
		retryable := code == 99991400 || code == 45009 || code == 130101 || code == 90002 || c.Type == "pushplus" && code == 500
		return sendResult{Status: "failed", Error: fmt.Sprintf("供应商业务错误 %d", code), Retryable: retryable, BlockAccount: c.Type == "pushplus" && code == 900}
	}
	var providerID string
	if c.Type == "pushplus" {
		_ = json.Unmarshal(result["data"], &providerID)
	}
	return sendResult{Status: "accepted", ProviderID: providerID}
}
func (m *Module) receipt(ctx context.Context, c Channel, d Delivery) sendResult {
	if c.Type == "aliyun_sms" && d.ProviderID != "" {
		return m.smsRequest(ctx, c, "QuerySendDetails", map[string]string{"PhoneNumber": d.Recipient.Value, "BizId": d.ProviderID, "SendDate": parse(d.CreatedAt).UTC().Format("20060102"), "PageSize": "10", "CurrentPage": "1"})
	}
	if c.Type != "pushplus" || d.ProviderID == "" || c.Config["access_key"] == "" {
		return sendResult{}
	}
	endpoint := c.Config["receipt_endpoint"]
	if endpoint == "" {
		endpoint = "https://www.pushplus.plus/api/open/message/sendMessageResult"
	}
	u, e := url.Parse(endpoint)
	if e != nil {
		return sendResult{}
	}
	q := u.Query()
	q.Set("shortCode", d.ProviderID)
	u.RawQuery = q.Encode()
	req, e := http.NewRequestWithContext(ctx, "GET", u.String(), nil)
	if e != nil {
		return sendResult{}
	}
	req.Header.Set("access-key", c.Config["access_key"])
	resp, e := m.client.Do(req)
	if e != nil {
		return sendResult{}
	}
	defer resp.Body.Close()
	var result struct {
		Code int `json:"code"`
		Data struct {
			Status int    `json:"status"`
			Error  string `json:"errorMessage"`
		} `json:"data"`
	}
	if json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&result) != nil || result.Code != 200 {
		return sendResult{}
	}
	switch result.Data.Status {
	case 2:
		return sendResult{Status: "confirmed"}
	case 3:
		return sendResult{Status: "failed", Error: "pushplus最终发送失败: " + result.Data.Error}
	}
	return sendResult{}
}

// RPC Signature v1 is the documented Aliyun SMS API signing protocol.
func percent(v string) string { return strings.ReplaceAll(url.QueryEscape(v), "+", "%20") }
func smsSignature(params map[string]string, secret string) string {
	keys := []string{}
	for k := range params {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	pairs := []string{}
	for _, k := range keys {
		pairs = append(pairs, percent(k)+"="+percent(params[k]))
	}
	canonical := strings.Join(pairs, "&")
	h := hmac.New(sha1.New, []byte(secret+"&"))
	_, _ = h.Write([]byte("POST&%2F&" + percent(canonical)))
	return base64.StdEncoding.EncodeToString(h.Sum(nil))
}
func (m *Module) smsRequest(ctx context.Context, c Channel, action string, params map[string]string) sendResult {
	params["Action"] = action
	params["Version"] = "2017-05-25"
	params["Format"] = "JSON"
	params["AccessKeyId"] = c.Config["access_key_id"]
	params["SignatureMethod"] = "HMAC-SHA1"
	params["SignatureVersion"] = "1.0"
	params["SignatureNonce"] = id()
	params["Timestamp"] = m.now().UTC().Format("2006-01-02T15:04:05Z")
	params["Signature"] = smsSignature(params, c.Config["access_key_secret"])
	form := url.Values{}
	for k, v := range params {
		form.Set(k, v)
	}
	endpoint := c.Config["endpoint"]
	if endpoint == "" {
		endpoint = "https://dysmsapi.aliyuncs.com/"
	}
	req, e := http.NewRequestWithContext(ctx, "POST", endpoint, strings.NewReader(form.Encode()))
	if e != nil {
		return sendResult{Status: "failed", Error: "invalid SMS endpoint"}
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, e := m.client.Do(req)
	if e != nil {
		if action == "QuerySendDetails" {
			return sendResult{}
		}
		return sendResult{Status: "unknown", Error: "短信提交结果未知，请查询回执再决定重试"}
	}
	defer resp.Body.Close()
	var result struct {
		Code    string `json:"Code"`
		BizID   string `json:"BizId"`
		Details struct {
			Items []struct {
				Status int    `json:"SendStatus"`
				Error  string `json:"ErrCode"`
			} `json:"SmsSendDetailDTO"`
		} `json:"SmsSendDetailDTOs"`
	}
	if json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&result) != nil {
		return sendResult{Status: "unknown", Error: "短信响应读取失败"}
	}
	if result.Code != "OK" {
		return sendResult{Status: "failed", Error: "短信业务错误: " + result.Code, Retryable: result.Code == "isv.BUSINESS_LIMIT_CONTROL" || result.Code == "isv.SYSTEM_ERROR"}
	}
	if action == "QuerySendDetails" {
		for _, v := range result.Details.Items {
			if v.Status == 3 {
				return sendResult{Status: "confirmed"}
			}
			if v.Status == 2 {
				return sendResult{Status: "failed", Error: "短信最终发送失败: " + v.Error}
			}
		}
		return sendResult{}
	}
	return sendResult{Status: "accepted", ProviderID: result.BizID}
}
func (m *Module) sendSMTP(ctx context.Context, c Channel, d Delivery) sendResult {
	host := c.Config["host"]
	port := c.Config["port"]
	if port == "" {
		port = "587"
	}
	address := net.JoinHostPort(host, port)
	dialer := net.Dialer{Timeout: 10 * time.Second}
	var conn net.Conn
	var e error
	if c.Config["tls"] == "tls" {
		td := tls.Dialer{NetDialer: &dialer, Config: &tls.Config{ServerName: host, MinVersion: tls.VersionTLS12}}
		conn, e = td.DialContext(ctx, "tcp", address)
	} else {
		conn, e = dialer.DialContext(ctx, "tcp", address)
	}
	if e != nil {
		return sendResult{Status: "failed", Error: "SMTP连接失败", Retryable: true}
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(10 * time.Second))
	client, e := smtp.NewClient(conn, host)
	if e != nil {
		return sendResult{Status: "failed", Error: "SMTP握手失败", Retryable: true}
	}
	defer client.Close()
	if c.Config["tls"] == "starttls" {
		e = client.StartTLS(&tls.Config{ServerName: host, MinVersion: tls.VersionTLS12})
		if e != nil {
			return sendResult{Status: "failed", Error: "SMTP STARTTLS失败"}
		}
	}
	if user := c.Config["username"]; user != "" {
		if e = client.Auth(smtp.PlainAuth("", user, c.Config["password"], host)); e != nil {
			return sendResult{Status: "failed", Error: "SMTP认证失败"}
		}
	}
	if e = client.Mail(c.Config["from"]); e == nil {
		e = client.Rcpt(d.Recipient.Value)
	}
	if e != nil {
		var smtpErr *textproto.Error
		retry := errors.As(e, &smtpErr) && smtpErr.Code >= 400 && smtpErr.Code < 500
		return sendResult{Status: "failed", Error: "SMTP拒绝发件人/收件人", Retryable: retry}
	}
	writer, e := client.Data()
	if e != nil {
		return sendResult{Status: "failed", Error: "SMTP DATA失败", Retryable: true}
	}
	subject := strings.NewReplacer("\r", " ", "\n", " ").Replace(d.Payload.RuleName + " · " + d.Payload.Kind)
	msg := "From: " + c.Config["from"] + "\r\nTo: " + d.Recipient.Value + "\r\nSubject: =?UTF-8?B?" + base64.StdEncoding.EncodeToString([]byte(subject)) + "?=\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nMessage-ID: <" + d.ID + "@lightmoni>\r\n\r\n" + d.Payload.Message + "\r\n"
	if _, e = io.WriteString(writer, msg); e != nil {
		return sendResult{Status: "unknown", Error: "SMTP提交结果未知"}
	}
	if e = writer.Close(); e != nil {
		return sendResult{Status: "unknown", Error: "SMTP未确认邮件提交"}
	}
	_ = client.Quit()
	return sendResult{Status: "accepted"}
}
