# SDD117 验收

来源：通过Doca MCP全文读取[部署模块问题跟进](https://doca.heyphp.com/#/r/9dae6ec8-5781-4cb6-9c08-27599162af91)。原6条“已解决”不重复开发，逐项核对第8—18行11条待办。基线为GitHub `origin/main`，原工作目录的旧分支、未提交compose和发行证据保留。

| 原行 | 问题与最终处理 | 证据/范围 |
| --- | --- | --- |
| 8 | 八种后端SDK默认hostname，显式配置优先；核对指标命名并补契约回归 | [遥测](evidence/telemetry.md)。主干业务`metric_*`/系统`lightmoni_metric_*`本已一致，未改历史物理表 |
| 9 | 主机页发现外部Compose，原YAML登记→检查→人工审阅接管，保留项目/卷 | [部署](evidence/deployment.md)，真实Docker重建后sentinel不变；有限配置，不复制为第二项目 |
| 10 | Registry原生标签接口保留，manifest最多4并发、在途去重、标签顺序稳定 | 100标签峰值4、共享子摘要一次；完整引用保护回归 |
| 11 | 修复大盘连续保存竞态与原生图高度；复测Grafana交互及2000行日志 | 主代理连续三轮，见下表。日志已有虚拟化/缓存仍保留；加载和关键词阶段仍有长任务，未声称任意规模无卡顿 |
| 12 | YAML和文件改用本地Monaco高亮，保持原字符串、Form禁用、明暗主题 | [文件](evidence/files.md)，真实HTTP/SFTP与中文/美元符/换行回读，无外部服务 |
| 13 | 沿用已有自定义图标；35模板补官方/源码/文档链接、安装配置纯预览；新增完整应用备份/恢复/S3工具及入口 | [部署](evidence/deployment.md)、[备份](evidence/backups.md)。备份是管理员CLI操作，支持同机多容器/多挂载；云计划由root审阅安装 |
| 14 | Agent上报逻辑CPU/内存容量，主机行展示并链接主机监控 | 当前有效绑定、时间/陈旧标记、旧Agent兼容及非法报告拒绝；真实主机须升级Agent |
| 15 | 主机/系统原生监控，应用/网站沿用资源入口；用户大盘仅隐藏未修改种子 | 自定义、版本、深链和删除意图保留，无数据删除 |
| 16 | 文件/目录新建、无覆盖改名、非递归删除、chmod与高亮 | 真实SSH六项通过、UI三轮；版本/确认/路径/审计/unknown回归，SFTP非事务限制明示 |
| 17 | 最近容器清单保留，Compose探测缓存；批量读取/删除和停止容器清理 | 精确目标、全批及逐项前检、逐项回读；默认保留卷。旧管理组件保留单容器功能，批次需升级；镜像清理沿用已有能力 |
| 18 | 标准LightMoni中心/ClickHouse整体离线迁移 | 真实新卷恢复后原登录、主密钥解密、SQLite quick_check及ClickHouse历史117通过；源数据保留，工具不启动新中心 |

## 验证

- 根`npm run typecheck`通过，`git diff --check`通过。
- 集成Runtime相关150项全部通过、无跳过，见[最终输出](evidence/runtime-final.txt)；Docker容器/接管两项另由真实Engine执行通过，见[部署证据](evidence/deployment.md)。
- SDK：Node28、Python36、Go通过；六语言真实HTTP协议12组通过，Rust6项源码unit通过，见[SDK证据](evidence/telemetry.md)。Windows特定分支未在Windows验证。
- 备份最终11项中10项通过（macOS跳过root用例）；独立Linux root容器9项通过、2个Docker live按设计跳过，合并覆盖全部用例。包含270MiB多容器数据、S3独立验签/条件写入、取消恢复、OCI身份校验与真实完整迁移，见[备份证据](evidence/backups.md)。
- 文件、容器/商店/接管、备份工具入口均由主代理连续三轮通过；备份入口18个组合、36次真实文件下载字节和摘要一致。中英、明暗及窄屏可操作，文件/备份另测等效200%。[文件](evidence/files-ui.json)、[部署](evidence/deployment-ui-parent-summary.json)、[备份UI](evidence/backup-tools-ui.json)。
- 主代理另在隔离中心与ClickHouse执行原生监控、日志性能、Grafana parity/deep parity四脚本连续三轮，最终记录见[主代理逐轮汇总](evidence/main-agent-ui-summary.md)和`evidence/main-agent-ui/`。无生产API或主机写入；临时服务/容器/密钥/卷按测试归属清理。

所有最终界面截图由主代理实际查看；关键图包括主机桌面、窄屏文件编辑、Compose确认、备份明暗与等效200%。媒体在忽略目录`artifacts/screenshots/specs/117-deployment-followups/evidence/`。沿用现有后台视觉/AntD交互，减少重复说明，保留对象和影响依据；未重新设计品牌或引入新动效。评审与三轮汇总在同目录证据中记录。

## 架构影响与Doca同步

适用：新增主机容量投影、原生监控入口、文件动作、批次兼容、Compose接管入口、计划授权来源、完整离线备份/S3/迁移控制路径及本机root持续授权。

仓库更新[系统设计第117章](../../docs/system-design.md)，并通过MCP在[LightMoni系统设计基线](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53)新增原生章节。最终保存seq1771；按目标块回读8段正文和原生流程图8节点/7边，文本/节点/连线全部一致且端点存在。原985块/55原生图未编辑或删除，抽核原架构图10节点/8边JSON完全一致。编号标题被宿主自动转换后，使用最新返回ID修正标题及新块位置；未重建全文。见[回读记录](evidence/doca-readback.json)。

## 兼容与尚需现场执行

operations HTTP写入口现在要求真人管理员cookie，Bearer/API凭据不能批准/修改操作；内部平台计划由原持久授权驱动。主机容量和批次功能需升级对应Agent/管理组件，旧节点保留原有功能。备份CLI需Python/Docker权限与本机可信tar镜像，systemd只生成文件；S3单对象5GiB，目前未连接真实云供应商。Compose接管与备份仅支持明示子集；不支持配置明确阻断。

尚未进行生产发行、升级、DNS切换、计划启用或实际业务迁移。日志性能仅证明当前2000行夹具的有界渲染与缓存；生产查询和更大数据量仍需现场观测。原问题表未擅自改成“已部署解决”，以PR和后续生产验收区分。

## GitHub交付

[PR #160](https://github.com/workhold/lightmoni/pull/160)，分支`codex/117-deployment-followups`→`main`。提交前已fetch并确认main无新提交；无直接主干推送、合并或发行。所有任务完成，生产执行范围仍以上述边界为准。
