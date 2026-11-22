# SDD206 验收记录

日期：2026-11-22。分支：`codex/206-agent-update-cache-retention`。

## 行为

- 启动与每次维护计划入库后清理 `agent-update-cache`：保留最新 8 个固定文件与全部活动计划引用，删除其余 SHA256 命名文件；staging 与非文件条目不动；清理失败静默。
- 生产参照（zsw-bj-1 中心）：当前约 40 个文件 / 2.9GB，落地后收敛到个位数文件（每次新计划触发一次回收）。

## 本地验证

- 新增 `runtime/test/agent-update-catalog-prune.test.ts`（2 用例）：保留最新 8 + 引用、删除更旧未引用、staging/目录不受影响、返回计数；缓存目录缺失时返回 0 不抛错。
- 新增集成用例 `creating an update plan prunes unreferenced cache pins`（`machine-agent-updates.test.ts`）：两台主机各建计划后，10 个旧 pin 中最旧 5 个被删除、较新 5 个保留，两份活动计划的固定文件全部存活。
- 相关套件：`machine-agent-updates` + `agent-update-catalog-prune` + `machine-agent-link` + `machine-state-recovery` 共 103 项全部通过。
- `npm --prefix runtime run typecheck`、`npm run version:check`（0.1.12，46 项）、`git diff --check` 通过。
