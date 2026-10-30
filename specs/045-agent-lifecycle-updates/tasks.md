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
- [ ] 同步 main、提交并推送功能分支、创建 GitHub PR。

本轮不发布镜像、不修改真实用户主机。实际验收结果见 [validation.md](validation.md)；真实 systemd 验收仅覆盖 arm64，amd64 只完成构建及运行时摘要/架构核验。
