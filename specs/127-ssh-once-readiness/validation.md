# SDD127 验收记录

日期：2026-11-12。分支：`codex/127-ssh-production-qa`。

## 代码与契约

- 旧修订未声明单次入口时，受管能力不显示 `ready`，受管、容器及提权计划在创建作业前返回 `agent_upgrade_required`。普通作业与手动脚本分别按 `jobs-once`、`task-once` 准入。
- 生产已验证的完整修订 `16b151337cc94c1b7f3f7de56bdcad561759c85b` 与 `state_schema=1` 在缺少新字段时仍可作为中心先升级的迁移证据。显式集合优先于迁移例外；部分集合仅放行相应入口。
- 历史未领取队列在 SSH 前核查证据，不支持时以 `agent_upgrade_required` 终结；已领取及 unknown 保留原恢复围栏。定时脚本继续原 helper 循环。

## 本地验证

在 `runtime/` 执行：

```sh
node --import tsx --test --test-concurrency=1 test/agent.test.ts test/privileged-executor-runner.test.ts test/center-ssh-dispatch.test.ts test/privileged-executors.test.ts test/agent-jobs.test.ts test/task-center.test.ts test/task-schedules.test.ts
```

结果：95 tests，95 passed，0 failed。覆盖旧发行、精确迁移发行、新显式声明、部分声明、离线历史心跳、旧队列、手动及定时任务和心跳生产者。

`runtime/` 与 `web/` 的 `npm run typecheck` 均通过；`git diff --check` 通过。上述为本地回归，生产 SSH 派发需在新镜像部署后另行验证。

补充运行受管执行器、服务部署、容器、网站、证书和备份领域回归：82 项中 72 通过、10 项因测试环境条件跳过、0 失败。`runtime` 与 `web` 的生产构建均通过。

## 架构同步

影响判断：**适用**。本变更增加 Agent/helper 心跳协议字段，并改变中心主动操作的准入和旧队列控制路径；未增加存储列，也未改变 SSH 凭据边界。

- 仓库：[docs/system-design.md](../../docs/system-design.md) 第 127 章，含与在线图块一致的准入流程图。
- 在线：[Doca《LightMoni 系统设计基线》](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53)。在第 123 章后写入第 127 章，最终保存回执为 `saved=true`，版本 `seq=1782`。
- 写后以最新版本 `seq=1782` 分块回读：标题、能力证据、精确迁移修订、显式集合优先、准入、旧队列文字均与本 SDD 一致；新增原生流程图保有 7 个节点及 5 条连线，各边均指向已读取的节点。原有 SDD117 原生流程图仍在，回读为 8 个节点、7 条连线。写入只使用在第 123 章末尾后的新增块，未替换原有图块或无关章节。结构化回读证据见 [doca-readback.json](doca-readback.json)。

## 发布后核对

在生产确认中心返回的旧发行升级原因、兼容发行能完成一个受管操作、已有定时任务仍可领取，并核对失败记录没有远端 SSH 副作用。发布及生产验收由合入部署步骤记录。
