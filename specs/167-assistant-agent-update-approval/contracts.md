# SDD 167 契约

## 工具结果识别

仅接受包含字符串 `id/machine_id/action/status`、`plan.current`、`plan.target`、`plan.expires_at` 的记录；action 仅 `upgrade|rollback`，status 使用原生集合。非法或不完整结果不显示审批动作。

## 原生 API

路径复用 `updatePath(machine_id, update_id)`。Apply 前先 GET 当前记录，只有当前仍为 `awaiting_approval` 且无 `rollout_id` 才允许 POST `/apply {confirm:true}`；取消走 `/cancel {}` 并要求 Popconfirm。所有 ID 均 URL 编码，禁止工具结果指定任意审批 URL。

## 状态语义

`awaiting_approval` 只表示待审批。Apply 的 202 仅表示执行接受，随后展示 `running/verifying` 和原 `review_url`，不代表升级成功。只有当前记录为 `succeeded` 才能显示成功。`rolled_back/failed/unknown/cancelled` 不显示为成功。

## 权限与更新范围

审批仍由原管理员会话和 API 授权，原生 revision、owner、凭据、有效期和任务围栏全部生效。刷新发行目录不等于批准更新；已有维护/任务的拒绝不得自动重试。
