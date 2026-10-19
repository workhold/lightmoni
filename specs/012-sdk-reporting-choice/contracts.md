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

## 环境示例的切换行为

生成 direct 环境块：清理 `LIGHTMONI_AGENT_ENDPOINT`、`LIGHTMONI_LOCAL_TOKEN`、`LIGHTMONI_LOCAL_TOKEN_FILE`、`LIGHTMONI_DATA_KEY_FILE`、`LIGHTMONI_KEY`，再提供 endpoint 与 data key 占位值。

生成 agent 环境块：清理 `LIGHTMONI_ENDPOINT`、`LIGHTMONI_DATA_KEY`、`LIGHTMONI_DATA_KEY_FILE`、`LIGHTMONI_KEY`、`LIGHTMONI_LOCAL_TOKEN`、`LIGHTMONI_LOCAL_TOKEN_FILE`，提供 Agent endpoint；用注释说明仅在 Agent 启用鉴权时设置 local token。用户可以将占位环境注入改成 Secret 文件，所选来源的冲突检查不会被取消。

## 页面

选项：“直连平台” / “通过 LightMoni Agent”。初始 direct；两种 endpoint 独立保留。浏览器 bundle 不保存真实凭据；业务示例为服务端接入。Agent 不与 SDK 直连、节点在线状态或模型调用形成强制依赖。
