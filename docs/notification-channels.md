# 通知渠道配置

在“设置 → 通知接入”添加供应商配置，再在人员告警组中引用接入。个人目标从用户资料和当班主备解析；同一类渠道可创建多份。分级方式、接手链接、排班、回执和统计见[告警响应与值班](alert-response.md)，发送结果仍在“事件与发送记录”。

## 支持范围

| 类型 | 渠道 | 接收目标 |
| --- | --- | --- |
| `aliyun_voice` | 阿里云电话语音，文本转语音通知模板 | `phone`，单个手机号或带区号的固话 |
| `tencent_voice` | 腾讯云电话语音，指定模板语音通知 | `phone`，单个手机号 |
| `aliyun_sms` | 阿里云短信 | `phone`，单个手机号 |
| `tencent_sms` | 腾讯云短信 | `phone`，单个手机号 |
| `huawei_sms` | 华为云短信 | `phone`，单个手机号 |
| `smtp` | SMTP 邮件 | `email`，单个收件邮箱 |
| `feishu/dingtalk/wecom` | 飞书、钉钉、企业微信群机器人 | `channel`，该渠道绑定的群，提醒当班用户并带接手链接 |
| `feishu_app` | 飞书企业应用机器人，交互卡片 | `feishu_user`，用户资料中的open_id |
| `pushplus` | 微信公众号 / App 推送 | `self/topic/friend` |
| `webhook` | 通用 HTTP 接收器 | `channel` |

腾讯云和华为云接收国内11位手机号时自动补 `+86`，也可填写带国家代码的号码。阿里云国内手机号的 `+86` 会规范化为11位号码。同一责任组每轮按规范化目标去重；不同责任组分别接手。联系人由用户资料维护。

## 电话和短信字段

渠道 API 沿用 `POST /api/v1/notify/channels` 和 `PUT /api/v1/notify/channels/:id`，供应商配置位于 `config`，所有值为字符串。

| 类型 | 必填配置 | 可选配置 |
| --- | --- | --- |
| `aliyun_voice` | `access_key_id`、`access_key_secret`、`template_code`（TTS 模板） | `called_show_number`（专属号码或服务实例 ID）、`template_params`（JSON 对象）、`play_times`（1～3）、`receipt_prod_id`（回执查询产品，默认TTS产品） |
| `tencent_voice` | `secret_id`、`secret_key`、`sdk_app_id`（语音应用）、`template_id` | `region`（默认 `ap-guangzhou`）、`template_params`（JSON 数组）、`play_times`（1～3） |
| `aliyun_sms` | `access_key_id`、`access_key_secret`、`sign_name`、`template_code`（SMS 模板） | `template_params`（JSON 对象） |
| `tencent_sms` | `secret_id`、`secret_key`、`sdk_app_id`（短信应用）、`sign_name`、`template_id` | `region`（默认 `ap-guangzhou`）、`template_params`（JSON 数组） |
| `huawei_sms` | `app_key`、`app_secret`、`endpoint`（应用接入地址）、`sender`（签名通道号）、`template_id` | `signature`（通用模板签名名称）、`template_params`（JSON 数组） |

阿里云语音公共模式不填 `called_show_number`；专属模式必须填入号码或实例 ID，并使用匹配模式的已审核模板。腾讯云的短信应用和语音应用需要分别配置 SDK AppID。华为云接入地址从短信应用控制台复制，可以是域名根地址或完整 `/sms/batchSendSms/v1` 地址。

模板参数支持 `{{rule}}`（告警名称）、`{{status}}`（事件类型，如 `firing/resolved/test`）、`{{value}}`（数值）、`{{message}}`（详情）、`{{priority}}`（当前通知等级）、`{{ack_url}}`（短接手链接）。短信要支持接手时，审核模板与参数中必须包含接手链接，系统不会擅自增加供应商模板参数。对象变量名与数组顺序必须对应已审核模板；无变量模板填写 `{}` 或 `[]`。新建表单默认使用空对象/数组；兼容旧阿里云短信配置，省略 `template_params` 时仍传 `rule/status/value` 默认对象。

阿里云示例：`{"name":"{{rule}}","state":"{{status}}","value":"{{value}}"}`。

腾讯云、华为云示例：`["{{rule}}","{{status}}","{{value}}"]`。

每个渠道可配置 `rate_per_minute`（1～599），留空默认20次/分钟，Pushplus默认5次/分钟。同类渠道共用同一供应商凭证时共享限流。阿里云、腾讯云保留可选 `endpoint` API 配置供代理或本地协议测试使用，默认分别使用官方短信/语音服务域名；腾讯云仅允许根路径。

## 邮箱

SMTP 表单提供 QQ、网易163、网易126、腾讯企业邮箱、阿里企业邮箱预设，填入服务器、465端口与SSL/TLS。自定义 SMTP 支持其他邮箱与邮件服务。

| 预设 | SMTP 服务器 |
| --- | --- |
| QQ | `smtp.qq.com` |
| 网易163 | `smtp.163.com` |
| 网易126 | `smtp.126.com` |
| 腾讯企业邮箱 | `smtp.exmail.qq.com` |
| 阿里企业邮箱 | `smtp.qiye.aliyun.com` |

API 配置仍为 `host/port/tls/username/password/from`。先开启邮箱 SMTP 权限，`password` 填客户端授权码或供应商要求的客户端密码。`tls` 可选 `tls/starttls/none`；认证支持 PLAIN 与 LOGIN，远程 LOGIN 要求加密连接。发件地址允许 `LightMoni <alerts@example.com>` 形式，SMTP 信封使用实际邮箱地址。

## 保存和结果

凭证字段加密保存，接口与编辑表单不回显原值，留空保留已配置凭证。更新时需携带读取到的 `revision`。修改账号、目标服务、模板或发送参数会取消尚未发送的旧任务，避免旧告警被新配置重新解释。渠道继续使用原表，新响应、接手、回执等表由启动初始化创建。

测试通知会实际提交到所选目标，遵守相同限流，发送记录保留供应商流水号。电话和短信会使用已配置账号的资源。新渠道的成功响应记为 `accepted`；这只表示供应商受理，不能证明接听、阅读或最终送达。阿里云短信、Pushplus回执查询继续支持；阿里/腾讯电话使用专用回调，阿里电话另有查询补偿。通话接听确认后才自动接手。

新增电话/短信渠道遇到响应丢失、无效响应、HTTP 5xx 或腾讯云 `InternalError.SendAndRecvFail` 时保留 `unknown`，不会自动重发；无请求写出的连接失败和明确限流可重试。手动重试未知结果需确认可能重复；凭证、模板等永久错误显示 `failed`。

## 群机器人、企业应用与回调

飞书普通机器人配置Webhook及可选签名秘密；钉钉配置Webhook及可选加签；企业微信配置群Webhook。普通机器人消息提供“开始处理”链接，登录到达告警页后自动接手。

飞书企业应用配置`app_id/app_secret/verification_token`，可选`encrypt_key`；个人卡片按用户open_id发送，操作者回调与本地用户映射。系统列表中的“回调地址”供管理员复制到对应飞书应用或电话供应商，包含专用认证秘密，保存后不在普通接口回显。

电话回执支持重复/乱序/早到持久化。阿里云携带`OutId`补偿发送结果丢失，接受接听中间状态或成功通话时长；腾讯云接受`voiceprompt_callback`的实际接听结果。完整状态码、链接权限与统计语义见[告警响应](alert-response.md)。

## 验证范围

- `go test -race ./internal/alerts`：真实本地 HTTP 接收器检查四个新增渠道的签名、参数、业务状态、流水号；隔离 SQLite 检查 API、号码规范化、凭证隐藏/保留、配置变更取消队列、未知结果不重发；真实本地 TCP SMTP 接收器检查 LOGIN 认证及显示名发件地址。
- `npm run build`：TypeScript 与生产构建。
- 当前页面流程使用`node web/src/features/alerts/verify-response.mjs`，截图和报告在`docs/evidence/alert-response/`。原`verify-channels.mjs`及`docs/evidence/notification-channels/`保留此前渠道编辑器的验证记录；旧“地址组”入口已由人员组替换。两类浏览器记录均未调用真实供应商。

没有配置真实供应商账号、审核模板、授权号码或邮箱；真实拨号、短信投递与邮箱TLS账号投递尚未验收。本地测试没有产生付费短信或电话。

## 官方接口依据

- [阿里云 SingleCallByTts](https://help.aliyun.com/zh/vms/developer-reference/api-dyvmsapi-2017-05-25-singlecallbytts)：语音模板、公共/专属模式和 CallId。
- [腾讯云 SendSms](https://cloud.tencent.com/document/api/382/55981)、[腾讯云官方语音SDK模型](https://github.com/TencentCloud/tencentcloud-sdk-go/blob/master/tencentcloud/vms/v20200902/models.go)、[TC3签名](https://cloud.tencent.cn/document/api/1128/51564)。
- [华为云短信发送API](https://support.huaweicloud.com/intl/en-us/api-msgsms/sms_05_0001.html)、[官方X-WSSE认证说明](https://support.huaweicloud.com/eu/api-msgsms/sms_05_0046.html)。
- [阿里邮箱SMTP](https://help.aliyun.com/zh/document_detail/36687.html)、[腾讯企业邮客户端配置](https://main.qcloudimg.com/raw/document/product/pdf/613_46019_cn.pdf)、[网易邮箱帮助中心](https://help.mail.126.com/faq.do?categoryID=90&m=list)。
