# 验收记录

日期：2026-10-31。基线：GitHub `origin/main` 的 `5aa5526`。功能分支：`codex/058-app-install-progress`。

## 行为与兼容

安装表单保留名称、版本、集群/机器、密码及端口；服务标识、部署模式、资源限制和多集群配置收入高级设置。单集群及唯一在线机器自动选择。手动模式默认建议容器端口（Redis 6379 / MySQL 3306）；托管模式留空自动分配，显式值保留，切换模式不覆盖主动填写值。OpenResty 固定 80/443。

提交后直接打开安装进度。已保存但部署拒绝的应用保留，日志可从列表重新打开；读取中断保留最后结果并提示。安装完成要求所有已发布集群的修订、实例数量及健康结果满足条件，空实例集群不能因空集合判断成功。逐机执行和日志可回读，旧步骤无法恢复时明确说明。

复用既有资源、run、events API、job lease 与最终 result，没有新增表、凭据或命令权限。新中心提供持久阶段投影；旧 Agent 可显示通用阶段，新 Agent 增加 Docker/端口/配置/启动/健康/恢复细阶段及分类故障。日志不输出原始命令、环境或 stdout/stderr。API 保持显式端口含 0 的既有语义；缺省端口按部署模式选择。

## 执行证据

- runtime/web 类型检查通过；仓库未配置独立 lint 命令。
- 99 项定向测试通过，0 失败：`application-install`、`platform-store`、`platform-executor`、`platform-clusters`、`platform-api`、`platform-workloads`、`platform-reconcile`、`platform-cloud-certificates`。
- 真实 Docker 29.4.3：单容器及 Compose 版本/持久数据回归通过，并断言实际执行发出 starting_containers 与 checking_health 阶段。两项 Linux host-network OpenResty 验收跳过；当前为 macOS Docker 环境，不能据此声称已验证宿主 80/443、真实 DNS 或远程生产环境。
- 浏览器使用独立 loopback HTTP/SQLite/真实 Agent job 控制器及可控 Agent 回执。连续三轮报告为 `evidence/ui-1/results.json`、`ui-2/results.json`、`ui-3/results.json`。每轮覆盖端口模式切换与显式值、默认目标、高级资源提交、保存失败保留输入、真实阶段持久化、日志 503 恢复去重、失败原因/建议、刷新后回读、最终成功、unknown、中英文 390px、200% 等效视口及减少动效；最终结果以这些报告为准。

## 界面与视觉自检

方向为沿用运维工具的既有视觉，优先基本参数和安装结果。删除重复的部署建议警告、确认后创建/部署提示与首屏 serviceName 说明，高级配置仍可展开。按钮提供 loading 反馈，Collapse 展开/收起保留来路，安装抽屉及摘要使用既有短入场；减少动效时直接显示。

主 Agent 已实际查看桌面基础安装、失败原因及英文 390px 截图，检查文字、错误码、换行与相邻区域。局部流程优化由主 Agent 自检，未独立评分。媒体位于 `artifacts/screenshots/specs/058-app-install-progress/evidence/ui-{1,2,3}/`，包含 basic-install、advanced-settings、install-running、logs-unavailable、failure-reason、install-succeeded、install-unknown、failure-390、failure-en-390、basic-en-390、failure-200-equivalent 及各轮完整操作 webm（覆盖按钮反馈、展开和抽屉切换）。浏览器每轮检查页面错误为空，窄屏根页面无横向溢出；步骤表内部允许横向滚动。未测量帧率。

## 架构同步

影响适用：Agent 内部 progress 回调与现有 job 事件到步骤表的投影，及安装表单端口缺省策略。仓库更新 `docs/system-design.md` 44.6；[Doca 系统设计基线](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53) 同节保存并回读。新增原生图 6 节点/7 连线全部核对；邻接系统日志正文与并行 Docker 原生图保持一致。端口规则追加后再次回读匹配。证据：`evidence/doca-readback.json`，保存/回读序列 893、894；未整文重建。

## 集成

实现后已同步最新 `origin/main`，保留主工作区原有发布文档，功能修改全部位于独立工作区。提交前 `git diff --check` 通过。GitHub PR 目标 `main`，合并与发布另行授权。
