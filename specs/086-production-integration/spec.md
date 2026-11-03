# Feature Specification: 统一 Agent 集成发布与线上复核

**Branch**: `codex/086-container-entry-alignment`
**Created**: 2026-11-03
**Status**: In progress

用户明确批准将 PR #72、#73、#74 一并合入 main，发布 docker.heyphp.com/lightmoni/lightmoni，备份后重建线上中心状态并继续调试。三项功能包括统一 Agent root/user 生命周期、多 SSH 账户和安装/卸载进度；不提供旧数据库迁移。

## 验收

1. 保留主干已有 CentOS Docker 验证修复，合并统一运行模型的文案和凭据契约；完整检查及构建通过。
2. 主机容器入口直接复用现有受管容器界面，移除仍依赖普通 Agent Docker 能力的旧界面。未就绪引导运行账户与容器授权，不自动提权。
3. 安装远端非零退出只保留退出码和有限安全原因；原始 stdout/stderr、密码、密钥、enrollment 和 stdin 不进入错误或持久诊断。已派发失败保持 unknown 与原有恢复互斥。
4. 现有与新发布文档使用一致镜像标签。所有代码经 GitHub PR 合入 main，发布测试过的 amd64/arm64 固定镜像及 latest。
5. 线上升级前保存配置、SQLite 一致性备份和主密钥。v1 状态与遥测卷保留备份，新建 v2 中心状态；沿用管理员现有登录凭据，保留用户明确要求的 heyphp.com 域名与 DNS 凭据、现有 SSH 凭据库，其余旧主机/任务/作业状态不迁移。
6. 新中心健康、管理员、主机重新登记与统一 Agent 真实安装、Docker 检查、容器清单通过。旧 Agent/独立执行器按受控卸载处理，不遗留两套常驻进程。
7. 用户新增交付标准：保留 heyphp.com DNS 配置；创建有源码和健康接口的 demo 项目，镜像发布私有仓库并通过 LightMoni 私有镜像、应用、网站、证书流程部署到 https://abc.heyphp.com。公网 DNS、受信 TLS、应用健康和实际页面/接口均验证，记录资源与部署结果。
8. 真实 CentOS 8 主机的 systemd `Version=239 (239-51.el8)` 属于正常版本输出，不得因此隐藏已批准的 root 脚本和受管运维能力；仍必须通过受信文件权限和 system bus 探测，异常输出或缺依赖不能宣称就绪。
9. 内网 IP 绑定的应用和私有仓库，部署及后续巡检必须探测所分配端口的绑定 IP；通配绑定使用本机回环。HTTP/IPv6/TCP 探针只能接受 IP 字面量，不接受域名或用户信息。

## 架构影响

继承 SDD083/084 的统一 Agent、账户/凭据和新数据库基线。主机 UI 移除旧 Docker 入口并复用既有签名容器协议，在仓库系统设计与 Doca 新增明确的入口约束；保留 Doca 已有83/84章、原生图块及无关内容。安全诊断复用既有 receipt JSON，无数据库字段变更。

真实部署补充 health.host 的签名健康目标契约和 Demo 的私有镜像、网关、应用、DNS/TLS 拓扑，同步第86章与 Doca 并回读。CentOS systemd 版本格式修复本身不涉及架构变化。
