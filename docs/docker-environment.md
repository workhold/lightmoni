# Docker 环境验证与补装

从主机列表的“检查环境”进入统一面板。有效 SSH 凭据和 root 或免交互 sudo 用于验证主机上的 Engine、Compose 与 systemd 服务。

- 已有完整 Engine 和 Compose 的 Linux amd64/arm64 systemd 主机可直接验证，包括已有 Docker 的 CentOS 主机。验证流程不访问软件源、不升级 Engine，不重启已运行的 Docker。
- 缺少 Engine 或 Compose 时，自动补装仅支持 Ubuntu/Debian 的 Docker 官方 apt 仓库；其他发行版返回明确的不支持原因，并提供官方安装指南。遇到冲突软件包时停止，不自动卸载。
- “Docker 依赖已验证”表示主机依赖验证完成。容器操作还需在“主机执行权限”中验证完整管理模式的 root helper、容器管理授权与签名状态。
- “待检测”或“观测已过期”表示当前没有有效的 helper 容器观测，不表示主机未安装 Docker；普通 Agent 在线不能替代该观测，也不应给普通 Agent 添加 Docker 组权限。

失败记录保留静态阶段和原因。结果未知时先核对原操作，不重复安装；主机依赖和执行权限分别核验，不能通过修改安装回执伪造执行器就绪。

主机列表的“容器管理”进入统一受管容器计划与执行记录。仅监控模式不会访问 Docker socket；能力未就绪时按页面入口检查完整管理模式及 helper 授权，不通过提升网络 Agent 权限获取 Docker 权限。
