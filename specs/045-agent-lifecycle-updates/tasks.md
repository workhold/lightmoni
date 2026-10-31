# 任务与证据

- [x] 先写需求、HLD/LLD、接口与安全边界。
- [x] 发行 metadata / 心跳 boot 与摘要 / 首装 receipt。
- [x] 独立 root 维护器、失败和确认超时回退、只读 probe/receipt。
- [x] 发行目录/CAS、单机计划/审批/健康/核对、批量持久调度。
- [x] 生命周期与任务双向互斥。
- [x] 中英文 UI 与 AI 只读/提案工具。
- [x] Linux 执行器、SQLite/HTTP 故障、浏览器与完整相关回归。
- [x] 仓库设计与 Doca 原生图同步并回读。
- [x] 本地平台启动，读取真实双架构发行目录并查看主机页。
- [x] 同步 main、提交并推送功能分支、创建 [GitHub PR #21](https://github.com/workhold/lightmoni/pull/21)。

本轮不发布镜像、不修改真实用户主机。实际验收结果见 [validation.md](validation.md)；真实 systemd 验收仅覆盖 arm64，amd64 只完成构建及运行时摘要/架构核验。

## 主干集成复核

- [x] I001 先补充集成需求、设计及契约。
- [x] I002 合并最新 main，保留双方架构和主干身份/异步/endpoint/脚本能力。
- [x] I003 升级 SSH 使用记录接入集中凭据，补充独立回归。
- [x] I004 执行相关后端、类型/构建及界面 fixture，记录当前组合的验证结果。
- [x] I005 主线程核对系统设计与 Doca 合并状态，保留最新回读证据。
- [x] I006 主线程发布集成源 head `62a00dc`，于 2026-10-31T06:18:17Z 按用户授权合入 [PR #21](https://github.com/workhold/lightmoni/pull/21)，主干 merge 为 `7f1506ce`。
- [x] I007 自动重试维护 fence 不阻塞其他主机调度，补回归并重跑最终后端检查。

本轮集成结果见 [integration-validation.md](integration-validation.md)。
