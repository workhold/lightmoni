# 设计核对与待实施验收

本次为设计交付，不运行产品测试来冒充新功能已实现，不更改本地/线上平台数据。界面草图只使用模拟数据，无后端请求。实现任务明确保留未完成状态。

## 代码事实依据

- `web/src/app/HostsNodesPage.tsx`：当前统一页面的三页签和说明。
- `web/src/app/MachinesPage.tsx` 与 `agent-model.ts`：现有 SSH 能力、Agent 显式关联、控制心跳和批量操作。
- `runtime/src/server/managed-machines.ts`：当前资产/SSH 字段与管理员权限；只有登记连接，尚无 SDK-only 资产接口。
- `runtime/src/server/nodes-model.ts`：Agent 具有独立 id 与 host_id，不能拿它们替代主机资产 ID。
- `sdk/typescript/src/core.ts`：实例 ID 默认随机；resource 可配置；自监控约 30 秒，匿名、本地停报或关闭自监控时不发送。
- `runtime/src/server/ingest.ts`：SDK service/instance/host 来自资源，key_id 由中心接收认证路径提供；SDK 心跳进入规范化系统数据。
- `runtime/src/domains/system-dashboards.ts`：旧 SDK 大盘 90 秒 event_time 判断，不能直接代替本提案的双时间与归属区间判定。
- `runtime/src/server/service-deployments.ts`、`deployment/telemetry-query.ts`：已有 machine 服务目标和 table/service/instance 遥测验收，但没有完整 SDK 主机归属或 Key 身份绑定。

## 实现阶段必须通过

| 场景 | 预期 |
| --- | --- |
| 无 SSH、无 Agent，仅资产 + SDK | 可登记/关联并显示近期心跳；SSH/Agent 操作有原因 |
| Agent 心跳正常，SDK 从未有心跳 | Agent 在线；SDK 尚无可用心跳，不能一起标绿 |
| Agent 超时，SDK 心跳新鲜 | Agent 超时；SDK 近期上报，不判整机离线 |
| 只有未绑定 Agent 的主机 | 未接入，不宣称未安装；SSH absent 证据带时间 |
| 同主机多个服务/多实例 | 精确 selector 与单项状态；不以历史总量计算健康比例 |
| 随机实例 ID 重启/并发复用固定 ID | 新实例未关联；复用冲突不能自动合并或双重归属 |
| 页面未打开期间上报后停止 | 详情有界历史可补曾收到证据；未覆盖时保守说明观测范围 |
| 正常顺序迁移/版本更新 | 不因历史属性不同永久判冲突；并发声明不一致需核对 |
| 相同 Key 被多服务共享 | Key 不充当主机 ID，解绑不撤销整把 Key |
| 不同 Key 伪造相同 service/instance/host.id | 不能点亮其他 Key 的已确认关系，不获得控制权 |
| 历史补传、未来时间、样本 max 混配 | 无合格同条心跳不点亮；原因可见 |
| 迁移前事件在迁移后才接收 | 不点亮新关系，历史归属不回填 |
| 匿名、本地自监控关闭、平台停报 | 不伪造进程离线；只有已知策略给确定原因 |
| ClickHouse 故障/超时/截断/字段不兼容 | source_state 不完整、计数 null、缓存带原时间 |
| Key 轮换、迁移、解绑后再次上报 | 必须确认归属；旧配置不自动恢复 |
| 关联/迁移/主机删除并发 | revision 与唯一约束拒绝冲突，审计/关系事务一致 |
| 旧 DELETE/agent-link 与新关系并存 | 不能绕过影响预览或静默丢关系，返回 409 |
| 普通成员/AI 直接写入或越权读摘要 | 服务端 403，不请求秘密或扩大现有可见范围 |
| 请求重复/响应丢失/重启 | 同 request_id 返回原回执，不重复迁移/删除 |
| 关联筛选/主机列表分页 | 每页有界查询，无全表 N+1；目录与数据错误不当无数据 |
| Agent 移除/卸载、主机删除 | SDK 直报与共享 Key 不受远端程序操作影响；关系终止有历史 |
| 中英文/390px/键盘和深浅色 | 独立状态有文字/时间，详情与批量流程可操作 |

## 设计同步与交付证据

- 独立复核需求、HLD/LLD、契约与交互，未发现阻断问题；已补充未被页面观测的历史心跳范围，以及只在重叠窗口核对身份元数据冲突，避免正常版本更新被永久拒绝。
- 本地交互草图比较“三行概览”和“独立状态列”，推荐三行概览。使用模拟数据，验证选择/全选/清除、SDK 实例详情、批量操作预览及方案切换；320/390px 与浅深主题检查通过，JavaScript 错误为 0，页面无横向溢出，窄屏表格可局部横向滚动。草图不请求平台 API、不执行真实安装或删除。
- 仓库系统设计新增 13.1“目标”提案，与本规格一致，不改写现行功能事实。
- [Doca 系统设计](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53) seq772 → 773，保存确认后以 seq773 回读。新增 10 个块，其中 9 个文字块一致；新增原生流程图 9 节点、9 连线一致；原有 294 个块和 7 幅原生图完整对象保持不变。只核验原生结构回读，不声称已完成 Doca 图形的像素渲染验收。证据见 `doca-sync.json`。
- 本轮只增加设计文档，未改运行代码、SDK 协议、平台数据或远端主机；不重复运行产品测试，也不将 PR 中旧实现的测试记录作为本提案已实现的证据。
- `git diff --check` 通过；8 个设计/同步文件检查未发现凭据模式，回读证据 JSON 可解析。提交前 fetch `origin/main`（`dd1279b`），主干已包含于当前分支，无需合并冲突处理。设计增量更新现有 [PR14](https://github.com/workhold/lightmoni/pull/14)，不自动合并。
