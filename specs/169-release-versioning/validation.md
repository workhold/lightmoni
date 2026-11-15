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

初始验证记录创建时尚未构建或推送镜像。版本 PR 合入后已按下方结果完成本地 amd64 镜像构建、隔离运行验证和 registry 推送；不使用 GitHub 流水线，不操作生产主机。架构影响不适用，未修改 `docs/system-design.md`。

## 发布结果（2026-11-15）

- 版本 PR：[PR #229](https://github.com/workhold/lightmoni/pull/229) 已合入，merge commit：`fb4ad6a3ae06afbd3c2e7b5d63b7564669bb7cd7`。
- 固定镜像：`docker.heyphp.com/lightmoni/lightmoni:v0.1.1-20261115-073239-amd64`，registry digest：`sha256:7f14a5c79e97c9840ceb8e2dee9ba1e32c53947923a3909d343e086342a139ac`。
- `v0.1.1-amd64` 与固定标签 digest 相同；`latest` 已更新为同一 amd64 镜像，digest：`sha256:8fd2aabf51ca307c3bb1e59374c63e903166afad0a05feb989a81b05c57ce7cf`。
- 镜像为 `linux/amd64`，OCI revision 为上述 merge commit。固定标签删除本地副本后重新拉取成功，digest 与构建结果一致。
- 隔离中心健康检查通过；`/api/v1/settings/instance` 返回 `0.1.1`，MCP `serverInfo` 返回 `lightmoni/0.1.1`。
- Agent 可执行文件返回 `0.1.1`。发行清单双架构 Agent 均绑定上述源码 revision；amd64 SHA256 为 `0e98893bc23e577b4d4460a208b86c9dfd73bbbfdd56fa888b2691c36fdf4647`，arm64 SHA256 为 `899d4a8ffa57afb307a5792d14e9fb38dd51c13dc6c30a7b9b910fd8f2162790`。
- SDK 文件名均为 `0.1.1`，TypeScript SDK 打包输出 `@lightmoni/sdk@0.1.1`。
- 本地 Buildx + Rosetta 构建，官方 Node 包 SHA256 校验通过；没有使用 GitHub 流水线，没有发布 arm64 平台镜像，没有操作生产环境。
- README 构建命令已根据实跑修正为精确提取 LightMoni 标签、显式指定 `deploy/server/Dockerfile` 并使用 `docker buildx build --load`。
