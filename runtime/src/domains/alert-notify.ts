import { parseJSON } from "../shared/json.js";
import {
  createHash,
  createHmac,
  createDecipheriv,
  timingSafeEqual,
} from "node:crypto";
import nodemailer from "nodemailer";
import type { Context } from "../shared/types.js";
import type { Alerts } from "./alerts.js";
import { bytes, clone, encode, hash, id, parseTime, stamp } from "./common.js";
export const secretFields = new Set([
  "url",
  "secret",
  "token",
  "password",
  "access_key",
  "access_key_id",
  "access_key_secret",
  "headers",
  "secret_id",
  "secret_key",
  "app_key",
  "app_secret",
  "callback_token",
  "verification_token",
  "encrypt_key",
]);
export const channelTypes = new Set([
  "webhook",
  "feishu",
  "feishu_app",
  "dingtalk",
  "wecom",
  "pushplus",
  "smtp",
  "aliyun_sms",
  "aliyun_voice",
  "tencent_sms",
  "tencent_voice",
  "huawei_sms",
]);
export const channelMethod = (typ: string) =>
  typ === "smtp"
    ? "email"
    : ["aliyun_sms", "tencent_sms", "huawei_sms"].includes(typ)
      ? "sms"
      : ["aliyun_voice", "tencent_voice"].includes(typ)
        ? "voice"
        : ["feishu", "feishu_app", "dingtalk", "wecom"].includes(typ)
          ? "chat"
          : typ === "pushplus"
            ? "push"
            : "webhook";
export const recipientKey = (p: any) =>
  encode({ kind: p.kind, value: p.value ?? "", mentions: null });
export const rateKey = (c: any) =>
  hash(
    (c?.type ?? "") +
      ((c?.config?.token ?? "") +
        (c?.config?.access_key_id ?? "") +
        (c?.config?.username ?? "") +
        (c?.config?.secret_id ?? "") +
        (c?.config?.app_key ?? "") ||
        c?.config?.url ||
        ""),
  );
const equal = (a: string, b: string) =>
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
export function internationalPhone(v: string): string {
  if (v.startsWith("0086")) v = "+86" + v.slice(4);
  else if (/^86\d{11}$/.test(v)) v = "+" + v;
  else if (/^1\d{10}$/.test(v)) v = "+86" + v;
  if (!/^\+[1-9]\d{7,14}$/.test(v))
    throw Error("请填写11位国内手机号或带国家代码的号码，例如+8613800000000");
  return v;
}
export function validateRecipient(typ: string, p: any): void {
  p.value = String(p.value ?? "").trim();
  p.mentions = (p.mentions ?? []).sort();
  if (typ === "feishu_app") {
    if (p.kind !== "feishu_user" || !p.value)
      throw Error("飞书企业应用目标需要用户open_id");
  } else if (typ === "smtp") {
    if (p.kind !== "email") throw Error("SMTP目标必须是邮箱");
    const m = p.value.match(
      /^(?:[^<>\r\n]+<)?([^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)>?$/,
    );
    if (!m) throw Error("invalid email");
    p.value = m[1];
  } else if (
    [
      "aliyun_sms",
      "aliyun_voice",
      "tencent_sms",
      "tencent_voice",
      "huawei_sms",
    ].includes(typ)
  ) {
    if (p.kind !== "phone" || !/^\+?\d{8,15}$/.test(p.value))
      throw Error("短信/电话目标必须是单个号码");
    if (["tencent_sms", "tencent_voice", "huawei_sms"].includes(typ))
      p.value = internationalPhone(p.value);
    else p.value = p.value.replace(/^\+86(?=\d{11}$)/, "");
  } else if (typ === "pushplus") {
    if (
      !["self", "topic", "friend"].includes(p.kind) ||
      (p.kind !== "self" && !p.value)
    )
      throw Error("pushplus目标必须是self/topic/friend");
  } else {
    if (p.kind !== "channel") throw Error("机器人/Webhook使用channel目标");
    p.value = "bound";
  }
}
export function validateTemplate(raw: string, array: boolean): any {
  if (!raw?.trim()) return array ? [] : {};
  let v;
  try {
    v = parseJSON(raw);
  } catch {
    throw Error(
      array ? "模板参数必须是JSON字符串数组" : "模板参数必须是JSON字符串对象",
    );
  }
  if (
    array
      ? !Array.isArray(v) || v.some((x: any) => typeof x !== "string")
      : !v ||
        Array.isArray(v) ||
        typeof v !== "object" ||
        Object.values(v).some((x) => typeof x !== "string")
  )
    throw Error(
      array ? "模板参数必须是JSON字符串数组" : "模板参数必须是JSON字符串对象",
    );
  return v;
}
export function validateChannel(typ: string, c: any): void {
  const rate = Number(c.rate_per_minute);
  if (c.rate_per_minute && (!Number.isInteger(rate) || rate < 1 || rate >= 600))
    throw Error("每分钟发送上限必须在1到599之间");
  const endpoint = (s: string) => {
    let u: URL;
    try {
      u = new URL(s);
    } catch {
      throw Error("接口地址必须是有效的HTTP(S)地址");
    }
    if (
      !["http:", "https:"].includes(u.protocol) ||
      !u.hostname ||
      u.username ||
      u.password
    )
      throw Error("接口地址必须是有效的HTTP(S)地址");
    return u;
  };
  if (c.endpoint) {
    const u = endpoint(c.endpoint);
    if (typ.startsWith("tencent_") && (u.pathname !== "/" || u.search))
      throw Error("腾讯云接口地址必须使用根路径且不含查询参数");
  }
  let required: string[] = [];
  if (typ === "smtp") {
    required = ["host", "from"];
    if (!["starttls", "tls", "none"].includes(c.tls))
      throw Error("SMTP TLS mode is starttls/tls/none");
    validateRecipient("smtp", { kind: "email", value: c.from });
    if (
      c.port &&
      (!/^\d+$/.test(c.port) || Number(c.port) < 1 || Number(c.port) > 65535)
    )
      throw Error("SMTP端口必须在1到65535之间");
  } else if (typ === "aliyun_sms")
    required = [
      "access_key_id",
      "access_key_secret",
      "sign_name",
      "template_code",
    ];
  else if (typ === "aliyun_voice")
    required = ["access_key_id", "access_key_secret", "template_code"];
  else if (typ === "tencent_sms")
    required = [
      "secret_id",
      "secret_key",
      "sdk_app_id",
      "sign_name",
      "template_id",
    ];
  else if (typ === "tencent_voice")
    required = ["secret_id", "secret_key", "sdk_app_id", "template_id"];
  else if (typ === "huawei_sms")
    required = ["app_key", "app_secret", "endpoint", "sender", "template_id"];
  else if (typ === "feishu_app") {
    required = ["app_id", "app_secret", "verification_token"];
    if (c.api_base) endpoint(c.api_base);
  } else if (typ === "pushplus") {
    required = ["token"];
    if (!["wechat", "app"].includes(c.push_channel))
      throw Error("pushplus channel is wechat or app");
  } else endpoint(c.url);
  for (const k of required)
    if (!String(c[k] ?? "").trim()) throw Error(`渠道缺少配置项 ${k}`);
  if (c.play_times && !/^[1-3]$/.test(c.play_times))
    throw Error("语音播放次数必须是1到3");
  if (/["\\\r\n]/.test(c.app_key ?? ""))
    throw Error("无效的华为云Application Key");
  if (
    [
      "aliyun_sms",
      "aliyun_voice",
      "tencent_sms",
      "tencent_voice",
      "huawei_sms",
    ].includes(typ)
  )
    validateTemplate(
      c.template_params,
      typ.startsWith("tencent_") || typ === "huawei_sms",
    );
}
export function templateValue(value: string, d: any): string {
  const vars: any = {
    ack_url: d.ack_url ?? "",
    priority: d.priority ?? "",
    rule: d.payload.rule_name ?? "",
    status: d.payload.kind ?? "",
    value: d.payload.state?.value ?? "",
    message: d.payload.message ?? "",
  };
  return value.replace(
    /\{\{(ack_url|priority|rule|status|value|message)\}\}/g,
    (_, key) => vars[key],
  );
}
export function objectTemplate(raw: string, d: any): any {
  if (!raw?.trim())
    return {
      rule: d.payload.rule_name,
      status: d.payload.kind,
      value: d.payload.state?.value ?? "",
    };
  return Object.fromEntries(
    Object.entries<string>(validateTemplate(raw, false)).map(([k, v]) => [
      k,
      templateValue(v, d),
    ]),
  );
}
export const arrayTemplate = (raw: string, d: any) =>
  (validateTemplate(raw, true) as string[]).map((v) => templateValue(v, d));
const percent = (v: string) =>
  encodeURIComponent(v).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
export function smsSignature(
  p: Record<string, string>,
  secret: string,
): string {
  const canonical = Object.keys(p)
    .sort()
    .map((k) => percent(k) + "=" + percent(p[k]))
    .join("&");
  return createHmac("sha1", secret + "&")
    .update("POST&%2F&" + percent(canonical))
    .digest("base64");
}
export function tencentAuthorization(
  secretID: string,
  secretKey: string,
  service: string,
  host: string,
  body: string,
  now: Date,
): string {
  const date = now.toISOString().slice(0, 10),
    scope = date + "/" + service + "/tc3_request",
    canonical =
      "POST\n/\n\ncontent-type:application/json; charset=utf-8\nhost:" +
      host.toLowerCase() +
      "\n\ncontent-type;host\n" +
      hash(body),
    sign =
      "TC3-HMAC-SHA256\n" +
      Math.floor(now.getTime() / 1000) +
      "\n" +
      scope +
      "\n" +
      hash(canonical);
  let key: Buffer = Buffer.from("TC3" + secretKey);
  for (const s of [date, service, "tc3_request"])
    key = createHmac("sha256", key).update(s).digest();
  return (
    "TC3-HMAC-SHA256 Credential=" +
    secretID +
    "/" +
    scope +
    ", SignedHeaders=content-type;host, Signature=" +
    createHmac("sha256", key).update(sign).digest("hex")
  );
}
export interface SendResult {
  status?: string;
  provider_id?: string;
  error?: string;
  retryable?: boolean;
  retry_after?: number;
  block_account?: boolean;
}
export function responseCard(d: any, text: string, interactive: boolean): any {
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      title: { tag: "plain_text", content: d.payload.rule_name },
      template: "red",
    },
    elements: [
      { tag: "div", text: { tag: "plain_text", content: text } },
      ...(d.recipient.mentions?.length
        ? [
            {
              tag: "div",
              text: {
                tag: "lark_md",
                content:
                  "值班人员：" +
                  d.recipient.mentions
                    .map((v: string) => '<at id="' + escapeHTML(v) + '"></at>')
                    .join(" "),
              },
            },
          ]
        : []),
      ...(d.ack_url || interactive
        ? [
            {
              tag: "action",
              actions: [
                {
                  tag: "button",
                  text: { tag: "plain_text", content: "开始处理" },
                  type: "primary",
                  ...(interactive
                    ? { value: { response_id: d.response_id, action: "ack" } }
                    : { url: d.ack_url }),
                },
              ],
            },
          ]
        : []),
    ],
  };
}
const escapeHTML = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      (
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&#34;",
          "'": "&#39;",
        }) as any
      )[c],
  );
export class Notifications {
  constructor(
    readonly m: Alerts,
    readonly fetcher: typeof fetch = fetch,
  ) {}
  evidenceText(d: any): string {
    const logs = d.response_id
      ? this.m.response(d.response_id)?.evidence?.logs
      : undefined;
    return logs?.length
      ? "\n现场日志：" +
          logs
            .slice(0, 3)
            .map(
              (v: any) => "\n" + v.event_time + " " + v.severity + " " + v.body,
            )
            .join("")
      : "";
  }
  async request(
    endpoint: string,
    options: RequestInit,
    paid = false,
  ): Promise<{
    data?: any;
    response?: Response;
    result?: SendResult;
  }> {
    try {
      const response = await this.fetcher(endpoint, {
        ...options,
        redirect: "error",
        signal: AbortSignal.any([
          this.m.controller.signal,
          AbortSignal.timeout(10000),
        ]),
      });
      if (!response.ok) {
        const retry = response.status === 429 || response.status >= 500;
        return {
          response,
          result: {
            status: paid && response.status >= 500 ? "unknown" : "failed",
            error: `HTTP ${response.status}`,
            retryable: paid ? response.status === 429 : retry,
            retry_after:
              Number(response.headers.get("retry-after") || 0) * 1000,
          },
        };
      }
      let used = 0;
      const chunks: Uint8Array[] = [];
      if (response.body) {
        const reader = response.body.getReader();
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          used += part.value.byteLength;
          if (used > 1 << 20) {
            await reader.cancel();
            return {
              result: {
                status: "unknown",
                error: "供应商响应超限，提交结果未知",
              },
            };
          }
          chunks.push(part.value);
        }
      }
      const text = Buffer.concat(chunks).toString();
      let data: any;
      try {
        data = text ? parseJSON(text) : undefined;
      } catch {
        data = undefined;
      }
      return { response, data };
    } catch (e) {
      const code = (e as any)?.cause?.code,
        safe = [
          "ECONNREFUSED",
          "ENOTFOUND",
          "EAI_AGAIN",
          "UND_ERR_CONNECT_TIMEOUT",
        ].includes(code);
      return {
        result: {
          status: safe ? "failed" : "unknown",
          error: safe
            ? "无法连接通知服务，等待重试"
            : "网络请求结果不确定，可能已被受理",
          retryable: safe,
        },
      };
    }
  }
  async aliyun(
    c: any,
    action: string,
    params: Record<string, string>,
    voice = false,
  ): Promise<SendResult> {
    const cfg = c.config,
      p = {
        ...params,
        Action: action,
        Version: "2017-05-25",
        Format: "JSON",
        AccessKeyId: cfg.access_key_id,
        SignatureMethod: "HMAC-SHA1",
        SignatureVersion: "1.0",
        SignatureNonce: id(),
        Timestamp: this.m
          .now()
          .toISOString()
          .replace(/\.\d{3}Z$/, "Z"),
      } as Record<string, string>;
    p.Signature = smsSignature(p, cfg.access_key_secret);
    const { data, result } = await this.request(
      cfg.endpoint ||
        (voice
          ? "https://dyvmsapi.aliyuncs.com/"
          : "https://dysmsapi.aliyuncs.com/"),
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(p).toString(),
      },
      true,
    );
    if (result) return action.startsWith("Query") ? {} : result;
    if (!data?.Code)
      return { status: "unknown", error: "阿里云响应无效，提交结果未知" };
    if (data.Code !== "OK")
      return {
        status: "failed",
        error: "阿里云业务错误: " + data.Code,
        retryable: [
          "isv.BUSINESS_LIMIT_CONTROL",
          "isv.SYSTEM_ERROR",
          "Throttling.User",
        ].includes(data.Code),
      };
    if (action === "QuerySendDetails") {
      for (const d of data.SmsSendDetailDTOs?.SmsSendDetailDTO ?? []) {
        if (d.SendStatus === 3) return { status: "confirmed" };
        if (d.SendStatus === 2)
          return { status: "failed", error: "短信最终发送失败: " + d.ErrCode };
      }
      return {};
    }
    if (action === "QueryCallDetailByCallId") {
      let d = data.Data;
      if (typeof d === "string")
        try {
          d = parseJSON(d);
        } catch {
          return {};
        }
      return d?.duration > 0 ? { status: "answered" } : {};
    }
    return {
      status: "accepted",
      provider_id: voice ? data.CallId : data.BizId,
    };
  }
  async sendTencent(c: any, d: any): Promise<SendResult> {
    const cfg = c.config,
      voice = c.type === "tencent_voice",
      service = voice ? "vms" : "sms",
      endpoint = cfg.endpoint || "https://" + service + ".tencentcloudapi.com/",
      phone = internationalPhone(d.recipient.value),
      params = arrayTemplate(cfg.template_params, d),
      body: any = voice
        ? {
            VoiceSdkAppid: cfg.sdk_app_id,
            CalledNumber: phone,
            TemplateId: cfg.template_id,
            TemplateParamSet: params,
            SessionContext: d.id,
          }
        : {
            SmsSdkAppId: cfg.sdk_app_id,
            PhoneNumberSet: [phone],
            SignName: cfg.sign_name,
            TemplateId: cfg.template_id,
            TemplateParamSet: params,
            SessionContext: d.id,
          };
    if (voice && cfg.play_times) body.PlayTimes = Number(cfg.play_times);
    const raw = encode(body),
      now = this.m.now(),
      headers = {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: tencentAuthorization(
          cfg.secret_id,
          cfg.secret_key,
          service,
          new URL(endpoint).host,
          raw,
          now,
        ),
        "X-TC-Action": voice ? "SendTtsVoice" : "SendSms",
        "X-TC-Version": voice ? "2020-09-02" : "2021-01-11",
        "X-TC-Timestamp": String(Math.floor(now.getTime() / 1000)),
        "X-TC-Region": cfg.region || "ap-guangzhou",
      },
      out = await this.request(
        endpoint,
        { method: "POST", headers, body: raw },
        true,
      );
    if (out.result) return out.result;
    const r = out.data?.Response;
    if (!r) return { status: "unknown", error: "腾讯云响应无效，提交结果未知" };
    let code = r.Error?.Code;
    if (!r.Error && voice && r.SendStatus?.CallId)
      return { status: "accepted", provider_id: r.SendStatus.CallId };
    if (!r.Error && !voice && r.SendStatusSet?.length === 1) {
      code = r.SendStatusSet[0].Code;
      if (code === "Ok")
        return { status: "accepted", provider_id: r.SendStatusSet[0].SerialNo };
    }
    if (!code || code === "InternalError.SendAndRecvFail")
      return { status: "unknown", error: "腾讯云业务结果未知" };
    return {
      status: "failed",
      error: "腾讯云业务错误: " + code,
      retryable: [
        "RequestLimitExceeded",
        "RequestLimitExceeded.SmsSendFreqLimit",
      ].includes(code),
    };
  }
  async sendHuawei(c: any, d: any): Promise<SendResult> {
    const cfg = c.config;
    let endpoint = cfg.endpoint.replace(/\/$/, "");
    if (!endpoint.endsWith("/sms/batchSendSms/v1"))
      endpoint += "/sms/batchSendSms/v1";
    const form = new URLSearchParams({
      from: cfg.sender,
      to: internationalPhone(d.recipient.value),
      templateId: cfg.template_id,
      templateParas: encode(arrayTemplate(cfg.template_params, d)),
    });
    if (cfg.signature) form.set("signature", cfg.signature);
    const nonce = id(),
      created = this.m
        .now()
        .toISOString()
        .replace(/\.\d{3}Z$/, "Z"),
      digest = Buffer.from(hash(nonce + created + cfg.app_secret)).toString(
        "base64",
      ),
      out = await this.request(
        endpoint,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization:
              'WSSE realm="SDP",profile="UsernameToken",type="Appkey"',
            "X-WSSE": `UsernameToken Username="${cfg.app_key}",PasswordDigest="${digest}",Nonce="${nonce}",Created="${created}"`,
          },
          body: form.toString(),
        },
        true,
      );
    if (out.result) return out.result;
    const r = out.data;
    if (!r?.code)
      return { status: "unknown", error: "华为云短信响应无效，提交结果未知" };
    if (r.code !== "000000")
      return { status: "failed", error: "华为云短信业务错误: " + r.code };
    if (r.result?.length !== 1 || !r.result[0].status)
      return { status: "unknown", error: "华为云短信响应缺少发送状态" };
    if (r.result[0].status !== "000000")
      return {
        status: "failed",
        error: "华为云短信目标错误: " + r.result[0].status,
      };
    return { status: "accepted", provider_id: r.result[0].smsMsgId };
  }
  async sendSMTP(c: any, d: any): Promise<SendResult> {
    const cfg = c.config,
      transport = nodemailer.createTransport({
        host: cfg.host,
        port: Number(cfg.port || 587),
        secure: cfg.tls === "tls",
        requireTLS: cfg.tls === "starttls",
        ignoreTLS: cfg.tls === "none",
        tls: { minVersion: "TLSv1.2", servername: cfg.host },
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 10000,
        ...(cfg.username
          ? { auth: { user: cfg.username, pass: cfg.password ?? "" } }
          : {}),
      });
    const stop = () => transport.close();
    this.m.controller.signal.addEventListener("abort", stop, { once: true });
    try {
      await transport.sendMail({
        from: cfg.from,
        to: d.recipient.value,
        subject: (d.payload.rule_name + " · " + d.payload.kind).replace(
          /[\r\n]/g,
          " ",
        ),
        text:
          d.payload.message +
          this.evidenceText(d) +
          (d.ack_url ? "\n开始处理：" + d.ack_url : ""),
        messageId: "<" + d.id + "@lightmoni>",
      });
      return { status: "accepted" };
    } catch (e) {
      const err = e as any,
        code = err.responseCode;
      if (
        err.command === "DATA" ||
        (err.command === "CONN" && err.code === "ESOCKET")
      )
        return { status: "unknown", error: "SMTP未确认邮件提交" };
      return {
        status: "failed",
        error: code ? "SMTP拒绝消息 (" + code + ")" : "SMTP连接或认证失败",
        retryable: code
          ? code >= 400 && code < 500
          : ["ECONNECTION", "ETIMEDOUT", "EDNS"].includes(err.code),
      };
    } finally {
      this.m.controller.signal.removeEventListener("abort", stop);
      transport.close();
    }
  }
  async sendFeishuApp(c: any, d: any): Promise<SendResult> {
    const cfg = c.config,
      base = (cfg.api_base || "https://open.feishu.cn").replace(/\/$/, ""),
      auth = await this.request(
        base + "/open-apis/auth/v3/tenant_access_token/internal",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: encode({ app_id: cfg.app_id, app_secret: cfg.app_secret }),
        },
        true,
      );
    if (auth.result) return auth.result;
    if (auth.data?.code !== 0 || !auth.data.tenant_access_token)
      return { status: "failed", error: "飞书应用凭证被拒绝" };
    const card = responseCard(
      d,
      d.payload.message + this.evidenceText(d),
      !!d.ack_url,
    );
    if (!d.response_id)
      card.elements = [
        { tag: "div", text: { tag: "plain_text", content: d.payload.message } },
      ];
    const out = await this.request(
      base + "/open-apis/im/v1/messages?receive_id_type=open_id",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + auth.data.tenant_access_token,
        },
        body: encode({
          receive_id: d.recipient.value,
          msg_type: "interactive",
          content: encode(card),
          uuid: d.id,
        }),
      },
      true,
    );
    if (out.result) return out.result;
    if (out.data?.code === undefined)
      return { status: "unknown", error: "飞书响应结果未知" };
    if (out.data.code !== 0)
      return {
        status: "failed",
        error: "飞书发送错误" + out.data.code,
        retryable: out.data.code === 99991400,
      };
    return { status: "accepted", provider_id: out.data.data?.message_id };
  }
  async send(c: any, d: any): Promise<SendResult> {
    const cfg = c.config;
    try {
      if (c.type === "smtp") return await this.sendSMTP(c, d);
      if (c.type === "feishu_app") return await this.sendFeishuApp(c, d);
      if (c.type.startsWith("tencent_")) return await this.sendTencent(c, d);
      if (c.type === "huawei_sms") return await this.sendHuawei(c, d);
      if (c.type === "aliyun_sms")
        return await this.aliyun(c, "SendSms", {
          PhoneNumbers: d.recipient.value,
          SignName: cfg.sign_name,
          TemplateCode: cfg.template_code,
          TemplateParam: encode(objectTemplate(cfg.template_params, d)),
        });
      if (c.type === "aliyun_voice") {
        const p: Record<string, string> = {
          CalledNumber: d.recipient.value,
          TtsCode: cfg.template_code,
          TtsParam: encode(objectTemplate(cfg.template_params, d)),
          OutId: d.id,
        };
        if (cfg.called_show_number) p.CalledShowNumber = cfg.called_show_number;
        if (cfg.play_times) p.PlayTimes = cfg.play_times;
        return await this.aliyun(c, "SingleCallByTts", p, true);
      }
      let endpoint = cfg.url,
        text = d.payload.message + this.evidenceText(d),
        body: any = {};
      if (this.m.deps.externalURL)
        text += "\n" + this.m.deps.externalURL.replace(/\/$/, "") + "/alerts";
      const now = this.m.now();
      if (c.type === "feishu") {
        for (const v of d.recipient.mentions ?? [])
          text += '\n<at user_id="' + escapeHTML(v) + '"></at>';
        body = d.ack_url
          ? { msg_type: "interactive", card: responseCard(d, text, false) }
          : { msg_type: "text", content: { text } };
        if (cfg.secret) {
          const timestamp = String(Math.floor(now.getTime() / 1000));
          body.timestamp = timestamp;
          body.sign = createHmac(
            "sha256",
            timestamp + "\n" + cfg.secret,
          ).digest("base64");
        }
      } else if (c.type === "dingtalk") {
        const mentions = d.recipient.mentions ?? [],
          at = {
            atMobiles: mentions.filter((v: string) => /^1\d{10}$/.test(v)),
            atUserIds: mentions.filter((v: string) => !/^1\d{10}$/.test(v)),
          };
        body = d.ack_url
          ? {
              msgtype: "actionCard",
              actionCard: {
                title: d.payload.rule_name,
                text,
                singleTitle: "开始处理",
                singleURL: d.ack_url,
              },
              at,
            }
          : { msgtype: "text", text: { content: text }, at };
        if (cfg.secret) {
          const u = new URL(endpoint),
            ts = String(now.getTime());
          u.searchParams.set("timestamp", ts);
          u.searchParams.set(
            "sign",
            createHmac("sha256", cfg.secret)
              .update(ts + "\n" + cfg.secret)
              .digest("base64"),
          );
          endpoint = u.toString();
        }
      } else if (c.type === "wecom") {
        body = {
          msgtype: "text",
          text: { content: text, mentioned_list: d.recipient.mentions ?? [] },
        };
        if (d.ack_url) {
          for (const v of d.recipient.mentions ?? [])
            text += "\n<@" + escapeHTML(v) + ">";
          body = {
            msgtype: "markdown",
            markdown: { content: text + "\n[开始处理](" + d.ack_url + ")" },
          };
        }
      } else if (c.type === "pushplus") {
        endpoint = cfg.endpoint || "https://www.pushplus.plus/send";
        body = {
          token: cfg.token,
          title: d.payload.rule_name,
          content: text,
          channel: cfg.push_channel,
          template: "txt",
        };
        if (d.recipient.kind === "topic") body.topic = d.recipient.value;
        if (d.recipient.kind === "friend") body.to = d.recipient.value;
      } else
        body = {
          event_id: d.event_id,
          notification_id: d.id,
          event: d.payload,
          recipient: d.recipient,
          response_id: d.response_id || "",
          ack_url: d.ack_url || "",
          priority: d.priority || "",
        };
      const raw = encode(body),
        headers: Record<string, string> = {
          "Content-Type": "application/json",
          "X-LightMoni-Event-ID": d.event_id,
        };
      if (c.type === "webhook") {
        if (cfg.headers) {
          const h = parseJSON(cfg.headers);
          for (const [k, v] of Object.entries(h)) {
            if (typeof v !== "string")
              return { status: "failed", error: "invalid headers JSON" };
            headers[k] = v;
          }
        }
        if (cfg.secret)
          headers["X-LightMoni-Signature"] =
            "sha256=" +
            createHmac("sha256", cfg.secret).update(raw).digest("hex");
      }
      const out = await this.request(endpoint, {
        method: "POST",
        headers,
        body: raw,
      });
      if (out.result) return out.result;
      if (c.type === "webhook") return { status: "accepted" };
      const code =
        out.data?.[
          c.type === "feishu" || c.type === "pushplus" ? "code" : "errcode"
        ];
      if (!Number.isInteger(code))
        return { status: "failed", error: "供应商响应缺少业务状态码" };
      if (code !== (c.type === "pushplus" ? 200 : 0))
        return {
          status: "failed",
          error: "供应商业务错误 " + code,
          retryable:
            [99991400, 45009, 130101, 90002].includes(code) ||
            (c.type === "pushplus" && code === 500),
          block_account: c.type === "pushplus" && code === 900,
        };
      return {
        status: "accepted",
        provider_id: c.type === "pushplus" ? out.data.data : undefined,
      };
    } catch {
      return { status: "failed", error: "无效的通知渠道配置" };
    }
  }
  async receipt(c: any, d: any): Promise<SendResult> {
    if (c.type === "aliyun_sms" && d.provider_id)
      return this.aliyun(c, "QuerySendDetails", {
        PhoneNumber: d.recipient.value,
        BizId: d.provider_id,
        SendDate: new Date(parseTime(d.created_at))
          .toISOString()
          .slice(0, 10)
          .replaceAll("-", ""),
        PageSize: "10",
        CurrentPage: "1",
      });
    if (c.type === "aliyun_voice" && d.provider_id)
      return this.aliyun(
        c,
        "QueryCallDetailByCallId",
        {
          CallId: d.provider_id,
          ProdId: c.config.receipt_prod_id || "11010000138001",
          QueryDate: String(parseTime(d.created_at)),
        },
        true,
      );
    if (c.type === "pushplus" && d.provider_id && c.config.access_key) {
      const u = new URL(
        c.config.receipt_endpoint ||
          "https://www.pushplus.plus/api/open/message/sendMessageResult",
      );
      u.searchParams.set("shortCode", d.provider_id);
      const out = await this.request(u.toString(), {
        headers: { "access-key": c.config.access_key },
      });
      if (out.data?.code === 200) {
        if (out.data.data?.status === 2) return { status: "confirmed" };
        if (out.data.data?.status === 3)
          return {
            status: "failed",
            error: "pushplus最终发送失败: " + out.data.data.errorMessage,
          };
      }
    }
    return {};
  }
  async sendPending(): Promise<void> {
    const m = this.m,
      db = m.deps.db,
      now = m.now(),
      rows = db.all<any>(
        "SELECT body,status,next_attempt FROM alert_outbox WHERE status IN ('queued','retry','accepted') AND next_attempt<>'' AND next_attempt<=? ORDER BY CASE json_extract(body,'$.priority') WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3 ELSE 4 END,created_at,rowid LIMIT 100",
        stamp(now),
      ),
      accounts = new Set<string>(),
      jobs: Promise<void>[] = [];
    db.run(
      "DELETE FROM alert_send_attempts WHERE attempted_at<?",
      stamp(new Date(now.getTime() - 300000)),
    );
    for (const row of rows) {
      const d = parseJSON(row.body);
      d.status = row.status;
      d.next_attempt = row.next_attempt;
      if (parseTime(d.next_attempt) > now.getTime()) continue;
      const c = m.channel(d.channel_id, true);
      if (!c?.enabled) {
        if (d.status === "accepted") {
          d.next_attempt = "";
          d.error = "已受理；渠道不可用，不能继续查询回执";
        } else {
          d.status = "cancelled";
          d.error = "渠道已禁用或删除";
        }
        m.updateDelivery(d);
        continue;
      }
      if (now.getTime() - parseTime(d.created_at) > 86400000) {
        if (d.status === "accepted") d.next_attempt = "";
        else {
          d.status = "expired";
          d.error = "通知超过24小时有效期";
        }
        m.updateDelivery(d);
        continue;
      }
      const key = rateKey(c);
      if (accounts.has(key)) continue;
      if (d.status === "accepted") {
        if (
          !["aliyun_sms", "aliyun_voice"].includes(c.type) &&
          !(c.type === "pushplus" && c.config.access_key)
        ) {
          d.next_attempt = "";
          m.updateDelivery(d);
          continue;
        }
        accounts.add(key);
        jobs.push(
          (async () => {
            const result = await this.receipt(c, d);
            if (result.status === "answered") {
              d.delivery_status = "answered";
              d.status = "confirmed";
              d.next_attempt = "";
              m.updateDelivery(d);
              await this.claimAnswered(c, d, m.now());
              return;
            }
            if (result.status) {
              d.status = result.status;
              d.error = result.error ?? "";
            }
            d.next_attempt = ["confirmed", "failed"].includes(d.status)
              ? ""
              : stamp(new Date(now.getTime() + 60000));
            d.updated_at = stamp(m.now());
            m.updateDelivery(d);
          })(),
        );
      } else {
        if (d.response_id) {
          const reason = await m.deliveryAllowed(d);
          if (reason) {
            d.status = "cancelled";
            d.error = reason;
            m.updateDelivery(d);
            continue;
          }
        } else if (d.rule_id) {
          const r = m.body("alert_rules", d.rule_id);
          if (r?.enabled && parseTime(r.silence_until) > now.getTime()) {
            d.status = "suppressed";
            d.error = "规则处于静默期";
            m.updateDelivery(d);
            continue;
          }
          const routes = r?.enabled ? (await m.route(r)).routes : [];
          if (
            !routes.some(
              (t) =>
                t.target.channel_id === d.channel_id &&
                recipientKey(t.target.recipient) === recipientKey(d.recipient),
            )
          ) {
            d.status = "cancelled";
            d.error = "告警目标已解绑或规则禁用";
            m.updateDelivery(d);
            continue;
          }
        }
        if (
          d.payload.episode &&
          db.get(
            "SELECT id FROM alert_outbox WHERE channel_id=? AND target=? AND status IN ('queued','retry','sending') AND json_extract(body,'$.payload.episode')=? AND rowid<(SELECT rowid FROM alert_outbox WHERE id=?) LIMIT 1",
            d.channel_id,
            recipientKey(d.recipient),
            d.payload.episode,
            d.id,
          )
        )
          continue;
        const blocked = db.get<any>(
          "SELECT reason FROM alert_rate_blocks WHERE rate_key=?",
          key,
        );
        if (blocked) {
          d.status = "failed";
          d.error = "渠道账号已暂停，请修正并保存渠道配置：" + blocked.reason;
          m.updateDelivery(d);
          continue;
        }
        const rate =
            Number(c.config.rate_per_minute) ||
            (c.type === "pushplus" ? 5 : 20),
          sent =
            db.get<any>(
              "SELECT count(*) AS n FROM alert_send_attempts WHERE rate_key=? AND attempted_at>=?",
              key,
              stamp(new Date(now.getTime() - 60000)),
            )?.n ?? 0;
        if (sent >= rate) continue;
        accounts.add(key);
        d.status = "sending";
        d.attempts = (d.attempts || 0) + 1;
        d.updated_at = d.sent_at = stamp(now);
        // A claim/recovery can cancel the row while route validation awaits I/O.
        if (
          !db.run(
            "UPDATE alert_outbox SET status=?,next_attempt=?,body=? WHERE id=? AND status IN ('queued','retry')",
            d.status,
            d.next_attempt || "",
            encode(d),
            d.id,
          ).changes
        )
          continue;
        db.run(
          "INSERT INTO alert_send_attempts(id,rate_key,attempted_at) VALUES(?,?,?)",
          id(),
          key,
          stamp(now),
        );
        jobs.push(
          (async () => {
            const result = await this.send(c, d);
            if (result.block_account)
              db.run(
                "INSERT INTO alert_rate_blocks(rate_key,reason) VALUES(?,?) ON CONFLICT(rate_key) DO UPDATE SET reason=excluded.reason",
                key,
                result.error ?? "",
              );
            d.status = result.status || "unknown";
            d.provider_id = result.provider_id ?? "";
            d.error = result.error ?? "";
            d.updated_at = stamp(m.now());
            d.next_attempt =
              d.status === "accepted" &&
              (["aliyun_sms", "aliyun_voice"].includes(c.type) ||
                (c.type === "pushplus" && c.config.access_key))
                ? stamp(new Date(now.getTime() + 60000))
                : "";
            if (result.retryable) {
              if (d.attempts >= 6) d.status = "failed";
              else {
                d.status = "retry";
                d.next_attempt = stamp(
                  new Date(
                    now.getTime() +
                      Math.max(2 ** d.attempts * 1000, result.retry_after || 0),
                  ),
                );
              }
            }
            m.updateDelivery(d);
            m.recordNotified(d, m.now());
          })(),
        );
      }
      if (jobs.length >= 4) await Promise.all(jobs.splice(0));
      if (m.controller.signal.aborted) break;
    }
    await Promise.all(jobs);
  }
  async claimAnswered(c: any, d: any, at: Date): Promise<void> {
    if (!d.user_id || !d.response_id) return;
    const user = this.m.member(d.user_id);
    if (!user) return;
    const expected = { kind: "phone", value: user.profile.phone };
    try {
      validateRecipient(c.type, expected);
      if (expected.value === d.recipient.value)
        await this.m.acknowledge(
          d.response_id,
          d.user_id,
          "phone_answered",
          at,
        );
    } catch {}
  }
  async processVoiceReceipts(): Promise<void> {
    const m = this.m;
    for (const v of m.deps.db.all<any>(
      "SELECT id,channel_id,provider_id,body FROM alert_voice_receipts WHERE processed=0 ORDER BY created_at LIMIT 100",
    )) {
      const event = parseJSON(v.body),
        c = m.channel(v.channel_id);
      if (!c) continue;
      let row = m.deps.db.get<any>(
        "SELECT body,status FROM alert_outbox WHERE channel_id=? AND json_extract(body,'$.provider_id')=? LIMIT 1",
        v.channel_id,
        v.provider_id,
      );
      if (!row && c.type === "aliyun_voice" && event.out_id)
        row = m.deps.db.get<any>(
          "SELECT body,status FROM alert_outbox WHERE channel_id=? AND id=?",
          v.channel_id,
          String(event.out_id),
        );
      if (!row) continue;
      const d = parseJSON(row.body);
      d.status = row.status;
      if (d.provider_id && d.provider_id !== v.provider_id) continue;
      d.provider_id = v.provider_id;
      if (["unknown", "sending"].includes(d.status)) {
        d.status = "accepted";
        d.error = "";
      }
      const answered =
        c.type === "tencent_voice"
          ? String(event.result) === "0" &&
            !!event.accept_time &&
            String(event.accept_time) !== "0"
          : Number(event.duration) > 0 ||
            event.smart_status_code === "ANSWERED" ||
            ["200102", "200000", "200001"].includes(String(event.status_code));
      if (d.delivery_status !== "answered")
        d.delivery_status =
          event.status_code === "200101"
            ? "calling"
            : event.status_code === "200201"
              ? "ringing"
              : "not_answered";
      if (answered) {
        d.delivery_status = "answered";
        d.status = "confirmed";
        d.next_attempt = "";
      }
      d.updated_at = stamp(m.now());
      m.updateDelivery(d);
      if (answered) {
        m.recordNotified(d, new Date(d.created_at));
        let at =
          c.type === "tencent_voice"
            ? Number(event.accept_time) * 1000
            : parseTime(
                event.b_start_time || event.start_time || event.status_time,
              );
        if (!Number.isFinite(at) && c.type === "aliyun_voice") {
          const s = event.b_start_time || event.start_time || event.status_time;
          if (/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(s))
            at = Date.parse(s.replace(" ", "T") + "+08:00");
        }
        if (
          !Number.isFinite(at) ||
          at < parseTime(d.created_at) ||
          at > m.now().getTime()
        )
          at = m.now().getTime();
        await this.claimAnswered(c, d, new Date(at));
      }
      m.deps.db.run(
        "UPDATE alert_voice_receipts SET processed=1 WHERE id=?",
        v.id,
      );
    }
  }
  async callback(ctx: Context): Promise<void> {
    const c = this.m.channel(ctx.params.id, true),
      token = ctx.params.token;
    if (
      !c?.enabled ||
      !c.config.callback_token ||
      !equal(c.config.callback_token, token)
    )
      ctx.error(403, "无效的回调认证");
    const raw = await ctx.raw(1 << 20);
    if (c.type === "feishu_app") return this.feishuCallback(ctx, c, raw);
    if (!["aliyun_voice", "tencent_voice"].includes(c.type))
      ctx.error(400, "不支持此渠道回调");
    let data: any;
    try {
      data = parseJSON(raw.toString());
    } catch {
      ctx.error(400, "无效的语音回调");
    }
    const events =
      c.type === "aliyun_voice" ? data : [data.voiceprompt_callback ?? data];
    if (
      !Array.isArray(events) ||
      events.some((e: any) => !e || !(e.call_id || e.callid))
    )
      ctx.error(400, "回调缺少通话ID");
    this.m.deps.db.transaction(() => {
      for (const e of events) {
        const call = String(e.call_id || e.callid),
          body = encode(e),
          key = hash(c.id + "\n" + call + "\n" + body);
        this.m.deps.db.run(
          "INSERT OR IGNORE INTO alert_voice_receipts(id,channel_id,provider_id,created_at,body,processed) VALUES(?,?,?,?,?,0)",
          key,
          c.id,
          call,
          stamp(this.m.now()),
          body,
        );
      }
    });
    await this.processVoiceReceipts();
    ctx.json({ code: 0, msg: "success", result: 0, errmsg: "OK" });
  }
  async feishuCallback(ctx: Context, c: any, raw: Buffer): Promise<void> {
    const cfg = c.config;
    if (cfg.encrypt_key) {
      const ts = String(ctx.req.headers["x-lark-request-timestamp"] ?? ""),
        nonce = String(ctx.req.headers["x-lark-request-nonce"] ?? "");
      if (
        !/^\d+$/.test(ts) ||
        Math.abs(this.m.now().getTime() - Number(ts) * 1000) > 300000
      )
        ctx.error(403, "飞书回调时间无效");
      const expected = createHash("sha256")
        .update(ts + nonce + cfg.encrypt_key)
        .update(raw)
        .digest("hex");
      if (!equal(expected, String(ctx.req.headers["x-lark-signature"] ?? "")))
        ctx.error(403, "飞书回调签名无效");
    }
    let body: any;
    try {
      body = parseJSON(raw.toString());
      if (body.encrypt) {
        const data = Buffer.from(body.encrypt, "base64");
        if (data.length < 32 || (data.length - 16) % 16) throw Error();
        const key = createHash("sha256")
            .update(cfg.encrypt_key ?? "")
            .digest(),
          dec = createDecipheriv("aes-256-cbc", key, data.subarray(0, 16));
        body = parseJSON(
          Buffer.concat([
            dec.update(data.subarray(16)),
            dec.final(),
          ]).toString(),
        );
      }
    } catch {
      ctx.error(400, "无效的加密回调");
    }
    if (
      !equal(
        String(body.token || body.header?.token || ""),
        cfg.verification_token ?? "",
      )
    )
      ctx.error(403, "飞书Verification Token无效");
    if (body.header?.app_id && body.header.app_id !== cfg.app_id)
      ctx.error(403, "飞书应用不匹配");
    if (body.challenge) {
      ctx.json({ challenge: body.challenge });
      return;
    }
    const values = body.event?.action?.value ?? body.action?.value,
      openID = body.event?.operator?.open_id ?? body.open_id;
    if (values?.action !== "ack" || !openID)
      ctx.error(400, "缺少接手动作或操作人");
    const incident = this.m.response(values.response_id);
    if (!incident) ctx.error(404, "告警事件不存在");
    const ids = incident.group.members.filter(
      (key: string) => this.m.member(key)?.profile.feishu_id === openID,
    );
    if (ids.length !== 1)
      ctx.error(
        ids.length ? 409 : 403,
        ids.length ? "飞书身份映射不唯一" : "飞书操作者尚未绑定组成员",
      );
    try {
      const r = await this.m.acknowledge(incident.id, ids[0], "feishu_card");
      ctx.json({
        toast: { type: "success", content: r.owner_name + "已接手" },
        card: {
          type: "raw",
          data: {
            config: { wide_screen_mode: true },
            header: {
              title: { tag: "plain_text", content: r.event.rule_name },
              template: "green",
            },
            elements: [
              {
                tag: "div",
                text: {
                  tag: "plain_text",
                  content: r.owner_name + "已接手 · " + r.priority,
                },
              },
            ],
          },
        },
      });
    } catch (e) {
      ctx.json({ toast: { type: "error", content: (e as Error).message } });
    }
  }
}
