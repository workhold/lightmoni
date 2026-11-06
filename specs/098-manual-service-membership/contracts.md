# 控制与状态契约

| 条件 | 手动模式 | 托管模式 |
| --- | --- | --- |
| 从未就绪 | 不发布成员 | 不发布成员 |
| 已就绪后失联/不健康/意外停止 | 保留成员；ready=false、availability=retained | 宽限后按最小预算撤流或保留 protected |
| 原成员被旧健康逻辑撤下 | 有 last_ready_at 且仍获授权时恢复成员 | 不自动重新加入已撤成员 |
| 对账确认漂移或已知写失败 | manual_deployment_action_required；仅继续只读核对 | 沿既有预算调度修复 |
| 人工停止/卸载/修改发布目标 | 按人工期望撤成员及对应 DNS | 按人工期望撤成员及对应 DNS |
| 旧 Agent 撤销/机器绑定变化 | 拒绝复用旧身份 | 拒绝复用旧身份 |

网站失败回执可含 published={state:succeeded,revision,enabled}，仅保留最后成功发布的简短证据，不递归保存失败历史；当前 state/error 继续显示真实失败。DNS 核对当前授权配置与成功版本交集，不发布尚未成功的新增域名。

HTTP API 路径与确认参数不变。实例状态新增 `availability=retained`；健康计数不把保留成员视为确认健康。旧发布的成功证据和 DNS 所有权日志保持，外部 DNS 记录仍不收养、不删除。
