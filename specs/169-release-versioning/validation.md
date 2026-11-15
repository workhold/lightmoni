# SDD 169 验证记录

## 版本与文档

- 根版本已统一为 `0.1.1`，Compose 固定为 `docker.heyphp.com/lightmoni/lightmoni:v0.1.1-20261115-073239-amd64`。
- `npm run version:check`：**46 个版本点通过**，覆盖平台、Agent、MCP、SDK、构建默认值、文档和 Compose。
- 相同版本重复执行 `npm run version:bump -- 0.1.1`：通过且 diff 不变。
- 在隔离目录从 `0.1.1` 递增到 `0.1.2`：检查通过；第三方 `yocto-queue@0.1.0` 未被误改，Compose 生成符合契约的固定标签。
- 在隔离目录把 Agent 常量改回旧版本：检查按预期非零退出并指出具体文件。
- `git diff --check`、SDD 本地链接和代码围栏检查：通过。

## 构建与回归

- `npm run typecheck`：通过。
- `npm run build`：TypeScript SDK、runtime、ai-runtime、web 全部通过。
- `node web/src/app/verify-host-execution-ui.mjs`：**27/27 通过**。
- TypeScript SDK：**28/28 通过**。
- Go SDK：`GOPROXY=https://goproxy.cn,direct go test ./sdk/go` 通过；默认 proxy.golang.org 首次访问超时，未修改依赖。
- Python/Ruby SDK fixture 协议检查：**2/2 通过**。
- 相关 Runtime/MCP/主机测试：130 项通过、1 项既有跳过、1 项失败。失败为 `managed-machines.test.ts` 的 `unbound host must prove registered remote node and cannot uninstall a different or busy node`，在未修改的 `main`（450b75f）单独复跑得到同样 `201 != 409`，因此不是本次版本变更引入；本 PR 不顺带修改该卸载逻辑或测试。

## 未覆盖与发布边界

跨语言容器测试在拉取 Java 镜像时长时间无进展，已停止；本机 Java 运行时不可用，Rust 工具链未安装。因此 Java/.NET/PHP/Rust 本轮没有完整协议验收，只有版本文本和打包检查，不能声称所有 SDK 均通过全量测试。

本记录创建时尚未构建或推送镜像。版本 PR 合入后才执行本地 amd64 镜像构建、隔离运行验证和 registry 推送；不使用 GitHub 流水线，不操作生产主机。架构影响不适用，未修改 `docs/system-design.md`。
