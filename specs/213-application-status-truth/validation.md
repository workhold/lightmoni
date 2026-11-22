# SDD213 验收记录

日期：2026-11-22。分支：`codex/213-application-status-truth`。

## 行为

1. 实例 `state='unknown'` 或 Agent 存在 unknown 阻塞任务时，deployment.instance 调和器自动派发只读 `workload.inspect`（30 秒冷却），写操作围栏不变；巡检证实 `configuration_matches && healthy` 后实例回到 `running`、`unresolved_run_id` 消失，无需人工修复。
2. 租约清扫置 unknown 时保留原 `lease_id`；`.inspect`/`.logs` 任务 10 分钟窗口内接受原 lease 的 succeeded/failed 终态回执，写审计事件 `Late read-only receipt settled an unknown lease timeout`；写任务迟到回执仍拒绝（`agent job result requires a resolved unknown execution`）。
3. 命令层基础设施错误码（`operation_command_timeout`/`operation_dependency_unavailable`/`docker_permission_denied`/`docker_daemon_unavailable`）的失败回执使实例回落到最后一次成功观测状态（`observed_json`），`healthy=0`、`health_failures` 递增；业务失败码仍落 `failed`。
4. HTTP 探针未显式配置 `expected_statuses` 时默认接受 2xx/3xx；显式白名单语义不变；`null` 视同未配置（与旧行为一致）。

## 本地验证

- 聚焦回归（新增 `runtime/test/platform-status-truth.test.ts` 三条 + `application-readiness.test.ts` 一条）：
  - 修复后：`node --import tsx --test --test-concurrency=1 test/platform-status-truth.test.ts test/application-readiness.test.ts`，6 项通过、0 失败。
  - 反向验证：`git stash` 还原三处源码改动后，4 条新用例全部失败（unknown 卡 blocked、迟到回执 409、infra 失败落 failed、302 判不健康），恢复修复后通过。
- 受影响套件：`agent-jobs` / `agent-job-fence` / `platform-clusters` / `reconciliation` / `managed-executor-jobs` 共 157 项全部通过（其中 `agent-jobs.test.ts` 一处断言随行为更新：通用任务迟到回执的错误文案变化）。
- 全量 `npm --prefix runtime test`：本分支 1946 项、1873 通过、38 失败；基线（origin/main worktree）1883 项、1805 通过、43 失败。按测试名归一化对比：**分支失败集合是基线的真子集**（仅基线多出的 5 项为 worktree 符号链接 node_modules 的模块加载错误与 2 条依赖真实网络的 worker 用例），失败均为本机环境相关的 Agent 安装器套件，与本次改动无关。
- `npm run typecheck`（runtime + ai-runtime + web）通过。
- `npm run version:check` 通过（0.1.22，46 项检查；本 PR 不打包容器镜像，不递增版本）。

## 生产预期

- 45–60 秒级抖动不再产生需要人工「修复 Agent」的 unknown 卡死：巡检在冷却后自动核实，或 Agent 迟到的只读观测直接落库。
- docker 瞬时错误只降级为「待核实」，由既有 repair 重试恢复；重定向应答的健康探针默认通过。
- 链路真断（Agent >120 秒无心跳）或观测证实应用真坏（容器停止/健康检查失败）的异常展示保持不变。
