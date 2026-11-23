## 验证

- `cd runtime && node --import tsx --test --test-concurrency=1 test/docker-environment.test.ts`：21/21 通过。
- `cd runtime && node --import tsx --test --test-concurrency=1 test/machine-agent-runtime.test.ts`：59/59 通过。
- `cd runtime && node --import tsx --test --test-concurrency=1 test/managed-machines.test.ts`：93/93 通过。
- `npm --prefix ai-runtime test`：89/89 通过；`npm --prefix sdk/typescript test`：28/28 通过。
- `npm --prefix runtime run typecheck`、`npm --prefix ai-runtime run typecheck`、`npm --prefix web run typecheck` 通过。
- `npm --prefix web run build` 通过。
- 生成的 Docker 只读/安装命令均通过 `/bin/sh -n`；只读命令包含缺失目录、缺失状态文件和不可信目录的固定 JSON 出口。
- 未执行生产 Agent 修复或镜像发布；生产验证应在发布 0.1.33 后对 `vchive` 只读核对一次。
