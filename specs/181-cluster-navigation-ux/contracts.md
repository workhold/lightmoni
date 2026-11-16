# SDD 181 契约

- `/clusters` 在 `navigationGroups` 和 `navigationLinks` 中只出现一次，adminOnly 为 true，顺序位于 `/private-images` 与 `/applications` 之间。
- 主机 `cluster_id` 为空字符串表示未分配；`cluster_name` 缺失时回退集群 ID。无 ops 表也返回相同空值结构。
- `unassigned` 只匹配空 `cluster_id`；其他值按精确集群 ID 匹配，空筛选匹配全部。
- 集群列只链接详情，不提供写操作；原 `group` 标签筛选保持独立。
