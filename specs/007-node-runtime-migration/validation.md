# 最终验收记录

日期：2026-10-17，macOS arm64。主干同步至 `477b087`，迁移基线为 `1d892c9`。生产代码全部使用 Node.js/TypeScript，Go 仅保留业务 SDK 与开发期协议差分工具。

## 已通过

| 检查 | 结果 |
| --- | --- |
| Node 24.15.0 runtime 全套，启用真实 ClickHouse 与发布包用例 | **117/117，通过，0 skip** |
| Mastra worker / 四协议 / 流式 / 用量 / 预算测试 | **71/71** |
| TypeScript SDK 测试 | **15/15** |
| Go SDK 及业务示例 | `go test -race ./...` 通过，包含真实 Node Agent receiver 的跨语言集成 |
| runtime / ai-runtime / web typecheck 和生产构建 | 全部通过；网页输出 `runtime/public` |
| 路由兼容 | 原公开 API **141/141**，路径、方法、认证边界逐项检查 |
| 原 SQLite 副本 | **45 张表、43 条原记录非破坏保留**，原模型密钥解密成功，无外联；内置运行时面板迁移保留旧版本 |
| 浏览器真实 API 巡检 | **7/7 页面，40 次 API，0 pageerror / 5xx / 请求失败**，在 Node 24 再次通过 |
| 既有模型管理与节点助手浏览器脚本 | 模型管理 11 组；节点助手 10 组（受控 API fixture，不冒充真实数据） |
| Agent Linux amd64 / arm64 包 | 固定 Node **24.15.0** 官方 SHA256、ELF 架构、相对依赖链接、解包 CLI 均通过 |
| Agent 安装与失败回滚 | 临时目录执行真实 shell，**6/6**；旧 Node/Go 安装、配置、队列身份保留 |
| 下载入口 | 2 份 Agent 包、8 份 SDK；Agent 下载需 Key，8 份 SDK SHA256 全匹配 |
| 替代接入 QA fixture | `node scripts/ingestion-qa.mjs` 可启动、healthz 成功并正常关闭 |
| shell / JavaScript 语法和 diff | 全部通过；已移除旧平台 Go 运行代码与依赖 |

最终 runtime 用例同时启用真实 ClickHouse 和双架构发布包，覆盖 Node SDK → Node Agent SQLite → 重启 → Node 中心 → ClickHouse；计数 `9007199254740993` 精确保留，重复批次不重复统计，日志/Trace 关联一致。大盘、日志聚合、分页、上下文、Trace、真实 SQL 告警、localhost webhook、接手和恢复另有完整闭环。原 Go → Node → Go 队列差分和固定 Go golden 记录见 [Agent 验收](agent-validation.md)，域细节见 [domain-validation.md](domain-validation.md)，旧数据及浏览器见 [old-data-validation.md](old-data-validation.md)。

## 可复跑

```sh
npm run setup
npm run build
npm run typecheck
npm test
go test -race ./...
npm run release:agent -- 0.1.0
npm run release:sdk -- 0.1.0
LIGHTMONI_DOMAINS_URL=http://127.0.0.1:18885 LIGHTMONI_RELEASE_DIR="$PWD/runtime/downloads" npm --prefix runtime test
node runtime/test/helpers/browser-live.mjs
```

Live 用例只指向隔离 QA 服务。账号可通过 `LIGHTMONI_DOMAINS_USER/PASSWORD`、浏览器的 `LIGHTMONI_NODE_QA_USER/PASSWORD` 覆盖；不要指向生产。未设置 live 环境变量时这三类用例默认跳过。旧数据库脚本只对一致性副本执行迁移，不启动后台调度。

本次隔离服务：Node 中心 `127.0.0.1:18885`，真实原生 ClickHouse 26.10 HTTP `127.0.0.1:18125`，状态 `.local-dev/node-qa/`。原 `8080` 服务保持原状，没有让两个调度器连接同一原始库。证据日志、下载产物、截图和数据库副本保存在忽略目录 `.local-dev/` / `runtime/downloads/`，不提交真实密钥或数据库。

## 限制及升级注意

- 本机无 Docker/Podman，**没有实际构建/运行中心 Docker 镜像，也没有在 Linux 实机执行 ELF 或 systemd**。镜像配置已改为 Node 24.15.0；应在 Linux CI 补容器与 systemd 验收。解包测试用宿主 Node 执行 JavaScript，并单独检查 Linux ELF 与官方校验和。
- Agent 自含运行时包要求 Linux **glibc >=2.28**，当前不提供 musl 包。无需在目标主机安装 Node/npm。
- OAuth、短信/电话/邮件/机器人和模型供应商使用受控协议 fixture；没有调用真实付费供应商。localhost webhook 与本地 SMTP 是真实网络测试。
- 旧中心和新中心必须先停后启，不能同时接管同一数据目录/调度器。升级前备份 SQLite 与 master.key，保留 Agent 数据目录；不要删除队列或重新生成身份。
- SQL/OAuth/布尔权限的安全收紧和内置面板迁移见 [覆盖矩阵](coverage.md)。大规模性能、长期稳定性与所有第三方供应商效果未在本次验证中作承诺。

本次发现并修复了打包时绝对依赖链接、符号链接入口不执行 CLI、安装失败不回滚、失败绑定端口残留调度器及权限/SQL/旧 JSON 精度兼容问题；对应回归已加入上述测试。
