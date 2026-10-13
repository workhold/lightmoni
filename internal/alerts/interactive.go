package alerts

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"html"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/lightmoni/lightmoni/internal/shared"
)

func responseCard(d Delivery, text string, interactive bool) map[string]any {
	button := map[string]any{"tag": "button", "text": map[string]string{"tag": "plain_text", "content": "开始处理"}, "type": "primary"}
	if interactive {
		button["value"] = map[string]string{"response_id": d.ResponseID, "action": "ack"}
	} else {
		button["url"] = d.AckURL
	}
	elements := []any{map[string]any{"tag": "div", "text": map[string]string{"tag": "plain_text", "content": text}}}
	if len(d.Recipient.Mentions) > 0 {
		mentions := "值班人员："
		for _, v := range d.Recipient.Mentions {
			mentions += "<at id=\"" + html.EscapeString(v) + "\"></at> "
		}
		elements = append(elements, map[string]any{"tag": "div", "text": map[string]string{"tag": "lark_md", "content": mentions}})
	}
	if d.AckURL != "" || interactive {
		elements = append(elements, map[string]any{"tag": "action", "actions": []any{button}})
	}
	return map[string]any{"config": map[string]bool{"wide_screen_mode": true, "update_multi": true}, "header": map[string]any{"title": map[string]string{"tag": "plain_text", "content": d.Payload.RuleName}, "template": "red"}, "elements": elements}
}
func (m *Module) sendFeishuApp(ctx context.Context, c Channel, d Delivery) sendResult {
	base := strings.TrimRight(c.Config["api_base"], "/")
	if base == "" {
		base = "https://open.feishu.cn"
	}
	req, e := http.NewRequestWithContext(ctx, "POST", base+"/open-apis/auth/v3/tenant_access_token/internal", bytes.NewBufferString(encode(map[string]string{"app_id": c.Config["app_id"], "app_secret": c.Config["app_secret"]})))
	if e != nil {
		return sendResult{Status: "failed", Error: "飞书API地址无效"}
	}
	req.Header.Set("Content-Type", "application/json")
	resp, e := m.client.Do(req)
	if e != nil {
		return sendResult{Status: "failed", Error: "无法取得飞书应用凭证", Retryable: true}
	}
	var token struct {
		Code  int    `json:"code"`
		Token string `json:"tenant_access_token"`
	}
	e = json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&token)
	resp.Body.Close()
	if e != nil || resp.StatusCode != 200 || token.Code != 0 || token.Token == "" {
		return sendResult{Status: "failed", Error: "飞书应用凭证被拒绝"}
	}
	card := responseCard(d, d.Payload.Message+m.evidenceText(ctx, d), d.AckURL != "")
	if d.ResponseID == "" {
		card["elements"] = []any{map[string]any{"tag": "div", "text": map[string]string{"tag": "plain_text", "content": d.Payload.Message}}}
	}
	body := map[string]any{"receive_id": d.Recipient.Value, "msg_type": "interactive", "content": encode(card), "uuid": d.ID}
	req, e = http.NewRequestWithContext(ctx, "POST", base+"/open-apis/im/v1/messages?receive_id_type=open_id", bytes.NewBufferString(encode(body)))
	if e != nil {
		return sendResult{Status: "failed", Error: "飞书消息地址无效"}
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token.Token)
	data, result := m.phoneRequest(req)
	if result.Status != "" {
		return result
	}
	var answer struct {
		Code int `json:"code"`
		Data struct {
			MessageID string `json:"message_id"`
		} `json:"data"`
	}
	if json.Unmarshal(data, &answer) != nil {
		return sendResult{Status: "unknown", Error: "飞书响应结果未知"}
	}
	if answer.Code != 0 {
		return sendResult{Status: "failed", Error: fmt.Sprintf("飞书发送错误%d", answer.Code), Retryable: answer.Code == 99991400}
	}
	return sendResult{Status: "accepted", ProviderID: answer.Data.MessageID}
}

func (m *Module) RegisterPublic(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/v1/notify/callbacks/{id}/{token}", m.notificationCallback)
}
func (m *Module) callbackURL(w http.ResponseWriter, r *http.Request) {
	if !admin(w, r) {
		return
	}
	c, e := m.channel(r.Context(), r.PathValue("id"), true)
	if e != nil {
		shared.Error(w, 404, "渠道不存在")
		return
	}
	if c.Config["callback_token"] == "" {
		shared.Error(w, 400, "此渠道没有回调能力")
		return
	}
	shared.JSON(w, 200, map[string]string{"url": strings.TrimRight(m.deps.ExternalURL, "/") + "/api/v1/notify/callbacks/" + c.ID + "/" + c.Config["callback_token"]})
}
func (m *Module) notificationCallback(w http.ResponseWriter, r *http.Request) {
	c, e := m.channel(r.Context(), r.PathValue("id"), true)
	if e != nil || !c.Enabled || c.Config["callback_token"] == "" || subtle.ConstantTimeCompare([]byte(c.Config["callback_token"]), []byte(r.PathValue("token"))) != 1 {
		shared.Error(w, 403, "无效的回调认证")
		return
	}
	raw, e := io.ReadAll(io.LimitReader(r.Body, (1<<20)+1))
	if e != nil || len(raw) > 1<<20 {
		shared.Error(w, 400, "回调数据超限")
		return
	}
	if c.Type == "feishu_app" {
		m.feishuCallback(w, r, c, raw)
		return
	}
	if c.Type != "aliyun_voice" && c.Type != "tencent_voice" {
		shared.Error(w, 400, "不支持此渠道回调")
		return
	}
	var events []map[string]any
	if c.Type == "aliyun_voice" {
		if json.Unmarshal(raw, &events) != nil {
			shared.Error(w, 400, "阿里云回调需要JSON数组")
			return
		}
	} else {
		var body map[string]any
		if json.Unmarshal(raw, &body) != nil {
			shared.Error(w, 400, "无效的腾讯语音回调")
			return
		}
		if inner, ok := body["voiceprompt_callback"].(map[string]any); ok {
			events = []map[string]any{inner}
		} else {
			events = []map[string]any{body}
		}
	}
	for _, event := range events {
		callID := valueString(event["call_id"])
		if callID == "" {
			callID = valueString(event["callid"])
		}
		if callID == "" {
			shared.Error(w, 400, "回调缺少通话ID")
			return
		}
	}
	tx, e := m.deps.DB.BeginTx(r.Context(), nil)
	if e != nil {
		respond(w, nil, e)
		return
	}
	defer tx.Rollback()
	for _, event := range events {
		callID := valueString(event["call_id"])
		if callID == "" {
			callID = valueString(event["callid"])
		}
		body := encode(event)
		receiptID := tokenHash(c.ID + "\n" + callID + "\n" + body)
		if _, e = tx.Exec("INSERT OR IGNORE INTO alert_voice_receipts(id,channel_id,provider_id,created_at,body,processed) VALUES(?,?,?,?,?,0)", receiptID, c.ID, callID, stamp(m.now()), body); e != nil {
			respond(w, nil, e)
			return
		}
	}
	if e = tx.Commit(); e != nil {
		respond(w, nil, e)
		return
	}
	_ = m.ProcessVoiceReceipts(r.Context())
	shared.JSON(w, 200, map[string]any{"code": 0, "msg": "success", "result": 0, "errmsg": "OK"})
}
func valueString(v any) string {
	if v == nil {
		return ""
	}
	return fmt.Sprint(v)
}
func phoneAnswered(c Channel, v map[string]any) bool {
	if c.Type == "tencent_voice" {
		return valueString(v["result"]) == "0" && valueString(v["accept_time"]) != "" && valueString(v["accept_time"]) != "0"
	}
	duration, _ := strconv.ParseFloat(valueString(v["duration"]), 64)
	return duration > 0 || valueString(v["smart_status_code"]) == "ANSWERED" || includes([]string{"200102", "200000", "200001"}, valueString(v["status_code"]))
}
func (m *Module) ProcessVoiceReceipts(ctx context.Context) error {
	rows, e := m.deps.DB.QueryContext(ctx, "SELECT id,channel_id,provider_id,body FROM alert_voice_receipts WHERE processed=0 ORDER BY created_at LIMIT 100")
	if e != nil {
		return e
	}
	type receipt struct{ ID, Channel, Provider, Body string }
	pending := []receipt{}
	for rows.Next() {
		var v receipt
		if e = rows.Scan(&v.ID, &v.Channel, &v.Provider, &v.Body); e != nil {
			rows.Close()
			return e
		}
		pending = append(pending, v)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return e
	}
	for _, v := range pending {
		var raw string
		var d Delivery
		var event map[string]any
		_ = json.Unmarshal([]byte(v.Body), &event)
		c, e := m.channel(ctx, v.Channel, false)
		if e != nil {
			continue
		}
		if m.deps.DB.QueryRowContext(ctx, "SELECT body FROM alert_outbox WHERE channel_id=? AND json_extract(body,'$.provider_id')=? LIMIT 1", v.Channel, v.Provider).Scan(&raw) != nil {
			// Aliyun echoes OutId even if the original HTTP response was lost.
			if c.Type != "aliyun_voice" || valueString(event["out_id"]) == "" || m.deps.DB.QueryRowContext(ctx, "SELECT body FROM alert_outbox WHERE channel_id=? AND id=?", v.Channel, valueString(event["out_id"])).Scan(&raw) != nil {
				continue
			}
		}
		if json.Unmarshal([]byte(raw), &d) != nil || (d.ProviderID != "" && d.ProviderID != v.Provider) {
			continue
		}
		d.ProviderID = v.Provider
		if d.Status == "unknown" || d.Status == "sending" {
			d.Status = "accepted"
			d.Error = ""
		}
		answered := phoneAnswered(c, event)
		if d.DeliveryStatus != "answered" {
			d.DeliveryStatus = "not_answered"
			switch valueString(event["status_code"]) {
			case "200101":
				d.DeliveryStatus = "calling"
			case "200201":
				d.DeliveryStatus = "ringing"
			}
		}
		if answered {
			d.DeliveryStatus = "answered"
			d.Status = "confirmed"
			d.NextAttempt = ""
		}
		d.UpdatedAt = stamp(m.now())
		if e = m.updateDelivery(ctx, d); e != nil {
			return e
		}
		if answered {
			if e = m.recordNotified(ctx, d, parse(d.CreatedAt)); e != nil {
				return e
			}
			m.claimAnsweredDelivery(ctx, c, d, parse(m.receiptTimestamp(c, event, d)))
		}
		if _, e = m.deps.DB.ExecContext(ctx, "UPDATE alert_voice_receipts SET processed=1 WHERE id=?", v.ID); e != nil {
			return e
		}
	}
	return nil
}

func (m *Module) claimAnsweredDelivery(ctx context.Context, c Channel, d Delivery, at time.Time) {
	if d.UserID == "" || d.ResponseID == "" {
		return
	}
	_, profile, active := m.member(ctx, d.UserID)
	expected := Recipient{Kind: "phone", Value: profile.Phone}
	if active && validateRecipient(c.Type, &expected) == nil && expected.Value == d.Recipient.Value {
		_, _ = m.acknowledge(ctx, d.ResponseID, d.UserID, "phone_answered", at)
	}
}

func decryptFeishu(raw []byte, key string) ([]byte, error) {
	var envelope struct {
		Encrypt string `json:"encrypt"`
	}
	if json.Unmarshal(raw, &envelope) != nil {
		return nil, fmt.Errorf("无效的卡片回调")
	}
	if envelope.Encrypt == "" {
		return raw, nil
	}
	data, e := base64.StdEncoding.DecodeString(envelope.Encrypt)
	if e != nil || len(data) < 2*aes.BlockSize || (len(data)-aes.BlockSize)%aes.BlockSize != 0 {
		return nil, fmt.Errorf("无效的加密回调")
	}
	hash := sha256.Sum256([]byte(key))
	block, e := aes.NewCipher(hash[:])
	if e != nil {
		return nil, e
	}
	plain := make([]byte, len(data)-aes.BlockSize)
	cipher.NewCBCDecrypter(block, data[:aes.BlockSize]).CryptBlocks(plain, data[aes.BlockSize:])
	padding := int(plain[len(plain)-1])
	if padding < 1 || padding > aes.BlockSize || padding > len(plain) {
		return nil, fmt.Errorf("无效的加密填充")
	}
	for _, v := range plain[len(plain)-padding:] {
		if int(v) != padding {
			return nil, fmt.Errorf("无效的加密填充")
		}
	}
	return plain[:len(plain)-padding], nil
}
func (m *Module) feishuCallback(w http.ResponseWriter, r *http.Request, c Channel, raw []byte) {
	if c.Config["encrypt_key"] != "" {
		ts, nonce := r.Header.Get("X-Lark-Request-Timestamp"), r.Header.Get("X-Lark-Request-Nonce")
		seconds, e := strconv.ParseInt(ts, 10, 64)
		delta := m.now().Sub(time.Unix(seconds, 0))
		if e != nil || delta > 5*time.Minute || delta < -5*time.Minute {
			shared.Error(w, 403, "飞书回调时间无效")
			return
		}
		sum := sha256.Sum256(append([]byte(ts+nonce+c.Config["encrypt_key"]), raw...))
		if subtle.ConstantTimeCompare([]byte(hex.EncodeToString(sum[:])), []byte(r.Header.Get("X-Lark-Signature"))) != 1 {
			shared.Error(w, 403, "飞书回调签名无效")
			return
		}
	}
	plain, e := decryptFeishu(raw, c.Config["encrypt_key"])
	if e != nil {
		shared.Error(w, 400, e.Error())
		return
	}
	var body struct {
		Token     string `json:"token"`
		Challenge string `json:"challenge"`
		OpenID    string `json:"open_id"`
		UserID    string `json:"user_id"`
		Header    struct {
			Token string `json:"token"`
			AppID string `json:"app_id"`
		} `json:"header"`
		Action struct {
			Value map[string]string `json:"value"`
		} `json:"action"`
		Event struct {
			Operator struct {
				OpenID string `json:"open_id"`
				UserID string `json:"user_id"`
			} `json:"operator"`
			Action struct {
				Value map[string]string `json:"value"`
			} `json:"action"`
		} `json:"event"`
	}
	if json.Unmarshal(plain, &body) != nil {
		shared.Error(w, 400, "无效的飞书回调")
		return
	}
	token := body.Token
	if token == "" {
		token = body.Header.Token
	}
	if subtle.ConstantTimeCompare([]byte(token), []byte(c.Config["verification_token"])) != 1 {
		shared.Error(w, 403, "飞书Verification Token无效")
		return
	}
	if body.Header.AppID != "" && body.Header.AppID != c.Config["app_id"] {
		shared.Error(w, 403, "飞书应用不匹配")
		return
	}
	if body.Challenge != "" {
		shared.JSON(w, 200, map[string]string{"challenge": body.Challenge})
		return
	}
	values := body.Action.Value
	openID := body.OpenID
	if body.Event.Action.Value != nil {
		values = body.Event.Action.Value
		openID = body.Event.Operator.OpenID
	}
	if values["action"] != "ack" || openID == "" {
		shared.Error(w, 400, "缺少接手动作或操作人")
		return
	}
	incident, e := m.response(r.Context(), values["response_id"])
	if e != nil {
		shared.Error(w, 404, "告警事件不存在")
		return
	}
	uid := ""
	for _, u := range incident.Group.Members {
		_, p, ok := m.member(r.Context(), u)
		if ok && p.FeishuID == openID {
			if uid != "" {
				shared.Error(w, 409, "飞书身份映射不唯一")
				return
			}
			uid = u
		}
	}
	if uid == "" {
		shared.Error(w, 403, "飞书操作者尚未绑定组成员")
		return
	}
	incident, e = m.acknowledge(r.Context(), incident.ID, uid, "feishu_card", m.now())
	if e != nil {
		shared.JSON(w, 200, map[string]any{"toast": map[string]string{"type": "error", "content": e.Error()}})
		return
	}
	shared.JSON(w, 200, map[string]any{"toast": map[string]string{"type": "success", "content": incident.OwnerName + "已接手"}, "card": map[string]any{"type": "raw", "data": map[string]any{"config": map[string]bool{"wide_screen_mode": true}, "header": map[string]any{"title": map[string]string{"tag": "plain_text", "content": incident.Event.RuleName}, "template": "green"}, "elements": []any{map[string]any{"tag": "div", "text": map[string]string{"tag": "plain_text", "content": incident.OwnerName + "已接手 · " + incident.Priority}}}}}})
}

func (m *Module) aliyunVoiceReceipt(ctx context.Context, c Channel, d Delivery) sendResult {
	params := map[string]string{"Action": "QueryCallDetailByCallId", "Version": "2017-05-25", "Format": "JSON", "AccessKeyId": c.Config["access_key_id"], "SignatureMethod": "HMAC-SHA1", "SignatureVersion": "1.0", "SignatureNonce": id(), "Timestamp": m.now().UTC().Format("2006-01-02T15:04:05Z"), "CallId": d.ProviderID, "ProdId": c.Config["receipt_prod_id"], "QueryDate": strconv.FormatInt(parse(d.CreatedAt).UnixMilli(), 10)}
	if params["ProdId"] == "" {
		params["ProdId"] = "11010000138001"
	}
	params["Signature"] = smsSignature(params, c.Config["access_key_secret"])
	form := url.Values{}
	for k, v := range params {
		form.Set(k, v)
	}
	endpoint := c.Config["endpoint"]
	if endpoint == "" {
		endpoint = "https://dyvmsapi.aliyuncs.com/"
	}
	req, e := http.NewRequestWithContext(ctx, "POST", endpoint, strings.NewReader(form.Encode()))
	if e != nil {
		return sendResult{}
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	data, result := m.phoneRequest(req)
	if result.Status != "" {
		return sendResult{}
	}
	var answer struct {
		Code string
		Data json.RawMessage
	}
	if json.Unmarshal(data, &answer) != nil || answer.Code != "OK" {
		return sendResult{}
	}
	var text string
	if json.Unmarshal(answer.Data, &text) == nil {
		answer.Data = []byte(text)
	}
	var call struct {
		Duration float64 `json:"duration"`
	}
	if json.Unmarshal(answer.Data, &call) != nil {
		return sendResult{}
	}
	if call.Duration > 0 {
		return sendResult{Status: "answered"}
	}
	return sendResult{}
}
