# HLD / LLD

登记主机继续复用 `/machines` 和 `/machines/:id/credentials` 两步接口：第一步生成资产，第二步保存加密凭据。第二步失败明确保留已登记主机，可重试，不伪装原子成功。前端明确“连接信息 → 凭据与保存时长 → SSH 预检 / 安装计划”。

私钥支持 temporary / managed；密码支持 one_time / temporary / managed。temporary 默认私钥 1 小时、密码 15 分钟，范围 60 秒至 1 小时，到期/Agent 激活提前清除。managed 默认私钥 90 天、密码 1 天，范围 60 秒至 365 天，需 confirm_managed；Agent 激活不提前清除。one_time 保留旧行为、默认 15 分钟、最大 1 小时，每次检查或终端释放即清除。所有策略仍加密、定时/读时清理与撤销失效。

部署/卸载能力使用可复用凭据数量（私钥或 retention 为 temporary/managed 的密码）；不以一次性密码数量开启。固定 SSH 执行器可用 ssh2 password 认证，密码仅放内存连接参数，enrollment token 经 exec channel stdin 传递；无 token/password argv、环境或日志。安装计划、指纹、目标版本、超时与审计守卫保持。

主机摘要新增公开 `sdk_environment`，从既有 id/name 派生，无需新增主机身份。名称拒绝控制字符，shell 配置严格引用；用户自定义 Unicode 名称保留。Node/Python/Go/Rust SDK 仅从启动环境补充缺失的 resource 属性；不读取未知路径或扫描 Agent。Node 入口处理环境，browser 入口不访问 process。无变量保持兼容；变量不作为认证。

固定安装器新增可选 machine-id / machine-name 元信息参数，传入 Agent 配置并在 Agent 自用 SDK 中附相同声明。部署的 Agent 仍使用自身持久 agent_id / host_id 和独立 control/data 凭据。环境配置需用户注入业务 systemd/Compose/K8s 启动环境后重启，不自动修改运行中业务、系统主机名或全局环境。

本轮同时更新系统设计与 Doca 并回读。036 目标设计与本增量分别标识：036 的显式绑定及汇总未实现，本增量只提供声明变量、限时凭据和登记安装主路径。
