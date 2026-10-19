# SDK 通用打点验收 — 2026-10-19

最终入口为 record(table,metric_name,dimensions,value,count)，五个参数必填，普通观察传 count=1。service/env 初始化必填，service_version/instance_id 可选；SDK 自动聚合，界面不选目标表。

## 实际统计与兼容证据

- record-sdk.json：Go/Node/Python/Rust × 密钥/匿名，共8条真实 OTLP→ClickHouse→公开查询路径通过。每条路径1000次观察压为1个分布点；总数1000、总值500500、平均500.5、极值1/1000，九种百分位均在行记录的误差界内。Node 两种认证均模拟持久ACK丢失，重试批次与payload不变，FINAL查询没有重复计数。汇总100/5与200/10得到15人、总额300、平均20；汇总与单样本混合查询全体min/max/P为NULL。
- identities.json：8条路径实际存储的 env=test、service_version=v-record 与显式 instance_id 均正确。
- windows.json：两个实例各两个窗口、不同数据范围合并，共400次观察、4行聚合点，总值80200、平均200.5、极值1/400及九种百分位通过。关闭自身遥测后，未显式flush的业务数据仍在10秒周期上报。四个随包示例均只初始化service/env，环境配置传输，自动生成不同实例标识；总计4次请求/512ms与20人/总额400正确。
- migration.json：构造真实旧日志/直方图物理表（无新增固定列），两次重启后旧入口与统一新入口均各查到一行；component从旧表来源确定，env/版本从资源回填，count/sum保留，无重复。
- deployment.json：备份后更新唯一18380实例，管理员登录、4种SDK包、12个新旧查询入口、持久状态通过，用户1/大盘5/Agent1保留。备份位于忽略目录.local-dev/record-deploy/state-before，权限仅本机用户可读；证据不含密钥或密码。

## 检查与页面

- runtime完整套件：160项，156通过、0失败、4按条件跳过。两项真实中心/Agent live检查另行开启并通过7项子检查；Linux发布包检查另行开启通过1项。旧Go基线对照依赖未配置，仍跳过。
- Node SDK 16/16；Python SDK 28/28；Go SDK完整套件通过；Rust锁定依赖测试1/1，四SDK均另有上述真实上传证据。
- 新指数分布/汇总/非法输入/固定维度与自动收集测试12/12；样例生成器4/4；AI runtime71/71。全仓类型检查、构建、SDK包及Linux amd64/arm64 Agent发布包构建通过。
- verification-1/2/3.json：最后界面连续三次验证通过；密钥创建失败后保留名称、重试创建选择、三Tab四语言、匿名豁免增删/鉴权、旧安装入口、必填env、可选身份、五参数代码、SQL覆盖判断、390px/200%缩放/reduced-motion均通过，无pageerror。
- motion.json：首次进入220ms、认证切换160ms均记录开始/中间/结束，创建操作对话框→加载→创建选中通过，完整密钥已遮挡。
- 独立视觉评审未发现阻断问题；已采纳说明拆段、压缩折叠字段留白、单独说明缺少分布时min/max/P为空。最终截图位于本地 artifacts/screenshots/docs/evidence/telemetry-table-model（仓库忽略媒体），包括桌面、390px、200%缩放、动效帧及已部署页面。

## 重跑

仅针对隔离QA服务：18886后端、15176前端与deploy/server/compose.test.yml的ClickHouse，不指向用户运行实例。浏览器脚本会清理隔离服务的密钥/豁免配置，和其他验收顺序执行。

```sh
node --test web/src/app/sdkExamples.test.mjs
# Rust需要可用的cargo或LIGHTMONI_CARGO，依赖按sdk/rust/Cargo.lock锁定。
LIGHTMONI_RECORD_LANGUAGES=typescript,go,python,rust node scripts/verify-record-aggregation.mjs
node scripts/verify-record-windows.mjs
LIGHTMONI_QA_RUN=1 node web/src/app/verify-sdk-onboarding.mjs
LIGHTMONI_QA_RUN=2 node web/src/app/verify-sdk-onboarding.mjs
LIGHTMONI_QA_RUN=3 node web/src/app/verify-sdk-onboarding.mjs
node scripts/verify-sdk-motion.mjs
```

## 查询边界

指数桶为有界压缩分布；分位数对压缩代表值精确、对原始观察近似，最终scale与quantile_error可查询。sum/count/平均保留精确信息（数值遵循Float64精度），不能把count>1的总额拆成相同个体观察。缺少分布时全体min/max/P默认NULL；旧历史无可信分布也保守处理。速率使用查询跨度作为分母；时间边界按完整上报窗口解释。旧物理历史保留周期继续生效，旧查询入口和instrument API兼容。
