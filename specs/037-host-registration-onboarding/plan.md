# HLD / LLD

登记主机继续复用 `/machines` 和 `/machines/:id/credentials` 两步接口：第一步生成资产，第二步保存加密凭据。第二步失败明确保留已登记主机，可重试，不伪装原子成功。前端明确“连接信息 → 凭据与保存时长 → SSH 预检 / 安装计划”。

私钥支持 temporary / managed；密码支持 one_time / temporary / managed。temporary 默认私钥 1 小时、密码 15 分钟，范围 60 秒至 1 小时，到期/Agent 激活提前清除。managed 默认私钥 90 天、密码 1 天，范围 60 秒至 365 天，需 confirm_managed；Agent 激活不提前清除。one_time 保留旧行为、默认 15 分钟、最大 1 小时，每次检查或终端释放即清除。所有策略仍加密、定时/读时清理与撤销失效。

部署/卸载能力使用可复用凭据数量（私钥或 retention 为 temporary/managed 的密码）；不以一次性密码数量开启。固定 SSH 执行器可用 ssh2 password 认证，密码仅放内存连接参数，enrollment token 经 exec channel stdin 传递；无 token/password argv、环境或日志。安装计划、指纹、目标版本、超时与审计守卫保持。

主机身份继续使用既有 `managed_machines.id/name`：POST 由中心生成不可变 ID，用户填写名称；PUT 只修改允许的描述及连接字段，不接受用户指定或修改 ID。同名资产允许存在，以 ID 区分，名称拒绝控制字符。列表和详情继续展示名称和稳定 ID。SDK、Agent 配置及安装器恢复此前契约，不生成 SDK 环境摘要、不写入主机环境、不新增读取逻辑。平台与 Agent 的关联继续使用已有经认证的 `agent_id` 关系。

本轮同时更新系统设计与 Doca 并回读。036 目标设计与本增量分别标识：036 的显式绑定及汇总未实现，本增量只提供平台资产 ID/名称、限时凭据和登记安装主路径。
