# 142 · 大盘只读能力

状态：已实现，待 PR 审核。继承 SDD 046/047/134～141 和全平台能力开放 Goal，本切片是 Slice 2 的大盘领域。当前 stacked 基线包含 SDD 138～141；PR #192～#195 未获本轮合并授权，本切片独立创建面向 main 的 PR 并明确依赖，不自动合并。

## 需求与范围

1. 抽取 DashboardReadService，复用 Dashboards 的自定义/系统目录、详情和版本记录，不复制持久化或 revision 逻辑。
2. 新增 dashboards list/get/versions；列表支持 custom/system/all、search 和分页，详情读取完整面板/查询，版本读取保留真实 revision 元数据。
3. 新增 `dashboards.read` 与 `dashboards.detail.read`；完整 SQL/面板定义仅属后者。全部安装级授权，有限主机不能调用。
4. 内部新增 list_dashboards/get_dashboard/get_dashboard_versions；成员保留平台既有内部/Web 大盘读取，外部 PAT/OAuth 仍只向管理员发 Scope。
5. 大结果有界且不能把不完整大盘当作可保存草稿；本切片不开放保存、复制、删除、告警草稿或 AI draft_dashboard 外部化。
6. 原 Dashboards Web API、内置 seed 更新和版本历史行为不变。

## 非目标

- 不改变 Dashboard 数据模型、布局、SQL 校验或 seed 策略。
- 不提供主机级大盘授权，不开放任何写入。
- 不宣称 Slice 3 大盘提案或其他领域已完成。

## 验收

1. 自定义/系统目录、详情和版本均来自真实 Dashboards，原 domains 测试通过。
2. dashboards.read 不能读取完整详情，detail Scope 独立；有限主机和外部成员边界生效。
3. 内部成员可读取，新工具通过 Dispatcher；结果大小和不存在对象有明确错误。
4. 官方 MCP 客户端发现/调用三个能力，无 save/copy/delete/draft 工具。
5. 相关回归、类型检查、构建和 runtime 全量与 main 基线对比有真实记录。
