# 开发与合入流程

- 后续开发以 [GitHub workhold/lightmoni](https://github.com/workhold/lightmoni) 为主仓库；代码与文档分支统一推送到 GitHub，并在 GitHub 创建面向 `main` 的 Pull Request。本地 `origin` 应指向该 GitHub 仓库，默认推送远端使用 `origin`。
- Gitea 仅作为历史参考，不再向 Gitea 推送分支、创建新合并请求或自动同步代码；只有用户另行明确要求时才执行针对 Gitea 的写入。
- 功能开发使用 SDD：先更新规格、设计、契约和任务，再实现并记录验收证据。
- 任何架构变更都必须同步更新仓库的 [`docs/system-design.md`](docs/system-design.md) 与 Doca 在线设计文档（[LightMoni 系统设计基线](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53)）。架构变更包括组件职责、数据或控制路径、凭据边界、存储、协议、部署拓扑以及 AI 与工具边界的变化。
- 架构同步必须在同一个 SDD 和 Pull Request 中完成：保留 Doca 的原生图块与无关内容，写入后用最新版本回读目标章节或图块，核对文本、节点和连线；PR 必须记录影响判断、仓库章节、Doca 链接和回读结果。Doca 不可访问、鉴权失败或保存未确认时，禁止声称同步完成。
- 不影响架构的改动在 SDD/PR 中填写“不适用”及理由，不为满足形式要求无意义地改写设计文档。Doca token、密钥和密码只能通过受保护的运行时凭据提供，不得进入仓库、日志、URL、PR 或文档正文。
- 所有代码变更通过功能分支提交 Pull Request，目标为仓库主干；不得直接向主干推送。
- 提交前同步远端主干，处理冲突并运行与变更相关的检查。PR 描述写明最终行为、兼容影响及验证结果。
- 用户要求“提交 PR”时，创建 PR 并返回链接；只有取得合并授权后才通过 PR 合入，不用直接推送代替合并。
