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

文档基线已完成，运行时能力没有因本 SDD 自动扩展。发布前必须完成 T009 的 PR 审核，并在相关功能 SDD 的验证记录中补齐代码或实机证据。
