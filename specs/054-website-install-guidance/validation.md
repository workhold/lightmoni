# 验收记录

日期：2026-10-31。参照用户提供的网站空表/集群管理横栏截图，沿用现有 Ant Design 与深色主题，只调整安装状态和入口位置。

## 结果

- `npm --prefix web run typecheck`：通过。
- `node --check`：新增安装流程脚本和更新后的导航脚本语法检查通过。
- `git diff --check`：通过。
- 浏览器第 1 轮：通过，7 组检查，页面异常 0，见 `evidence/ui-1/results.json`。
- 浏览器第 2 轮：通过，7 组检查，页面异常 0，见 `evidence/ui-2/results.json`。
- 浏览器第 3 轮：通过，7 组检查，页面异常 0，见 `evidence/ui-3/results.json`。

每轮启动全新的一次性 QA SQLite/HTTP 服务，使用 `runtime/test/fixtures/cluster-ui-server.ts`；Vite 指向本机 `http://127.0.0.1:19942`，前端端口 5174。运行 `LIGHTMONI_UI_RUN=<轮次> node web/src/app/ops/verify-install-guidance-ui.mjs`。结束后停止 QA 服务，清理一次性数据库。更新了原导航验收脚本的旧运维跳转/集群侧栏预期；该生产包脚本本轮未运行，其受影响路径已由上述 Vite 浏览器检查覆盖。

## 覆盖范围

1. 挂起 overview 请求，加载期间不显示安装结论；空快照成功后显示安装主动作，不显示网站空表、搜索、新建网站及集群管理横栏。
2. overview 503 时显示错误和重试，重试真实接口恢复；不能把读取失败误报成未安装。
3. 中文/英文 390px 画面无溢出；安装按钮跳到应用路由并直接打开 OpenResty 表单；刷新保留安装入口，取消清除参数。
4. 应用安装字段只显示管理集群链接，在新页进入真实集群管理，创建集群并回读。返回后可选择新集群，应用名称输入保留。应用自定义部署和网站表单也没有内嵌新建集群按钮。
5. 模拟安装 409 后保留名称、入口域名等输入；恢复真实 catalog install API 后保存应用、部署集群与入口域名，返回网站页并刷新读回。
6. 已安装但没有成功 Agent 回执的 OpenResty 仍显示网站列表和管理入口；安装深链接不打开重复安装，普通应用商店的单例安装按钮禁用。修复了商店预设角色未注册时入口域名字段不显示的问题。
7. 集群侧栏及默认首页候选移除；旧 `/clusters` 和 `/operations` 本地首页偏好、旧运维路由进入应用管理；成员的集群、网站及安装路由继续转到设置页。

## 视觉检查与范围限制

主 Agent 已查看桌面未安装提示、英文 390px、应用集群字段及 720px 的 200% 等效布局截图，主动作可见、文字无重叠；属于局部低风险修改，没有独立评审或评分。删除了列表顶部的集群管理横栏和表单内嵌新建集群操作，保留必要的筛选、管理跳转和网站配置文案。沿用既有按钮状态反馈、抽屉开合、表单项入场；没有新增动效或录屏验收需求。

本地截图通过仓库 `scripts/qa-artifacts.mjs` 保存于 `artifacts/screenshots/specs/054-website-install-guidance/evidence/ui-{1,2,3}/`，图片不进入 Git。关键文件为 `uninstalled-zh-desktop.png`、`uninstalled-en-390.png`、`install-en-390.png`、`install-selected-cluster.png`、`install-error-preserved.png`、`application-cluster-field.png`、`website-cluster-field.png` 和 `uninstalled-200-equivalent.png`。

QA 服务禁用外部云请求且未登记远程 Agent 凭据；本轮证明真实资源保存、部署请求和前端状态，**不代表 OpenResty 已在机器运行或公网 DNS 已生效**。安装保存失败为浏览器 409 夹具；200% 使用 720px 等效视口；未运行生产构建或全量测试。

架构同步：不适用。本轮只调整既有前端呈现、导航和数据回读时机，不改变后端职责、API、持久化、凭据、部署或 AI/工具边界；仓库系统设计与 Doca 基线均无需改写。
