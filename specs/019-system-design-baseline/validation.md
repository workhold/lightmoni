# SDD 019：验证记录

## 已执行

- 确认工作区为 Git 仓库，基线来自当前 `origin/main`，创建功能分支 `docs/system-design-baseline`。
- 读取并交叉检查 `README.md`、`docs/architecture.md`、`docs/contracts.md`、`docs/brief.md`、`docs/agent-deployment.md`、`docs/machine-terminal.md`、`sdk/README.md`、任务索引和 SDD 001～018。
- 读取中心、Agent、AI runtime 和 Web 的入口目录，核对了当前 HTTP 模块、Agent 队列、模型 provider、SSH、终端和 SDK 安装入口。
- 在总设计中增加“事实来源优先级”和“当前/目标/未验收”标记，避免将规划能力误报为已实现。
- README 增加总设计入口。

## 需要在后续实现或发布前继续验证

- 当前分支未重新运行完整 Node/SDK/ClickHouse/浏览器回归；系统设计变更本身没有运行时代码，因此不把历史验证证据冒充本次测试结果。
- `runtime/src/server/install.ts`、Web 验证 fixture 和部分 SDD 对 SDK 发布语言存在时间差。发布前以 `/api/v1/sdk-install`、发布脚本产物和目标分支的 SDD 012 为准，并补一个矩阵一致性测试。
- Linux systemd、双架构 Agent 安装、SSH 实机和 Docker Compose 仍需按各自 SDD 的验证命令执行。
- ClickHouse 掉电、磁盘满、异步写入和长时间补传需要真实环境验证，不能由文档检查替代。

## 文档检查命令

```sh
git diff --check
rg -n "system-design\.md|SDK.*Agent|Agent.*SDK|Java|C#|PHP|Go|Rust|Ruby" README.md docs specs/019-system-design-baseline
```

## 验收结论

文档基线已通过 PR #22 合入主干，运行时能力没有因本 SDD 自动扩展。发布前仍需在相关功能 SDD 的验证记录中补齐代码或实机证据。

## 图示修正验收（2026-10-21）

- 从最新 `origin/main`（`7cf0245`，已包含 PR #22）创建 `docs/fix-system-architecture-diagrams`，未修改运行时代码。
- Markdown 与 [Doca 在线文档](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53) 同步修正：SDK 和 Agent 独立上报；两端复用同一套 SDK；节点数据与控制凭据分离；Web、AI 和 SSH 入口均通过中心管理 API。
- 把拥挤的总览拆成上报/控制（10 节点、8 条边）与中心模块（10 节点、9 条边）两张图；部署图为 8 节点、7 条边。原架构图与部署图块 ID 保持不变，其余章节不重建。
- Doca MCP 保存成功后逐图完整回读；节点端点有效、无重复节点 ID、没有连线穿过无关节点，节点矩形无重叠。确认不存在业务 SDK → Agent 主图边，以及 SSH 终端 → AI 模块的错误直连。
- 从回读的数据生成本地 SVG/PNG 布局预览，检查文字、矩形和箭头；修正部署图汇合处的凭据标签重叠，将凭据说明放入对应节点。
- `git diff --check` 通过；README、总设计与本 SDD 的 6 个 Markdown 文件围栏配对正常，53 个相对链接目标存在。
- 视觉验收限制：内置浏览器的 Doca 会话未登录，未完成在线编辑器实际渲染验收。本地预览用于检查布局，不等同于 Doca 编辑器截图；不把 MCP 保存成功当作线上像素验证。
- 本次保持现有显式 relay 运行时能力，只调整推荐链路和文档表达；未运行与本次文档变更无关的 Node、SDK、ClickHouse 系统回归。
