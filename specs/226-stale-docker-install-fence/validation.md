## 验证

- `cd runtime && node --import tsx --test --test-concurrency=1 test/docker-environment.test.ts`：22/22 通过，其中包含旧 Agent 身份 unknown 栅栏启动收敛、当前 Agent 栅栏保留的回归。
- `npm --prefix runtime run typecheck`、`npm --prefix ai-runtime run typecheck`、`npm --prefix web run typecheck` 通过。
- `git diff --check` 通过。
- 生产 DB 只读取证：`vchive` Docker 记录 `agent_id=223aa23ee0abbfe68b9b2d2abf460d6f`，当前主机 Agent 为 `33f39c5c3edc9d474cb5c559bf1843ed`，确认根因是旧身份记录被目标变化拒绝后又写回 unknown。
- 未执行远端重装或重放；生产收敛需发布新镜像并重启中心服务。
