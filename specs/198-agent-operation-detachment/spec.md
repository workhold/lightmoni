# SDD 198：Agent 操作脱离请求生命周期

## 背景

Agent 首装、卸载、升级、回退和恢复都已使用持久回执与围栏，但部分已确认执行的 SSH 会话和 readiness 等待使用 HTTP 请求 `AbortSignal`。用户关闭页面、刷新或浏览器断开可能中止平台侧等待，把本可继续完成的操作提前变成 failed/unknown；页面恢复后又只能围绕 uncertain 记录核对。

## 目标

1. 管理员确认后的 Agent 首装、卸载、更新启动、维护恢复不再绑定 approving HTTP request 的生命周期。
2. 页面关闭只影响浏览器显示，不停止中心侧确认操作；中心仍按固定超时推进、落回执并释放围栏。
3. 重复点击同一记录时，持久状态原子更新继续拒绝第二次执行；UI 继续依赖现有轮询恢复显示。
4. 中心进程重启仍保留保守恢复语义：安装运行中转 unknown，卸载运行中转 unknown，Agent 更新运行中/核验中转 unknown，批次暂停；不自动重放。
5. 平台侧等待仍有 15 分钟上限，防止孤儿会话长期占用主机；远端 detached worker 自己的 systemd/runtime deadline 继续权威约束实际副作用。

## 非目标

- 不自动重试 destructive 操作，不把 unknown 改写为成功。
- 不实现跨中心实例的分布式任务队列；单中心重启后的继续动作仍按现有只读核对、恢复、或明确重审规则执行。
- 不允许取消已经切换的更新；正在 preparing 的既有可取消语义不变。
- 不改变审批、身份、快照、凭据 revision 或维护围栏校验。

## 验收

1. HTTP 请求在安装 readiness 期间断开后，安装记录继续 running，直到平台超时或健康确认完成，不因 controller abort 立即变成 cancelled/unknown。
2. 升级/回退 apply 与 recover 使用 operation signal；测试或代码审查确认请求 abort 不传入 SSH dispatch。
3. 卸载 apply 的只读复核与破坏性移除使用 operation signal；卸载只读 reconcile 保留请求 signal。
4. Runtime typecheck/build 和相关 managed machines、Agent update/uninstall 回归通过。
5. `git diff --check` 通过。
