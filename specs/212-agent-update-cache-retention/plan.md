# 设计

## 现状

`pinFile` 把发行文件复制为 `<cache>/<sha256>`（0600、staging+rename 原子落盘），`verify` 在下载服务与执行前校验固定字节。文件没有任何删除路径；活动计划（`awaiting_approval/running/verifying/unknown`）的 `plan_json.files` 是唯一合法引用。

## 方案

- `AgentReleaseCatalog.prune(retained: Set<string>, keep = 8)`：枚举缓存中 SHA256 命名的普通文件，按 mtime 降序保留前 `keep` 个与 `retained` 中的引用，删除其余并清理进程内哈希缓存；staging 文件（点前缀）与非文件条目跳过。返回删除数量。
- 触发点：`registerMachineAgentUpdates` 构造 catalog 后（启动时）与每个维护计划成功入库后（DB 事务提交之后，避免事务内文件系统操作）。保留集合 = 活动状态计划 `plan_json` 中出现的全部 64 位十六进制值（指纹等额外命中只会多保留，不会误删）。
- `keep=8` 覆盖最近两版双架构 bundle 与维护脚本；更大复用窗口由后续需要再评估。

## 备选方案

- 按字节预算回收：需遍历累加与边界策略，复杂度收益比低。
- 人工清理脚本：不可持续且易误删活动引用，不采用。

## 风险

- 活动计划判定依赖状态集合：与升级模块 `ACTIVE` 围栏一致；`unknown` 计划始终保留其引用。
- mtime 在极端情况下相同：排序不稳定只会影响等旧文件间的取舍，不触碰保留集合。
