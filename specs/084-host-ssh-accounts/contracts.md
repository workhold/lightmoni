# 契约

## 存储与响应

- managed_machines：移除username/default_credential_id，新增default_account_id。
- machine_ssh_accounts：id、machine_id、username、revision(正整数)、default_credential_id、created_at/by、updated_at；deleted_at（软删除）；仅deleted_at为空的记录UNIQUE(machine_id,username)。username不可修改。删除后同名账户使用新ID，不继承旧绑定、检查或授权，历史身份和审计保留。
- machine_credentials：新增非空account_id；effective_machine_credentials暴露account_id、username和account_revision。凭据库的秘密不携带用户名，同一秘密的账户授权相互独立。
- 主机响应包含accounts数组、default_account_id；无主机级username/default_credential_id。凭据响应包含account_id/username，供所有选择框明确身份。
- SSH执行目标为从主机资产+账户+凭据解析出的快照；主机自身不携带登录用户名。

## API

| 接口 | 语义 |
| --- | --- |
| POST /machines | 仅资产name/address/port/connection_method等，不接受username或登录秘密 |
| GET/POST /machines/:id/accounts | 列账户或以username创建，不连接目标主机 |
| PUT /machines/:id/default-account | {account_id}，只改默认选择 |
| DELETE /machines/:id/accounts/:accountId | 未决维护拒绝；撤销本账户授权并结束关联终端，保留审计，不影响其他账户 |
| POST /machines/:id/accounts/:accountId/credentials | 现有新秘密/库引用和期限字段，可make_default；返回含账户身份的绑定 |
| PUT /machines/:id/accounts/:accountId/default-credential | {credential_id}，必须属于该账户 |
| DELETE /machines/:id/accounts/:accountId/credentials/:credentialId | 仅解绑此账户授权 |

单账户SSH预检/终端/维护API继续使用credential_id作为明确选择的账户凭据授权ID；默认选择仅限主机显式default_account_id内显式default_credential_id，不搜索另一个账户、不在失效时回退。每个结果和计划包含account_id、username和account_revision。权限不足响应包含固定reason与同主机安全候选元数据，秘密不出响应。

旧主机级凭据路由删除，旧username输入拒绝400，不提供兼容别名。中心数据库基线升级，旧基线拒绝运行并给出备份/新目录说明，不执行破坏性清空。

## 账户检查与权限恢复元数据

accounts[] 包含 id、machine_id、username、revision、default_credential_id、created_at、created_by、updated_at、credentials、last_check、check_fresh、recommended、recommended_credential_id。credentials 为不含秘密的绑定字段，并带 account_id、username、account_revision。SSHCheckResult 顶层也包含该账户三字段。

last_check 为该账户最新保存的检查，未检查时为 null。check_fresh 要求目标修订与当前主机一致、检查未过期、检查凭据仍有效，且账户及凭据修订完全一致。recommended 进一步要求 connected=true 且实际 privilege.state 为 root 或 sudo_noninteractive，才设置 recommended_credential_id；其他情况该字段为空。不得通过用户名猜测权限。

权限不足的检查响应带 permission_recovery:{reason:'ssh_privilege_required',accounts:[同主机账户安全元数据]}。此信息仅供用户明确选择账户重新检查，不自动修改默认账户、不替换已批准身份、不执行任务。账户删除阻止终端、在途或结果未决维护；撤销仅该账户绑定并保留历史审计。

## 安装预检自动选择

POST /machines/:id/installation-preflight 接收 {selection:'auto'|'manual',credential_id?}。auto 禁止 credential_id；manual 必须指定 credential_id。一般 SSH 检查与终端继续保持明确账户选择语义。

auto 仅在本主机 live 账户的有效可复用凭据绑定内选择，优先 root 用户名，随后是具有新鲜 root/sudo_noninteractive 检查证据的账户；root 名称仅用于排序，必须真实连接检查权限。凭据失效、连接或鉴权失败、权限不足可继续下一候选。主机身份不匹配、取消、超时、无效响应或已具有权限但缺失其他安装条件时停止。预检只执行平台固定读取检查，不签发 enrollment、不修改远端安装。安装生成计划后锁定最终 check_id、账户快照和凭据修订；安装执行阶段、远端已变更或结果 unknown 后绝不自动换账户重放。

结果为 SSHCheckResult，并带 installation_selection:{id,mode,selected_credential_id,attempts:[{check_id,credential_id,account_id,username,account_revision,connected,ready,error_code,privilege_state,checked_at}]}。成功 selected_credential_id 对应最终 ready 检查；全部失败仍返回最后检查与尝试，无有效候选返回 409。

GET /machines/:id/installation-preflights 返回最近100次选择审计，包含模式、状态、最终凭据、发起人、起止时间及每次候选尝试的固定账户身份、状态、check_id 与安全结果。尝试在连接前写 running，结束后写 completed/failed，进程中断保留 running 作为未知证据，不自动重放。
