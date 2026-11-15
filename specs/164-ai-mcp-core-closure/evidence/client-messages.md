# 脱敏客户端最终消息

## e2e1-read

```text
查询结果如下：

- **实际 `table_id`**: `log_app`
- **返回行数**: 3 行（`limit=5`，实际命中 3 条）
- **示例行**:
  - `service`: `core-e2e-service`
  - `event_time`: `2026-11-14T14:52:53.139000000Z`
  - `severity`: `INFO`
  - `body`: `sample payment completed`
  - `attributes`: `sample_id=2`, `status=200`

备注：`lightmoni_telemetry_catalog` 中列出的日志表名为 `lightmoni_log`，但 `lightmoni_logs_search` 对 `log_app` 查询成功并返回了真实数据。
```

## e2e1-denied

```text
已按你要求直接调用 `lightmoni_hosts_get`，输入 id 为 `e0496b8d89f4ece7`。服务端返回拒绝信息如下：

```json
{
  "schema_version": 1,
  "error": {
    "code": "not_found",
    "detail_code": "resource_not_found",
    "message": "调用未完成，请检查权限、参数或目标状态。",
    "retryable": false
  }
}
```

- `detail_code`: `resource_not_found`
- `code`: `not_found`
- `retryable`: `false`

说明该主机 ID 不存在或当前无权限访问。
```

## e2e2-propose

```text
- `data.proposal.id`: `e4cae603d10917f557a04e14bb94f72e`
- `status`: `awaiting_approval`
- `review_url`: `https://localhost:53728/api/v1/assistant/alert-proposals/e4cae603d10917f557a04e14bb94f72e`

该静默窗口提案已创建，等待审批；尚未生效。
```

## e2e2-readback

```text
查询完成，记录存在。

**静默详情**

| 字段 | 值 |
|------|-----|
| **id** | `beaef3873e5a9d0df4de314c6c32768b` |
| **scope** | `all` |
| **until** | `2026-11-14T16:53:39.049Z` |
| **version** | `1:bc25ccfc5e64eac29765cc490b387bd533408baf4afdecd891e316d0c5538484` |

附加信息（来自精确读取）：
- **from**: `2026-11-14T14:48:39.051Z`
- **reason**: `core-e2e maintenance`
- **timezone**: `Asia/Shanghai`
- **created_by**: `e8043d216fd0a08b7fa5fe8fae4e0cdc`
- **revision**: `1`

当前静默列表共 1 条记录，与精确读取结果一致。
```

## e2e3-propose

```text
- proposal id: `9e37793e-d15c-4740-82cc-f63648700a48`
- status: `awaiting_approval`
- review_url: `https://localhost:53728/machines?tab=tasks&proposal=9e37793e-d15c-4740-82cc-f63648700a48`

该提案处于待审批状态，尚未执行。
```

## e2e3-replay

```text
- `id`: `9e37793e-d15c-4740-82cc-f63648700a48`
- `status`: `awaiting_approval`
- `review_url`: `https://localhost:53728/machines?tab=tasks&proposal=9e37793e-d15c-4740-82cc-f63648700a48`

该调用仅创建了待审批的 task dispatch proposal，尚未执行。
```

## e2e3-readback

```text
查询结果如下：

- **native_state**: `succeeded`
- **run ID**: `task:8ed83756-db0b-4850-93a7-17cbfaf5c68b`
- **review_url**: `https://localhost:53728/machines?tab=tasks&task_view=runs&host=e0496b8d89f4ece7`

该任务已成功完成（`state: succeeded`），非 queued/running/unknown 状态。
```
