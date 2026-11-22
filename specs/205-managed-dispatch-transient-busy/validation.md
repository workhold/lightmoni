# SDD205 验收记录

日期：2026-11-22。分支：`codex/205-managed-dispatch-transient-busy`。

## 生产证据（问题定位）

- 2026-11-21 生产实例 zz-bj-1（root 模式）：镜像页 `registry.inspect` run 于 15:33:05 与 15:33:48 两次在创建后 0.7–2.3 秒内 `cancelled`，`agent_job_events` 记录 `cancelled by approval_invalid: machine_execution_locked`。
- 同一时间线：15:33:00 创建的 OpenResty 观测于 15:33:05.654 被领取激活；15:33:46 创建的 PostgreSQL 观测于 15:33:52.959 激活——两次取消均发生在其他受管任务占用执行通道的瞬间。
- 四个应用恢复对账后，观测以约 75 秒周期错开占用签名通道；08:46（通道空闲期）同一查询一次成功。历史（2026-11-16 03:31–03:42）存在连续 6 次同因取消。
- 仓库实际内容（`/v2/_catalog`）：`ebookn/ebookn`、`lightmoni/abc-demo`，与页面「仓库中暂无镜像」不符。

## 行为

- 忙通道下 `prepare()` 对新排队任务收到 `machine_execution_locked` 时直接返回：任务保持 `queued`，无 `cancelled` 事件；阻塞任务回执终结后，下一轮领取按原审批正常派发。
- `agent_upgrade_required` → `failQueuedSSH` 与其余 `approval_invalid` 取消分支不变。

## 本地验证

- 聚焦回归（新增用例 `a busy execution lane defers queued managed work instead of cancelling it`）：
  - 修复后：`node --import tsx --test test/managed-executor-jobs.test.ts`，37 项通过、0 失败。
  - 反向验证：仅还原 `managed-executor-jobs.ts` 后该用例失败（`actual: 'cancelled', expected: 'queued'`），复现生产行为；恢复修复后通过。
- 全量 `npm --prefix runtime test`：本分支 1936 项、1866 通过、35 失败；基线（干净 main）1935 项、1865 通过、35 失败。失败集合一致，均为本机环境相关的 Agent 安装器套件，与本次改动无关；新增 1 项通过。
- `npm --prefix runtime run typecheck` 通过。
- `npm run version:check` 通过（普通修复提交，不递增版本）。
