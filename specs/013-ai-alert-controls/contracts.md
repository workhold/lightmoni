# 契约

## AI 工具

只读：`list_alert_rules`、`get_alert_rule`、`list_alert_silences`、`get_alert_silence`、`list_alert_groups`、`get_alert_proposal`。

提案：`propose_alert_change`，一次只允许 `rule.update`、`rule.silence`、`silence.create`、`silence.update`、`silence.end` 之一；必须有目标（创建静默除外）和变更原因。

## 确认

`GET /api/v1/assistant/alert-proposals/:id` 读取当前用户提案；`POST /api/v1/assistant/alert-proposals/:id/apply` 仅接受登录用户的显式确认。成功返回 completed 回执；过期、失权、版本冲突返回明确 409/403，不产生部分变更。

## 安全

模型没有 apply 工具；proposal/apply 以会话用户为准。返回结果不包含通知秘密、平台密钥或未授权表。所有列表分页且限制返回体大小。
