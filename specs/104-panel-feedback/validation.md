# 验收记录

## 范围与方法

基于最新 `origin/main`（b21e17b），分支 `codex/104-panel-feedback`。使用真实 React 组件与 loopback 内存 API fixture，端口19887；没有访问生产数据库、SSH、Docker、DNS 厂商或实际连接凭据。

方向沿用 SDD 087 的浅色运维面板与现有 Ant Design 图标。网站访问大盘和日志分开；列表动作收紧为32px图标，保留对象名称、状态文字、菜单说明、表单保存与危险确认文字。

## 验证

- `npm --prefix web run typecheck` 通过；项目未配置独立 lint 命令。fixture 与验证脚本 `node --check` 通过，`git diff --check` 通过。没有运行生产构建或无关全量测试。
- 主 Agent 执行 `LIGHTMONI_UI_RUN=1|2|3 node web/src/app/verify-panel-feedback.mjs`。三轮结果分别见 `evidence/ui-round-1.json`、`ui-round-2.json`、`ui-round-3.json`；以下结论以各报告的 passed 字段为准。
- 网站：访问大盘仅两张图，日志独立页签；刷新、URL参数、前进后退与时间范围保留；集群名称替代可解析的技术ID。状态码/关键词仅筛选已加载日志，零耗时显示0.000，长路径省略后可在详情中读取原文。
- 空集合、部分查询错误、采集异常/最近成功、加载失败与截断提示均有独立状态。没有从最多200条返回日志推断完整时间窗流量。
- 主机菜单、键盘focus提示、禁用升级入口、凭据保存失败保留输入、重命名保存后浏览器刷新读回均验证；撤销、删除任务与DNS删除仍显示确认，取消未产生对应写请求。
- 操作日志按时间、级别、事件、状态分列，单条原文按需查看；回执抽屉分别覆盖running、failed、unknown、succeeded。unknown刷新到成功后，摘要、警告与回执同步更新，不保留矛盾的旧警告。
- 任务结果保持stdout/stderr可读，执行快照与派发代码默认折叠；unknown保留显式核对提示。原有敏感输出读取、身份校验与权限处理未改变。
- 实际查看1366×900浅/深色画面、390×844网站日志/原文抽屉与主机/凭据表格，以及683×450的200%布局重排。后者是半尺寸CSS视口验收，不是原生浏览器200%缩放；表格允许区域内横滚，无整页横向溢出。未将开发服务重载时的spinner截图作为最终证据，冻结代码后已重新取证。

## 视觉复核与减法

隔离评审者已提供一轮静态视觉反馈，不打分；最终补拍由主 Agent 复核，范围和边界见 `evidence/visual-review.md`。主机行常用动作与核对入口已调整同排。删去重复的监控副标题、行内原始JSON、默认展示的凭据内部ID；保留失败原因、对象名称、执行ID的复制入口与原始回执。

## 动效与证据

证据位于忽略目录 `.local-dev/panel-feedback-104/`：
- `before-website/page.png`、`before-hosts/page.png` 是修改前基线。
- `round-1`、`round-2`、`round-3` 包含大盘/日志/原文、主机/凭据/任务/DNS、四类执行结果与窄屏、深色、布局重排画面。
- `motion-entry/record.mp4`（3.8秒）及start/mid/end三帧记录首次工作区入场；`motion-tab`记录页签指示条切换，`motion-detail`记录点击反馈与日志详情抽屉展开。均遵循减少动态效果设置。
- `motion-detail/report.json` 曾记录一次React开发态flushSync控制台警告；这是非致命开发警告，未把该录屏宣称为完全无告警。回归脚本分别记录未捕获页面异常，详情见每轮报告。

全部资源和指标均属于隔离fixture，不能作为线上状态。没有部署、合并或实际外部资源写入。

## 兼容与架构

URL新增tab=overview|logs与minutes用于前端状态，其他查询参数保留；既有API请求与响应、权限、凭据、持久化、后台任务和部署拓扑不变。架构同步不适用，docs/system-design.md 与 Doca 无需改写；Doca链接：https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53 。未进行Doca写入或声称在线同步完成。

## 交付

GitHub PR：https://github.com/workhold/lightmoni/pull/137 ，目标main；没有合并或部署。
