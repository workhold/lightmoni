# Agent 移除执行器门禁验证

日期：2026-11-02。仅使用本地隔离数据库及本机 HTTP fixture，未连接 SSH 或生产平台。

## 缺陷复现

先加入 `node-lifecycle.test.ts` 的 `unrevoked root executors prevent Agent removal without revoking either principal` 用例，保留旧实现执行：

```sh
cd runtime
node --import tsx --test --test-name-pattern='unrevoked root executors' test/node-lifecycle.test.ts
```

结果：退出码 1，pending 执行器情况下移除实际返回 200，期望 409，确认旧实现允许遗留未撤销执行器。

## 修复后验证

```sh
cd runtime
node --import tsx --test --test-concurrency=1 test/node-lifecycle.test.ts test/privileged-executors.test.ts test/machine-executor-maintenance.test.ts
npm run typecheck
```

结果：76 项通过，0 失败、0 跳过；runtime 类型检查通过。目标代码和测试的 `git diff --check` 通过。

新增回归核对：pending / active / bootstrap_unknown / unknown 执行器均返回 409；普通 Agent tombstone、审计、独立凭据和执行器状态不变，普通心跳仍可用；撤销该执行器后移除成功；其他主机的 active 执行器与凭据不受影响；重试移除不重复写审计。

最终审查补入生产实际使用的 bootstrap_unknown 状态后，单独再次运行 `node --import tsx --test test/node-lifecycle.test.ts`，**12/12 通过，0 失败、0 跳过**；确认新增状态也进入拒绝分支，不以人工 unknown 替代生产状态验证。

改动仅补现有生命周期约束，没有新增协议、权限或组件。
