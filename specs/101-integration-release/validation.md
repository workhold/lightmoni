# 统一发行验收

2026-11-07。功能 PR129、PR130 的全部提交通过集成 PR131 合入 main，源码 `94bcbbcdede2ee9084345438080d64bae6cc1ca5`。冲突处理同时保留 storage.v2 与 registry.v1 能力、派发要求、两组平台测试及架构章节。

## 源码检查

- Runtime、AI、Web 类型检查与完整构建通过。
- 255项相关回归：250通过、0失败、5项环境条件跳过，未将跳过算作成功。
- 存储 UI 夹具通过，覆盖中英文、桌面/390px、真实格式目录、无回执、失败重试与202离线删除进度；镜像版本 UI 连续三轮通过。上述夹具不冒充线上宿主验收。
- 实际双架构 Agent 包完整性、ELF架构、便携依赖、版本及配置检查通过。旧 release-live 测试仍写入已废弃 key 字段，改为现行 control_credential/data_credential 测试值后2项全部通过；不改变运行时凭据行为。

## Docker 成品

固定版本：`docker.heyphp.com/lightmoni/lightmoni:20261107-storage-registry-94bcbbc`，Linux amd64/arm64。依赖及生产源码来自 main；后续测试夹具修正不改变生产代码。源码 revision 标签与内置 Agent 发布元数据核对。

默认源大文件下载超时后，使用仓库现有 build args 切换 npm/Node镜像及清华Debian镜像。保留npm integrity、官方Node校验和、Debian签名与TLS证书检查。slim基础镜像尚无CA时，Debian使用其既有HTTP签名引导方式；没有关闭证书验证。

每个架构45项成品检查通过，使用独立真实ClickHouse、中心HTTP与管理员会话，覆盖SDK数据写入查询、下载与校验和、Agent本机架构执行、维护解包器、能力、重启会话保留。各架构额外在成品编译代码上运行84项平台回归和7项镜像扫描/清理协议回归；其他原有受管作业、Docker安装与SDK校验亦通过。临时中心、数据库、数据卷和运行时测试凭据已清理。

直接推送的大层被现有OpenResty限制返回413；使用既有分块发布器对OCI内容逐块校验并以512KiB PATCH上传，完成前不切换线上镜像。远端固定索引、双平台manifest/config与所有blob需核验，latest保持原值。摘要与回拉证明记录在evidence中。

## 架构

整合与发行自身不适用，无额外架构变化。保留仓库第99/100节及两个功能SDD的Doca最新回读证据；第100节新原生图接口失败的限制仍如实保留。Doca链接：https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53。

## 线上

目标为用户指定1Panel终端与moni.heyphp.com。现有Compose目录`/opt/lightmoni/lightmoni`是部署配置目录，不是Git检出；仅替换对应固定镜像，保留现有环境、项目、端口与数据卷。部署配置、主密钥及SQLite复制到`/opt/lightmoni/backups/sdd101-20261107`并限制权限，最终备份 lightmoni-final.db 共314083页，单批完成复制后再次逐字节比对一致；对宿主副本执行 PRAGMA quick_check 返回ok。初次低速备份副本比对未通过，已由该最终备份取代；不将首次尝试标为成功。

通过指定面板执行 Compose 配置校验、固定镜像拉取与 `up -d --no-build --wait`，中心与原有ClickHouse均healthy。最终再次核对中心revision为完整`94bcbbcdede2ee9084345438080d64bae6cc1ca5`，启动时间`2026-11-07T03:28:04.114951208Z`，原数据卷`lightmoni_lightmoni-state-v2-20261103`继续挂载`/data`，公网healthz为ok。原Gitea网站HTTP200，仓库/v2/未认证HTTP401，认证边界保留。Compose既有无用旧卷标签警告未通过删除卷规避。

部署前一条只读仓库inspect在中心重启时留下unknown。先经主机SSH核对对应systemd作业已不存在、受管执行锁不存在、仓库容器持续运行，再通过产品“人工核对结束”登记审计，保留原unknown，不修改数据库状态或冒充原任务成功。`reconciled-inspection.json`记录核对范围。

通过真实Chrome管理员会话更新zz-bj-1：审阅固定发行、SHA256、原安装指纹与影响后执行。更新历史确认成功，刷新主机列表确认在线、完整管理、当前提交`94bcbbcdede2`。Agent身份及原账户权限保留；vchive仅监控且无SSH凭据，未擅自扩权或更新。详见`agent-update.json`。

在指定dashboards列表读取5个大盘，打开系统上报中心13面板；时间序列、表格、在线中心1、近期接收量和QPS正常，最近一分钟失败0，无可见查询错误。`dashboards.json`及截图记录当时数值。

私有镜像页通过新版Agent真实只读作业列出`lightmoni/abc-demo`三个标签及其完整摘要；两个应用引用正确显示为使用中，已卸载登记仍受保护，摘要别名latest同样保留；点击引用可打开真实应用。清理确认页核对全仓库范围、停止/部署引用及多架构保护后取消，没有提交线上永久删除。删除协议的实际执行采用功能SDD中的独立真实Registry验收，不将审阅页冒充删除成功。

应用详情收到`2026-11-07T03:39:13.418Z`新存储回执，显示按应用ID/实例ID生成的根目录和状态文件；已卸载实例无活动挂载。退休实例无回执时保留提示。现有网站仍为已发布v4，但原网关没有layout-v2存储回执，页面如实提示检查/升级，没有捏造路径。SDD099按原授权不迁移旧目录；既有应用/网关登记可需另行审阅部署以生成新布局，本次只读验收没有重写现有网站，也不声称已完成旧网站迁移。新布局网站实际配置、TLS、鉴权、回滚和删除已在独立Linux验收通过，见SDD099。

证据均位于本SDD的`evidence/`；凭据只经受保护运行时使用，不进入提交。最终证据PR仅更新验收文档与截图，无新增运行时代码或架构变化。
