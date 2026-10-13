package alerts

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptrace"
	"net/url"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

func internationalPhone(value string) (string, error) {
	if strings.HasPrefix(value, "0086") {
		value = "+86" + value[4:]
	} else if len(value) == 13 && strings.HasPrefix(value, "86") {
		value = "+" + value
	} else if len(value) == 11 && strings.HasPrefix(value, "1") {
		value = "+86" + value
	}
	digits := strings.TrimPrefix(value, "+")
	if !strings.HasPrefix(value, "+") || len(digits) < 8 || len(digits) > 15 || digits[0] == '0' {
		return "", errors.New("请填写11位国内手机号或带国家代码的号码，例如+8613800000000")
	}
	for _, digit := range digits {
		if digit < '0' || digit > '9' {
			return "", errors.New("号码只能包含数字和开头的加号")
		}
	}
	return value, nil
}

func validateTemplateParams(raw string, array bool) error {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	if array {
		var params []string
		if json.Unmarshal([]byte(raw), &params) != nil || params == nil {
			return errors.New("模板参数必须是JSON字符串数组，例如[\"{{rule}}\",\"{{status}}\"]")
		}
	} else {
		var params map[string]string
		if json.Unmarshal([]byte(raw), &params) != nil || params == nil {
			return errors.New("模板参数必须是JSON字符串对象，例如{\"name\":\"{{rule}}\"}")
		}
	}
	return nil
}

func validatePhoneChannel(typ string, config map[string]string) error {
	var required []string
	switch typ {
	case "aliyun_voice":
		required = []string{"access_key_id", "access_key_secret", "template_code"}
	case "tencent_sms":
		required = []string{"secret_id", "secret_key", "sdk_app_id", "sign_name", "template_id"}
	case "tencent_voice":
		required = []string{"secret_id", "secret_key", "sdk_app_id", "template_id"}
	case "huawei_sms":
		required = []string{"app_key", "app_secret", "endpoint", "sender", "template_id"}
	}
	for _, key := range required {
		if strings.TrimSpace(config[key]) == "" {
			return fmt.Errorf("渠道缺少配置项 %s", key)
		}
	}
	if times := config["play_times"]; times != "" {
		n, e := strconv.Atoi(times)
		if e != nil || n < 1 || n > 3 {
			return errors.New("语音播放次数必须是1到3")
		}
	}
	// Values used in the Huawei quoted authentication header must not escape it.
	if strings.ContainsAny(config["app_key"], "\"\\\r\n") {
		return errors.New("无效的华为云Application Key")
	}
	return validateTemplateParams(config["template_params"], typ != "aliyun_voice")
}

func templateValue(value string, d Delivery) string {
	value = strings.ReplaceAll(value, "{{ack_url}}", d.AckURL)
	value = strings.ReplaceAll(value, "{{priority}}", d.Priority)
	return strings.NewReplacer("{{rule}}", d.Payload.RuleName, "{{status}}", d.Payload.Kind,
		"{{value}}", d.Payload.State.Value, "{{message}}", d.Payload.Message).Replace(value)
}

func objectTemplateParams(raw string, d Delivery) (map[string]string, error) {
	params := map[string]string{"rule": d.Payload.RuleName, "status": d.Payload.Kind, "value": d.Payload.State.Value}
	if strings.TrimSpace(raw) == "" {
		return params, nil
	}
	if e := validateTemplateParams(raw, false); e != nil {
		return nil, e
	}
	// Unmarshal into a fresh map so default names do not leak into custom templates.
	params = map[string]string{}
	_ = json.Unmarshal([]byte(raw), &params)
	for key, value := range params {
		params[key] = templateValue(value, d)
	}
	return params, nil
}

func arrayTemplateParams(raw string, d Delivery) ([]string, error) {
	params := []string{}
	if strings.TrimSpace(raw) == "" {
		return params, nil
	}
	if e := validateTemplateParams(raw, true); e != nil {
		return nil, e
	}
	_ = json.Unmarshal([]byte(raw), &params)
	for i, value := range params {
		params[i] = templateValue(value, d)
	}
	return params, nil
}

// Paid notifications cannot be blindly retried after an ambiguous submission.
func (m *Module) phoneRequest(req *http.Request) ([]byte, sendResult) {
	var wrote atomic.Bool
	req = req.WithContext(httptrace.WithClientTrace(req.Context(), &httptrace.ClientTrace{
		WroteRequest: func(httptrace.WroteRequestInfo) { wrote.Store(true) },
	}))
	resp, e := m.client.Do(req)
	if e != nil {
		if !wrote.Load() {
			return nil, sendResult{Status: "failed", Error: "无法连接通知服务", Retryable: true}
		}
		return nil, sendResult{Status: "unknown", Error: "短信/电话提交结果未知，请核对供应商记录后再重试"}
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusTooManyRequests {
		seconds, _ := strconv.Atoi(resp.Header.Get("Retry-After"))
		return nil, sendResult{Status: "failed", Error: "供应商请求限流", Retryable: true, RetryAfter: time.Duration(seconds) * time.Second}
	}
	if resp.StatusCode >= 500 {
		return nil, sendResult{Status: "unknown", Error: fmt.Sprintf("供应商HTTP %d，提交结果未知", resp.StatusCode)}
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, sendResult{Status: "failed", Error: fmt.Sprintf("供应商HTTP %d", resp.StatusCode)}
	}
	data, e := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if e != nil {
		return nil, sendResult{Status: "unknown", Error: "供应商响应读取失败，提交结果未知"}
	}
	return data, sendResult{}
}

func (m *Module) sendAliyunVoice(ctx context.Context, c Channel, d Delivery) sendResult {
	vars, e := objectTemplateParams(c.Config["template_params"], d)
	if e != nil {
		return sendResult{Status: "failed", Error: e.Error()}
	}
	params := map[string]string{"Action": "SingleCallByTts", "Version": "2017-05-25", "Format": "JSON",
		"AccessKeyId": c.Config["access_key_id"], "SignatureMethod": "HMAC-SHA1", "SignatureVersion": "1.0",
		"SignatureNonce": id(), "Timestamp": m.now().UTC().Format("2006-01-02T15:04:05Z"),
		"CalledNumber": d.Recipient.Value, "TtsCode": c.Config["template_code"], "TtsParam": encode(vars), "OutId": d.ID}
	for key, apiKey := range map[string]string{"called_show_number": "CalledShowNumber", "play_times": "PlayTimes"} {
		if value := c.Config[key]; value != "" {
			params[apiKey] = value
		}
	}
	params["Signature"] = smsSignature(params, c.Config["access_key_secret"])
	form := url.Values{}
	for key, value := range params {
		form.Set(key, value)
	}
	endpoint := c.Config["endpoint"]
	if endpoint == "" {
		endpoint = "https://dyvmsapi.aliyuncs.com/"
	}
	req, e := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	if e != nil {
		return sendResult{Status: "failed", Error: "无效的语音接口地址"}
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	data, result := m.phoneRequest(req)
	if result.Status != "" {
		return result
	}
	var response struct{ Code, CallId string }
	if json.Unmarshal(data, &response) != nil || response.Code == "" {
		return sendResult{Status: "unknown", Error: "阿里云语音响应无效，提交结果未知"}
	}
	if response.Code != "OK" {
		return sendResult{Status: "failed", Error: "阿里云语音业务错误: " + response.Code,
			Retryable: response.Code == "isv.BUSINESS_LIMIT_CONTROL" || response.Code == "Throttling.User"}
	}
	return sendResult{Status: "accepted", ProviderID: response.CallId}
}

func hashSHA256(value []byte) string {
	sum := sha256.Sum256(value)
	return hex.EncodeToString(sum[:])
}

func hmacSHA256(key []byte, value string) []byte {
	h := hmac.New(sha256.New, key)
	_, _ = h.Write([]byte(value))
	return h.Sum(nil)
}

func tencentAuthorization(secretID, secretKey, service, host string, body []byte, now time.Time) string {
	date := now.UTC().Format("2006-01-02")
	scope := date + "/" + service + "/tc3_request"
	canonical := "POST\n/\n\ncontent-type:application/json; charset=utf-8\nhost:" + strings.ToLower(host) + "\n\ncontent-type;host\n" + hashSHA256(body)
	toSign := "TC3-HMAC-SHA256\n" + strconv.FormatInt(now.Unix(), 10) + "\n" + scope + "\n" + hashSHA256([]byte(canonical))
	key := hmacSHA256([]byte("TC3"+secretKey), date)
	key = hmacSHA256(key, service)
	key = hmacSHA256(key, "tc3_request")
	signature := hex.EncodeToString(hmacSHA256(key, toSign))
	return "TC3-HMAC-SHA256 Credential=" + secretID + "/" + scope + ", SignedHeaders=content-type;host, Signature=" + signature
}

func (m *Module) sendTencent(ctx context.Context, c Channel, d Delivery) sendResult {
	params, e := arrayTemplateParams(c.Config["template_params"], d)
	if e != nil {
		return sendResult{Status: "failed", Error: e.Error()}
	}
	phone, e := internationalPhone(d.Recipient.Value)
	if e != nil {
		return sendResult{Status: "failed", Error: e.Error()}
	}
	service, action, version := "sms", "SendSms", "2021-01-11"
	body := map[string]any{"SmsSdkAppId": c.Config["sdk_app_id"], "PhoneNumberSet": []string{phone},
		"SignName": c.Config["sign_name"], "TemplateId": c.Config["template_id"], "TemplateParamSet": params, "SessionContext": d.ID}
	if c.Type == "tencent_voice" {
		service, action, version = "vms", "SendTtsVoice", "2020-09-02"
		body = map[string]any{"VoiceSdkAppid": c.Config["sdk_app_id"], "CalledNumber": phone,
			"TemplateId": c.Config["template_id"], "TemplateParamSet": params, "SessionContext": d.ID}
		if c.Config["play_times"] != "" {
			times, _ := strconv.Atoi(c.Config["play_times"])
			body["PlayTimes"] = times
		}
	}
	endpoint := c.Config["endpoint"]
	if endpoint == "" {
		endpoint = "https://" + service + ".tencentcloudapi.com/"
	}
	raw := []byte(encode(body))
	req, e := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(raw))
	if e != nil {
		return sendResult{Status: "failed", Error: "无效的腾讯云接口地址"}
	}
	now := m.now()
	req.Header.Set("Content-Type", "application/json; charset=utf-8")
	req.Header.Set("Authorization", tencentAuthorization(c.Config["secret_id"], c.Config["secret_key"], service, req.URL.Host, raw, now))
	req.Header.Set("X-TC-Action", action)
	req.Header.Set("X-TC-Version", version)
	req.Header.Set("X-TC-Timestamp", strconv.FormatInt(now.Unix(), 10))
	region := c.Config["region"]
	if region == "" {
		region = "ap-guangzhou"
	}
	req.Header.Set("X-TC-Region", region)
	data, result := m.phoneRequest(req)
	if result.Status != "" {
		return result
	}
	var response struct {
		Response *struct {
			Error         *struct{ Code string }
			SendStatus    *struct{ CallId string }
			SendStatusSet []struct{ Code, SerialNo string }
		}
	}
	if json.Unmarshal(data, &response) != nil || response.Response == nil {
		return sendResult{Status: "unknown", Error: "腾讯云响应无效，提交结果未知"}
	}
	r := response.Response
	code := ""
	if r.Error != nil {
		code = r.Error.Code
		if code == "" {
			return sendResult{Status: "unknown", Error: "腾讯云响应缺少错误码"}
		}
	} else if c.Type == "tencent_voice" && r.SendStatus != nil && r.SendStatus.CallId != "" {
		return sendResult{Status: "accepted", ProviderID: r.SendStatus.CallId}
	} else if c.Type == "tencent_sms" && len(r.SendStatusSet) == 1 {
		code = r.SendStatusSet[0].Code
		if code == "Ok" {
			return sendResult{Status: "accepted", ProviderID: r.SendStatusSet[0].SerialNo}
		}
	}
	if code == "" {
		return sendResult{Status: "unknown", Error: "腾讯云响应缺少发送状态，提交结果未知"}
	}
	// SendAndRecvFail can hide a successful submission; do not automatically retry it.
	if code == "InternalError.SendAndRecvFail" {
		return sendResult{Status: "unknown", Error: "腾讯云业务结果未知: " + code}
	}
	return sendResult{Status: "failed", Error: "腾讯云业务错误: " + code,
		Retryable: code == "RequestLimitExceeded" || code == "RequestLimitExceeded.SmsSendFreqLimit"}
}

func (m *Module) sendHuaweiSMS(ctx context.Context, c Channel, d Delivery) sendResult {
	params, e := arrayTemplateParams(c.Config["template_params"], d)
	if e != nil {
		return sendResult{Status: "failed", Error: e.Error()}
	}
	phone, e := internationalPhone(d.Recipient.Value)
	if e != nil {
		return sendResult{Status: "failed", Error: e.Error()}
	}
	endpoint := strings.TrimRight(c.Config["endpoint"], "/")
	if !strings.HasSuffix(endpoint, "/sms/batchSendSms/v1") {
		endpoint += "/sms/batchSendSms/v1"
	}
	form := url.Values{"from": {c.Config["sender"]}, "to": {phone}, "templateId": {c.Config["template_id"]}, "templateParas": {encode(params)}}
	if c.Config["signature"] != "" {
		form.Set("signature", c.Config["signature"])
	}
	req, e := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	if e != nil {
		return sendResult{Status: "failed", Error: "无效的华为云接口地址"}
	}
	nonce, created := id(), m.now().UTC().Format("2006-01-02T15:04:05Z")
	// Huawei's documented X-WSSE digest encodes the hexadecimal SHA256 string.
	digest := base64.StdEncoding.EncodeToString([]byte(hashSHA256([]byte(nonce + created + c.Config["app_secret"]))))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Authorization", `WSSE realm="SDP",profile="UsernameToken",type="Appkey"`)
	req.Header.Set("X-WSSE", fmt.Sprintf(`UsernameToken Username="%s",PasswordDigest="%s",Nonce="%s",Created="%s"`, c.Config["app_key"], digest, nonce, created))
	data, result := m.phoneRequest(req)
	if result.Status != "" {
		return result
	}
	var response struct {
		Code   string
		Result []struct{ Status, SmsMsgId string }
	}
	if json.Unmarshal(data, &response) != nil || response.Code == "" {
		return sendResult{Status: "unknown", Error: "华为云短信响应无效，提交结果未知"}
	}
	if response.Code != "000000" {
		return sendResult{Status: "failed", Error: "华为云短信业务错误: " + response.Code}
	}
	if len(response.Result) != 1 || response.Result[0].Status == "" {
		return sendResult{Status: "unknown", Error: "华为云短信响应缺少发送状态"}
	}
	if response.Result[0].Status != "000000" {
		return sendResult{Status: "failed", Error: "华为云短信目标错误: " + response.Result[0].Status}
	}
	return sendResult{Status: "accepted", ProviderID: response.Result[0].SmsMsgId}
}
