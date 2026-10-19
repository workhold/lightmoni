# Contracts: 显式 SDK 上报模式

| 字段/行为 | direct | agent |
| --- | --- | --- |
| `LIGHTMONI_MODE` | `direct` | `agent` |
| 业务目标地址 | `LIGHTMONI_ENDPOINT` | `LIGHTMONI_AGENT_ENDPOINT`，缺省 loopback 4318 |
| 凭据 | `LIGHTMONI_DATA_KEY(_FILE)`，兼容 `LIGHTMONI_KEY` | `LIGHTMONI_LOCAL_TOKEN(_FILE)`，按 Agent 鉴权配置填写 |
| 不读取的秘密 | local token / local token file | data key / data key file / legacy key |
| 成功含义 | 平台按现有 ingest 契约接受 | Agent 按现有 durable receive 契约接受 |
| 失败重试 | 原平台、原批次 | 原 Agent、原批次 |
| 自动改投另一条路径 | 禁止 | 禁止 |

所有模式保持 OTLP HTTP `/v1/metrics`、`/v1/logs`、`/v1/traces`、table 和批次头兼容。上表是显式 mode 的契约；auto 仍由 011 定义。

HTTP 接收端可以通过 `Content-Length`、分块传输或连接关闭界定响应长度。Python SDK 不应因接收端在响应头后关闭连接而把有效 ACK 当作网络失败；读取响应仍受同一请求截止时间与响应大小上限约束。没有有效 ACK 或读取中断时，继续保留原批次并按原路径重试。

标准 HTTP Agent 构造的 SDK 规则获取也通过该 Agent，用 local token 认证；旧的单独 config endpoint/key 不应让显式 agent 绕回平台。自定义 exporter 没有内置 HTTP 上报路由，其显式规则配置保持兼容。direct 和 auto 的独立规则地址沿用原契约，本轮不扩展规则能力到原本未实现的语言。

## 环境示例的切换行为

生成 direct 环境块：清理 `LIGHTMONI_AGENT_ENDPOINT`、`LIGHTMONI_LOCAL_TOKEN`、`LIGHTMONI_LOCAL_TOKEN_FILE`、`LIGHTMONI_DATA_KEY_FILE`、`LIGHTMONI_KEY`，再提供 endpoint 与 data key 占位值。

生成 agent 环境块：清理 `LIGHTMONI_ENDPOINT`、`LIGHTMONI_DATA_KEY`、`LIGHTMONI_DATA_KEY_FILE`、`LIGHTMONI_KEY`、`LIGHTMONI_LOCAL_TOKEN`、`LIGHTMONI_LOCAL_TOKEN_FILE`，提供 Agent endpoint；用注释说明仅在 Agent 启用鉴权时设置 local token。用户可以将占位环境注入改成 Secret 文件，所选来源的冲突检查不会被取消。

## 页面

选项：“直连平台” / “通过 LightMoni Agent”。初始 direct；两种 endpoint 独立保留。浏览器 bundle 不保存真实凭据；业务示例为服务端接入。Agent 不与 SDK 直连、节点在线状态或模型调用形成强制依赖。

## 当前发布矩阵

`GET /api/v1/sdk-install` 的 `packages` 只包含 TypeScript/JavaScript、Python、Ruby；这三种 SDK 才提供安装、下载与业务接入示例。`deferred` 返回 Go/Rust 的 `id`、`language`、`runtime`、`status: deferred`、`reason: 后续支持`，页面只展示后续支持状态。

PHP SDK 源码、示例、发布及下载入口移除。即使下载目录残留旧的 PHP、Go 或 Rust 包，下载接口也返回 404。发布脚本清理旧包并重建校验清单，避免复用目录仍携带下线包。接收端继续兼容历史 OTLP 数据，不因停止发行而拒绝既有信号。
