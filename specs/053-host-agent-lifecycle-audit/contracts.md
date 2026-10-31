# 既有契约与回归边界

沿用 SDD 031/032/038/040/045/050/051 的主机凭据、登记身份、SSH、生命周期和网络观测契约。HTTP 路由、Agent 控制凭据和安装包格式在发现架构级缺陷前保持现有定义。

- 仅当前目标和请求代次可以更新对应界面；关闭、切换主机或权限变化使旧请求失效。
- 凭据到期、撤销和解绑阻止其后续使用，不能静默更换已批准目标或恢复秘密。
- 未执行计划可取消；已开始操作按真实执行与核对结果结束，不因网页关闭或轮询失败虚构成功。
- SSH 断连、程序切换不完整和证据不足保留明确失败/未知状态及可核查记录。

实际新增回归与修复清单记录在 validation.md，必要的契约细化应在实现前补入本文件。

## 首装未知结果与恢复

`machine_deployments` 增加非秘密的 `enrollment_id`、`execution_stage` 和 `resolved_at/resolved_by/resolution_reason`。阶段区分 `legacy_unknown`、`planned`、`preflight`、`enrollment_issuing`、`enrollment_issued`、`bootstrap_dispatched`；旧记录使用未知阶段。状态增加 `unknown`，人工结束仍保留 unknown 并以 resolved 字段标识结束。该状态不得描述为安装成功或已卸载。

- `POST /api/v1/machines/:id/deployments/:deploymentId/reconcile`：管理员，输入可选 `credential_id`；无用户脚本/路径，固定已审阅 SSH 目标与原 enrollment 的 Agent。校验新凭据、主机指纹、连接 revision、真实归属；核对失败或证据不全保持 unknown，不重放安装。
- `POST /api/v1/machines/:id/deployments/:deploymentId/resolve`：管理员，输入 `confirm:true` 与非空原因；只允许未结束 unknown，记录人工确认，取消原未激活票据并撤销原 enrollment 精确新身份凭据。旧身份、其他 enrollment 与主机不可受影响。存在未结束有限任务时拒绝。
- 成功核对要求本次 enrollment active、当前 Agent 归属正确、有效 control 凭据、远端完整且运行的受管服务、无生命周期锁、启动后的新鲜心跳（仅有限未来时钟容忍）；不能只凭 activation 或旧心跳成功。
- 启动恢复和 bootstrap 已派发后异常进入 unknown；明确未派发阶段可在取消未激活票据后失败。旧记录或 issuing 阶段缺少关联时保守 unknown。
- unknown 未 resolved 与 running 加入安装、卸载、维护、编辑、删除、重绑定及有限任务派发/领取的冲突保护，避免平台重启丢失内存 busy 后绕过。终端与只读检查保留人工核查能力。

## 已确认的既有契约缺口

- apply 的新 SSH 预检必须再次匹配审批架构，变化时在 enrollment/远端安装前拒绝。
- 卸载及核对需同时识别 Agent job、通用 script task 和运维锁；不能因任务尚未反馈到中心而删程序或 purge 数据。
- 首装失败仅清理本次新建、已为空的程序目录；不清除先前配置、身份、状态或未知残留，不放宽 fresh 覆盖保护。
- 卸载固定 SSH 调用完成后同时更新主机凭据绑定与集中凭据源的最近使用时间。
- 浏览器中丢失创建/执行响应时不盲目重放；先恢复持久记录或明确提示返回列表核对。人工审阅入口始终指向原固定计划。

## 本地卸载的任务互斥

有限脚本的 `task-run-state.json` 与 `agent-job-state.json`、`operations/execution.lock` 同属未完成操作证据。卸载脚本、固定 SSH 卸载模板及只读探测不能遗漏任一种；服务未运行或 unit 不存在也不能据此忽略未完成任务。非空任务 ID 阻止卸载和 purge，保留程序及所有持久数据；已清空 ID 的完成标记不阻止正常卸载。

## 首装失败后的空目录恢复

首装失败且文件回滚成功时，只允许用非递归 rmdir 清理本次新建且仍为空的程序根目录及 releases 目录，避免这些空目录阻止下一次首装。预先存在的程序目录、非空目录及保留的配置、身份、队列和执行状态不因此删除；保留 identity/config 时仍拒绝 fresh。
