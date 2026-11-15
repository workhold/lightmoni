# SDD 165 实施计划

1. 固定最新 `origin/main` 基线与生产只读证据，记录内部和外部遥测契约的差异，先补目录、样本、时间宏和最后步骤回归测试。
2. 在内部助手目录投影中移除全量列定义，按完整表摘要逐项装入 12KB 预算；保留合法 JSON、明确截断标记和单表完整描述，不改变 MCP 投影。
3. 按查询来源分离样本字节预算：助手 16KB、MCP 60KB；保留既有行数限制、错误与截断语义。
4. 使用 Mastra `prepareStep` 在最后一步设置无工具选择，补四协议持续工具请求 fixture，验证最终回答、checkpoint、用量与取消不被绕过。
5. 更新系统与工具指令：已选表直接 `describe_table`、单表优先、必须使用 `$__timeFilter(column)`、核验分组/排序列并限制无效重试；仅对 assistant 增加执行前时间宏校验。
6. 运行相关 runtime/AI runtime 测试、全量必要回归、typecheck、build、`git diff --check` 和 Markdown/代码围栏检查；如实记录 fixture 与真实生产验证的边界。
7. 同步最新 main、处理冲突，通过功能分支创建 PR；获得本次明确合入授权后按仓库 merge commit 方式合入，不直接推送 main。
