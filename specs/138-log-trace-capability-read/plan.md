# 实施计划

## 1. Logs.searchRead 抽取

- 将现 Logs.search 业务逻辑原样迁移到 searchRead，HTTP search 只做 body 解析和 c.json。
- 使用真实 ownerID 和 AbortSignal，错误转为 HTTPError 状态，不伪造 Context。
- 返回增加 offset 供有界投影计算游标；原字段不变。

## 2. 日志有界投影

- LogReadService 调用 Logs.searchRead，默认 limit=50。
- 对当前返回 frame 做 60 KiB 投影；裁减行时将 next_cursor 调整为 offset+实际返回行数，truncated/capability_truncated=true。
- 冻结 Session 保留完整帧，后续 cursor 可读取未返回行；直方图过大时显式裁剪，无法安全缩小的元数据返回 result_too_large。

## 3. Trace 共享读取

- 将 traceDetail 的表/范围/查询/span 汇总迁移到 TraceReadService.get。
- 原 traceDetail 只解析参数并 c.json；新能力和内部助手调用同一服务。
- 保持 1 天、8 表、2000 span、missing_parents 和 incomplete 语义。

## 4. 能力注册与权限

- 注册 logs.search 和 traces.get 描述符，均为 R1、安装级、15 秒能力期限、30 次/分钟和 2 并发。
- 内部成员会话增加 logs.read/traces.read；外部 scopesForUser 不变。
- 增加内部 search_logs/get_trace 和 MCP 接入页中英文标签。

## 5. 验证与交付

- 添加 Logs/Trace 服务、投影、权限、内部助手和官方 MCP 客户端测试。
- 复跑 domains/log/trace、核心、描述符、遥测、告警和授权回归。
- 执行全仓类型检查、构建和 runtime 全量；main 既有失败单独对照。
- 更新系统设计、平台 MCP 和接入指南，提交功能分支并创建面向 main 的 PR；不沿用此前一次合并授权。
