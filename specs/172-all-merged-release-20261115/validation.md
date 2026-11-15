# SDD172 验收记录

日期：2026-11-15。仅记录已实际完成的步骤。

- [PR #226](https://github.com/workhold/lightmoni/pull/226) 已合入，合并提交 `93dbe07001f3f37ec0d249705adce6619a67f3e7`，修正应用中心最新状态模型的测试样本和期望；相关 4 项通过，Runtime 类型检查通过。
- [PR #218](https://github.com/workhold/lightmoni/pull/218) 已合入，合并提交 `5c3cbaec07c44dde99a6571b3075e74536c3b31f`；[PR #219](https://github.com/workhold/lightmoni/pull/219) 已合入，合并提交 `4ce37ce4e2e9c0e6114b3ab7a8088671b5ed46ec`。合入时 GitHub 无其他开放 PR。期间 #227–#231 已在前序主干合入，此次镜像源码将包含这些变更。
- #218 的构建、类型检查和定向 Runtime 78/79（1 项跳过）、AI 79/79、SDK 28/28 通过；完整 Runtime 的 7 项失败均可在同期纯主干复现。#219 整合 #231 后定向 Runtime 89/89、AI 84/84、Web 10/10、三处构建和类型检查均通过；此前完整 Runtime 的 39 项失败均可在同期纯主干复现。最终源码版本一致性 `npm run version:check` 为 46 项通过。
- #218 架构同步见 [SDD167 验证](../167-service-principal-capability-automation/validation.md)，Doca 保存并回读至 seq1814/version1816；#219 见 [SDD171 验证](../171-service-task-proposal-automation/validation.md)，最终 Doca 改号后保存并回读至 seq1817/version1819。两者的仓库正文与 Doca 目标块逐字一致，原生图保持。
- 本发行分支已合并 `origin/main@4ce37ce4e2e9c0e6114b3ab7a8088671b5ed46ec`，仅将根 Compose 中心镜像引用从 `v0.1.1-20261115-073239-amd64` 改为 `v0.1.1-20261115-100500-amd64`，未更改 ClickHouse、卷、环境、端口或健康检查。镜像构建和验证仍待完成，不把 Compose 引用当作已发布证据。
- 架构影响判断：本发行不适用，理由见 [规格](spec.md)；#218/#219 的架构同步结果记录在各自 SDD 和 PR 中。SDD169 的版本规范现要求 0.1.1 的 amd64 固定标签。

待记录：镜像构建与隔离验收、发行 PR/Release、生产备份/切换及线上回归。
