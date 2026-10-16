# 接入页面与 table 权限验收

本目录的截图、参考图和录屏仅保存在本机 [`artifacts/screenshots/docs/evidence/ingestion-table-keys/`](../../../artifacts/screenshots/docs/evidence/ingestion-table-keys/)，由 Git 忽略；下文未带路径的图片和录像文件名均相对此目录。文字报告继续保留在仓库中。

2026-10-11。SDK 与 Agent 拆为独立接入 Tab；创建、编辑上报 Key 时配置逻辑 table 白名单，或显式允许所有 table，沿用现有 Ant Design 组件和深色主题。核心操作是选择接入方式、设置白名单、下载 Agent 私有配置。默认使用指定 table；所有 table 模式通过独立的 allow_all_tables 标记保存，覆盖现有及未来新表，不使用白名单通配符。Agent 创建 Key 时也可选择这两种模式。旧 Key 显示待配置并拒绝数据写入。

服务端在上报正文读取、自动建表、批次重试和 ClickHouse 写入之前检查权限。Key 编辑不替换秘密；启用/禁用不覆盖上报范围。切回指定 table 后，后续上报和已确认批次的重试重新按白名单校验。键盘 Tab 仅移动焦点，避免选择组件自动添加高亮 table。新交互复用 Tabs 指示条、表单反馈、Modal 过渡及按钮加载状态，没有额外装饰动效；局部修改由主 Agent 自检，未安排独立视觉评审。

Go 权限测试通过 `go test -race ./internal/auth ./internal/ingest ./internal/server`：创建与修改校验、精确匹配、失效/禁用、成员不能扩大权限、旧 SQLite schema 迁移、权限持久化、坏数据拒绝写入、日志/指标/链路越权和已确认批次重试后的权限撤销。新增全表 Key 创建、范围切换、启停、重启回读、既有白名单迁移不扩大权限，以及全表 Key 上报三种信号并生成新逻辑表的测试。越权请求不读取正文、不创建数据表、不写监控数据，并记录拒绝原因。

浏览器连续三轮通过，分别见 [第 1 轮](report-1.json)、[第 2 轮](report-2.json)、[第 3 轮](report-3.json)。覆盖 Tab 隔离、table 必填与通配符校验、创建/编辑/启停、保存失败保留输入、刷新回读、上报返回 403/401、全表 Key 不填白名单即可创建、允许未来 table、启停与刷新保留全表权限、切回白名单拒绝其他 table、Agent 默认 host/probe 与业务 table、Agent 创建全表 Key、配置下载、切换清除密钥明文，以及 1440/750/390 视口无页面横向溢出。Auth、SQLite 和 Ingest 使用真实代码；ClickHouse 写入与安装包元信息为测试替身，未据此声明真实 ClickHouse 或 Linux 安装验收。

本次接入页面组件与 CorePages 的 TypeScript 检查通过，最终全项目 `npm --prefix web run typecheck` 也通过。验证中曾遇到大盘模块并行修改时的独立属性类型错误，收尾检查时已经消除。

最终截图保留第 3 轮：`sdk-*-3.png`、`agent-*-3.png`、`sdk-3.png`、`keys-3.png`、`key-create-3.png`、`key-create-all-3.png`。检查了桌面密钥表单、列表、窄屏 SDK 和 Agent 长页；界面已移除“全局 Key”的重复说明，以可配置的上报范围说明替代。

复现使用隔离测试实例，分别启动：

```sh
go run ./scripts/ingestion-qa
LIGHTMONI_DEV_API_URL=http://127.0.0.1:18882 npm --prefix web run dev -- --port 5178 --strictPort
```

然后运行：

```sh
LIGHTMONI_QA_RUN=1 node web/src/app/verify-ingestion.mjs
LIGHTMONI_QA_RUN=2 node web/src/app/verify-ingestion.mjs
LIGHTMONI_QA_RUN=3 node web/src/app/verify-ingestion.mjs
```

测试服务器仅监听 loopback，使用临时数据库，关闭后清理；默认账号只用于上述 QA 实例。


2026-10-11 Agent 分组改版后再次连续验证三轮通过：[第 1 轮](report-agent-update-1.json)、[第 2 轮](report-agent-update-2.json)、[第 3 轮](report-agent-update-3.json)。Agent 接入现在选择分组生成自动保存连接的安装命令，默认授权组内 `host_table`、`probe_table`、`log_table`（默认 host/probe/files）；Key 通过隐藏输入传给安装器，页面可单独复制 Key。原私有 JSON 下载流程已移除。此次 QA 使用真实主服务 API、Auth、SQLite、Ingest，ClickHouse HTTP 存储仍为替身；安装包元信息来自主服务。分组/目录任务的独立证据见 [Agent 分组验收](../agent-groups/README.md)。
