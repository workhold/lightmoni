# SDD081 验收

用户明确取消预发布版本兼容义务，并授权清理后通过 GitHub PR 合入 main、发布 Docker。已同步 main 的 PR #68 主机删除保护。

## 清理结果

- SQLite 将最终字段和索引直接放入 CREATE TABLE；中心和管理员 CLI 共用 center_schema=1，旧无标记数据库明确拒绝且不修改。
- ClickHouse 删除补列、旧系统表搬运与别名，只建立现行表、指标逻辑视图及保留期配置；移除已由 value_int/value_float 替代的 Decimal 冗余存储列。当前自监控统一 lightmoni_log/lightmoni_metric_*。
- 删除旧 Agent 分组、旧平台 node_pool/service/gateway_group 控制器、单集群转换、旧实例表、系统应用别名、主机密文搬运/回退、地址猜测、旧费用账本回填、旧告警策略与 Go JSON 编码适配。
- 写操作固定交给独立执行器，删除普通 Agent 私有写载荷/制品下载路由、separateExecutor 开关、旧任务搬运及 migration/migration-worker 离线命令；保留签名、审批、unknown 栅栏与当前程序回退。
- SDK Key 删除范围数据库/API 字段；SDK 配置总是返回 metric_windows，所有当前 SDK、脚本及内置大盘使用现行协议。端口只用 host_ports 命名映射。
- 部署仅保留根 Compose；移除重复入口和历史专用测试/夹具，生成的 TypeScript SDK dist 与 tsbuildinfo 不再进入 Git。

保留理由：OTLP/OpenAI/S3/第三方应用协议为当前集成；数据库 TTL 调整为用户配置能力；root journal 结构检查是损坏拒绝；已安装应用的恢复、数据移动限制和同基线程序回退为当前功能。未操作用户实际数据或部署主机。

## 架构同步

影响存储初始化、字段/接口与权限控制路径，以及部署入口。仓库 docs/system-design.md 的初始化、凭据、部署、执行器章节和第81节已同步。

[Doca 系统设计基线](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53) 保存成功，最新 seq=934 回读：20处目标文本一致、38个原生图块完整相同（含节点、连线和布局）、726个无关原有块完整相同，新增章节位于文末且为 h2，文档名称正确。详见 evidence/doca-sync.json。

## 自动验证

- runtime / ai-runtime / web 类型检查及完整构建通过。
- AI runtime 71项、TypeScript SDK 22项、Go SDK全部、Python SDK 33项通过。
- Web 模型/查询/权限等131项通过。
- Linux root 专项32项通过，覆盖真实 root 文件权限、制品校验/路径拒绝、备份与恢复，以及执行锁。
- Linux 非 root 全量1496项：1461通过、35项条件跳过、零失败；root专项补充执行需特权的制品/备份测试，32项全部通过。
- Rust SDK4项及文档测试通过（隔离Rust 1.99.0、已校验锁文件和现有离线crate缓存）。
- 最终 Decimal 列清理后的指标/配置/上报专项33项通过；公开value仍来自value_float，精确整数使用value_int。

摘要与日志SHA256见 evidence/automated-checks.json。

Linux测试使用隔离 Node 24.15.0 容器，所有路径为临时目录，外部 SSH/真实业务主机未使用。依赖完整系统服务、Docker或外部端点的条件测试会单独标明，不把跳过计为通过。

## 交付

发布镜像从最终合入源码构建，固定 OCI revision；双架构完成后记录标签、摘要、真实 ClickHouse/下载包验证和远端回读。发布不等于升级任何已有环境。

发布前交叉检查补充：Agent心跳生产者移除已退役的value字段，仅发送当前value_type/value_int/value_float；新增领域回归校验与最终ClickHouse列保持一致。这是对本SDD已同步基线的实现修正，无新增架构变化（Doca同步不适用，沿用seq934模型）。

## Docker 发布完成

源码来自已合入 main 的 PR #69 与 #70，固定提交 `9c50a99826d87ebeb7b6d4ed5f50d9b727653ceb`。构建上下文由 git archive 生成，含完整 tree、archive 和 Dockerfile SHA256 的输入记录见 evidence/build-inputs.json。

发布 `docker.heyphp.com/lightmoni/lightmoni:20261102-9c50a99` 与 `latest`，二者索引摘要均为 `sha256:36663e3f3039511daac30ebc190370dc81e66626cb82c265ebfbadca2d172a8a`。

| 平台 | manifest digest |
| --- | --- |
| linux/amd64 | `sha256:0fcfd3be5fc1e7348c18db66abefcb35014d9e1c9033247008eda48809746839` |
| linux/arm64 | `sha256:453b764d2f3702fd0bf5cac7536cfec0005e2e0e10095ca586c9dda5cd247b0a` |

两平台各39项真实镜像验收全部通过：非root中心、CLI先初始化后启动、最终SQLite结构、严格SDK字段、配置周期、SDK Counter/Gauge/record Histogram真实ClickHouse入库、Agent心跳指标无旧Decimal列、签名应用观测的持久ACK与真实导出、证书生成/导出、两种Agent及四种SDK下载和完整校验、执行器维护解析、普通与root权限隔离、重启后会话及种子数量。AMD64在本机Docker仿真执行，ClickHouse为隔离ARM64实例；这不代表生产主机systemd或真实公网ACME/S3验证。

两平台47个生产前端产物SHA256完全相同。仓库根Compose固定新标签，只有中心与ClickHouse两个服务，保留健康依赖与原状态/遥测卷，重复部署入口已删除。

远端GET核验索引/平台manifest/config及blob HEAD，并执行Docker按平台pull，rootfs和完整配置均与已验收镜像一致。发布前28个历史固定标签摘要全部不变。测试容器、卷、网络与运行时凭据已清理，原15个运行容器完整保留。最终回读、镜像验收、前端、Compose和清理证据均在 evidence/。

发布打包与说明修正不新增架构变化（不适用）：沿用PR #69已同步的单一基线，Doca seq934保存和回读结果保持有效。发布不自动升级用户环境；旧无标记开发库仍需管理员备份后以新目录重建。
