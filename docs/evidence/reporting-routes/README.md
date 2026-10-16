# 多上报地址与 Agent 鉴权下载

2026-10-16。沿用现有深色、AntD 表单和蓝色主操作。管理后台的接入配置维护最多 20 个有名称的地址，可新增、编辑、移除并指定默认项；窄屏按名称/地址两行排版。Agent 与 SDK 直连共享可搜索、可临时输入的地址选择器。SDK 通过 Agent 时仍使用本地/远程 Agent 地址。

## 行为

- 地址列表与默认项持久保存；旧单地址记录自动读取为一个选项，旧 API 写入也保持兼容。未配置时使用部署地址。校验重复地址/ID、名称、默认项及 HTTP(S) URL；列表和旧默认字段在同一事务内保存。
- SDK 环境变量和全部八种语言的示例随所选地址更新，复制结果包含该地址。Key 仍通过环境变量注入。
- Agent 安装命令包含所填 Key，下载安装器时通过 Bearer 头鉴权；安装器缓存 stdin 中的 Key，用它下载包和 SHA256SUMS，再传给 configure 写入上报配置。命令使用局部子 shell，下载失败不运行旧安装器。
- 安装脚本、卸载脚本、amd64/arm64 内置包和校验文件统一要求有效、启用的上报 Key；登录 Cookie 不能代替下载 Key。响应不允许公共缓存，凭证不放入 URL。
- 正式包在项目构建时生成并内置于服务。Vite `/downloads` 同样代理至当前后端，保证 5173 开发入口能下载实际文件。

## 验证

- 类型检查和前端生产构建通过。
- `node --test web/src/app/agentInstallCommand.test.mjs web/src/app/sdkExamples.test.mjs`：8 项通过，包括所选地址、Key/stdin、Shell 参数转义、失败阻止安装及八语言示例。
- `go test ./internal/server -run 'TestAgentInstaller|TestReporting|TestMultipleReporting|TestEmbeddedAgent|TestSDKCatalog' -count=3`：连续三次通过。覆盖旧配置迁移、保存/重启读回、默认项、非法配置、事务回滚、全部内置文件的鉴权和禁用 Key。
- 真实安装脚本测试只替换系统修改命令；实际解压归档，验证两次下载均携带鉴权，并由归档内 configure 进程读取同一份 stdin Key。未在用户机器安装系统服务。
- 独立 SQLite + ClickHouse 实例通过浏览器保存两条地址、切换默认后刷新读回、切换 Agent 线路并复制带 Key 命令、复制所选 SDK 示例。经 Vite 鉴权下载真实安装器、SHA256SUMS 和 arm64 包，包/校验文件与内置资源哈希相同。
- 390px 设置页无横向溢出。沿用组件反馈与现有动效，本次未单独做动效录屏或独立视觉评分。
- 当前 5173/18380 服务已更新，未修改用户已有地址或创建用户实际网络入口。内外网 URL 需要由管理员填写，并转发到同一 LightMoni 实例。

截图保存在 Git 忽略的任务目录 `artifacts/screenshots/reporting-routes/`：`settings-desktop.jpg`、`settings-narrow.jpg`、`agent-install.jpg`、`sdk-selected-route.jpg`、`live-settings.jpg`。独立实例中的公网/内网示例仅用于验证生成结果，没有向这些域名发出请求。
