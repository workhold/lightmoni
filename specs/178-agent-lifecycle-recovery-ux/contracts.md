# SDD 178 契约

## 进度

- 百分比只接受已知执行阶段枚举，取最后一条已知执行事件的阶段和时间；malformed、未知及未核验的远端终态事件不推进阶段。
- 卡片终态文案只由平台记录状态决定；只有平台状态为 succeeded 才显示成功，只有平台状态为 rolled_back 才显示已恢复。
- 没有事件时执行中显示 0% 和“等待服务端阶段记录”；终态 succeeded 为 100%。失败、回退和 unknown 不表示目标成功。
- 卡片继续只轮询同一 machine/update ID。

## 权限默认

- 运行模式证据优先使用 `machine_agent_runtime` 的实际记录，其次最近成功安装计划的 runtime_mode；只输出 root/user，不输出配置或凭据。
- 无证据沿用既有默认 root；任何明确输入仍须通过原校验。证据不是授权提升的替代品。
- 批量模式只有用户尚未修改且详情存在仅监控历史时才自动改为 user。

## 身份收口

- 激活事务按 enrollment ID 取消同机其他 active enrollment；当前记录和其他主机不变，同 Agent 的重复 active 记录也被收口。
- 不改变 pending_activation/issued 的激活、下载、到期和并发语义；事务失败时不得产生部分收口。
