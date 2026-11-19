# SDD 189 验证

日期：2026-11-19。

## 生产现场（改动前）

- `zz-bj-1` 的 Agent 和 helper 服务均为 active；小猪绘本、PostgreSQL 与 Registry 容器持续运行，小猪绘本与 Registry HTTP 探测为 200。
- 应用卡片曾随周期性 `inspect` 在“运行中”和“待核实”之间切换；镜像仓库也曾恢复为 v7 已上线，仓库 API 的 `_catalog` 返回 2 个仓库条目，但页面查询一次被取消。
- 部分只读核对的受管作业结果为 unknown；主机 helper journal 没有对应的执行行。不能从这些证据单独断定异常发生在中心 SSH、心跳、领取还是回执阶段。
- 两条已核对的历史未知任务在页面执行了“人工核对结束”，保留原未知结果和审计；新核对任务随后陆续成功。仍有新的核对失败/未知，生产问题未视为关闭。

## 本地验证

- `privileged-executor-runner.test.ts` 20 项通过：单次任务即使观测采集器阻塞，也在签名心跳后领取精确作业；无效签名策略仍在领取前拒绝。
- `center-ssh-dispatch.test.ts` 与 `managed-executor-jobs.test.ts` 共 42 项通过：覆盖 SSH 固定入口、未知结果围栏、回执及常驻 helper 应用观测。
- `npm run typecheck`、`npm run build`（runtime）和 `git diff --check` 通过。
- 本次没有部署生产发行包；上述生产观察均来自变更前版本，不能作为修复后验收。
- PR 已补齐 0.1.8 统一版本与固定 Compose 标签；发布镜像、中心部署及目标 Agent 升级仍须在合入后进行。
- `npm run version:check`：0.1.8 的 46 项版本一致性检查通过；根目录 `npm run build` 通过（SDK、runtime、AI runtime、Web）。
- `docker compose config --quiet` 在注入仅用于本地语法验证的占位密码后通过；三组相关测试共 62 项通过，`git diff --check` 通过。
- `npm run release:agent -- 0.1.8` 生成 Linux amd64/arm64 两份发行包，`agent-releases.json` 的版本均为 0.1.8，源码修订均为候选提交 `cd3e828c97394138faf71bc2c6bd32179ae62d99`。官方 Node 下载在 120 秒超时后，改用受脚本支持的镜像源下载，包内容仍按官方 SHA256 清单校验；最终合入提交需重新打包并核对新修订。

## 架构影响

SSH 单次受管进程不再同步承担应用观测；常驻 helper 保留观测职责。见 `docs/system-design.md` 第 123.3 节。

## Pull Request

- GitHub PR [#262](https://github.com/workhold/lightmoni/pull/262)，目标 `main`。截至本记录未合入、未部署。
