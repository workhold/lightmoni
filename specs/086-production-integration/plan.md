# Design

- 以 main 为基整合 #74（包含 #73 与 #72 的提交），保留主干 Docker 已有组件验证。通过集成 PR merge commit 保留原提交可达性，原 PR 改以 main 后核对合入状态。
- 主机列表复用 ManagedContainerDialog；Docker 环境面板保留已有组件验证和 root Agent 容器授权提示，删除旧 HostInventory 页面。
- SSHError 保持原 code，只在非零退出时形成固定安全诊断；部署 receipt 附加诊断且继续 unknown。不给未知结果自动重试或撤销身份。
- 仓库设计章节与 Doca 同步入口约束，回读最新目标块并核验原生图块未变。
- 先测试/构建后 PR 合入；对固定源码双架构构建和烟测，发布不可变标签/更新 latest，再提交 Compose 版本收敛 PR。
- 线上保存配置/数据库/master key 及旧容器摘要，以新命名卷启用 schema v2。保留旧卷；管理员仅复制原有账户密码散列与当前会话，避免新密码传播。沿用主密钥以保留用户新建的域名/DNS 凭据及原 SSH 凭据库；重新建立 v2 主机/账户绑定，不迁移旧绑定记录，不提交/打印秘密。
- Demo 通过本仓库 examples/abc-demo 提供无依赖 Node HTTP 服务与 Dockerfile，固定健康接口、真实请求统计和版本信息。使用私有仓库镜像 digest 经 LightMoni 应用部署，网站反代连接主机可达私有端口，DNS 与证书使用已登记 heyphp.com；证书私钥不落入源码或日志。
- 线上 root Agent 激活后复现 CentOS systemd 发行版括号后缀被拒绝。提取有界单行版本格式校验，接受该实测格式并保留原有 rootPath 与 busctl 检查。此修复不改变组件、控制路径、权限、存储或部署拓扑，架构同步不适用；既有第86章和 Doca 无需改写。
- 私有仓库真实安装复现内网绑定与回环探针不一致。中心在既有签名 health 配置中携带端口预留的 host_ip，部署与巡检共享 IP 字面量探针；通配地址归一为相同地址族的回环。复用已有端口/服务地址与签名授权边界，无新协议端点、权限或部署拓扑，架构同步不适用。
