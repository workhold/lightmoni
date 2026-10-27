# SDD 024：验证记录

日期：2026-10-27。环境：macOS，Node v22.23.1。

## 根因复现与定向验证

- 使用真实 `/bin/sh`、`umask 077` 和 `cp -R`，源 runtime 目录/Node 为 0755、JS 为 0644，安装后得到 0700/0700/0600；旧 `chmod go-w` 不补足读取和遍历权限。
- 定向 `node --import tsx --test test/install-release.test.ts`：12 项通过、0 失败。覆盖 root-only 父目录修复、递归运行文件权限、配置/identity/queue 仍私有、正常安装/升级、延迟启动、孤立 active 不计成功、最多 10 次观察/9 次间隔、首装失败清理、旧 Node/Go 文件及启用/运行状态恢复。
- 安全诊断先于 stop，查询只含固定属性，无测试密钥。`systemctl show` 失败仍回滚，restart 退出码 7 在诊断失败和成功恢复后仍为 7。
- 负向验证：临时测试副本加载 `origin/main` 的旧安装器，新增首装权限用例失败（安装器退出码 3，触发回滚）；修复版通过。未替换工作区安装脚本，临时测试已删除。
- `sh -n deploy/agent/install.sh`、`npm --prefix runtime run typecheck`、`git diff --check` 通过。
- runtime 完整 `npm test`：311 项通过、16 项环境相关跳过、0 失败（共 327 项，约 60 秒）。
- 独立只读审查安装脚本、POSIX 条件退出语义、安全诊断和回滚，未发现阻塞问题。

## 环境与交付边界

上述自动回归执行真实 shell，但 root/Linux/systemctl/install 等是命令 shim；通过文件 mode 模拟服务用户读取，不验证真实 setuid/chown 或 Linux systemd。后续已补充一次 Linux amd64 实机首装、enrollment、持续心跳和真实主机指标入库，见下节；arm64 和真实升级/回滚仍待验证。

本次只修改分发安装脚本及检查/文档，不更改打包 Node 或应用内容。源码合并后仍需更新平台镜像/分发目录中的 `install.sh`；本次未发布线上平台。用户随后授权在指定远端主机首装并验收，见下节。若旧安装在激活后回滚，需在平台撤销该节点凭据并创建新的 enrollment token 重装。

架构同步不适用，理由见 [规格](spec.md)。

修复交付：[PR #28](https://gitea.heyphp.com/lightmoni/lightmoni/pulls/28)，已由用户合并至 `main`（`5100c66`）。修复提交前基于主干 `5fea503`；以下验收基于合并后的代码。

## Linux amd64 实机首装（2026-10-27）

用户明确授权通过指定 SSH 主机连接安装，中心为已部署平台。环境为 Linux x86_64、kernel 6.8、glibc 2.39、运行中的 systemd，安装前无 Agent 文件或 unit。没有覆盖已有身份或队列。

1. 通过管理员 API 登录，读取实际发行元数据，创建仅允许 amd64、有效期 15 分钟的一次性 enrollment。token 仅保留在内存，通过 SSH stdin 交给安装器，未放入 argv、URL、环境或输出。
2. 线上发行包版本 0.1.0，包含 amd64/arm64。但当时线上 `install.sh` 仍为旧版（14,976 字节），未包含权限修复。实际使用已合并 PR #28 的脚本（16,559 字节；SHA256 `ee69fe1241f07495cf153fec9f1f9a0c5d477b6d29d5e2d0b2b60ec37eb0e4ff`）配合线上包及清单安装；未修改平台分发目录。
3. 客户端等待安装输出超时，未保留安装进程的完整输出或退出码。随后通过独立 SSH 会话检查服务和文件，并通过中心 API、真实数据库查询确认安装结果；不把失去的进程输出当成已观察证据。
4. 服务于 11:06:32 CST 启动，以 `lightmoni-agent` 用户/组持续运行，`ActiveState=active`、`SubState=running`、`NRestarts=0`。服务用户执行 `check` 返回 `configuration valid`，版本为 0.1.0，本地 `/healthz` 返回 OK，4318 仅绑定 127.0.0.1。
5. 父目录和 Node 为 root:root 0755，实际入口 `app/runtime/dist/agent/main.js` 为 root:root 0644；递归检查未发现不符合 0755/0644 的公开运行文件。配置和状态目录由服务用户持有且为 0700，config/identity 为 0600。
6. 中心 enrollment 为 active，control/data credential 均 active 且 `last_used_at` 更新；心跳从 03:08:02 UTC 推进到 03:08:32 UTC，期望与实际配置 revision 一致。Agent 队列与隔离批次均为 0，CPU、memory、system、filesystem、disk、network 采集器状态均为 ok。
7. 中心查询真实 `metric_host_gauge`，按本次节点 ID 和安装时间过滤，得到 `host.cpu.utilization`、`host.memory.total/used/available`、`host.filesystem.total/used`、`host.uptime` 等数据，最近事件为 03:08:02 UTC。查询 `status=success`、`complete=true`、`truncated=false`；并非只检查由中心心跳派生的指标。
8. 移除本次 root-only 暂存安装脚本目录，保留已安装服务、专用用户、配置和持久状态供用户使用。未输出或提交密码、会话、enrollment、control/data secret。

结论：修复脚本配合线上发行包的 amd64 首装、真实 enrollment、非 root 运行、控制配置与采集入库通过。线上安装脚本仍需要平台重新发布。真实 arm64、升级/回滚、网络中断、目录日志和拨测不属于本次实机验收。

## 双架构镜像发布（2026-10-27）

用户追加授权重新制作并发布镜像。本次基于主干 `c3c01fae989bf3885756e4aab3b6cda78ce8ae04`；核对此前已验收镜像 revision `7b55205f0b573ed0f289e088d4a8a8fe7dfea999` 至此主干的全部差异，唯一运行文件变化为 `deploy/agent/install.sh`。其他变化是文档、环境示例、独立 examples 和测试。独立只读审查确认范围成立。

使用 [installer-update.Dockerfile](../../deploy/server/installer-update.Dockerfile)，基于已验收固定 index `sha256:51ebf2093ec5e604dc0a6e0f5b6a231caed9e85a2476edb05d37adb00cd72826` 分别构建两个平台。仅增加安装脚本 COPY 补丁层，没有重新编译服务、依赖、网页或下载包；基础镜像内的非运行测试源码仍为旧版。完整源码构建仍使用原 `deploy/server/Dockerfile`；本补丁 Dockerfile 仅适用于已确认的此运行差异。

- 已发布 `docker.heyphp.com/lightmoni/lightmoni:20261027-agent-install` 与 `latest`，回读 index digest 均为 `sha256:1a7c231eb2e2c7981369dcff21a5d8239a2b45d7ee56318c2008d17387ad977e`。
- index 仅含 `linux/amd64`（`sha256:71fb939648cb609e7132720eb30e82093941873a06064a68c8fee99986638a1d`）和 `linux/arm64`（`sha256:2aa9ee26916efd35d54e1456f22f939699e84b5b9483073e7943c2611ac7124d`）。两平台 OCI revision 均为上述主干提交。
- 回读注册表 config 和补丁 blob，验证全部 15 个基础层的 digest/size 不变，仅增加一个补丁层；非 Labels 运行配置完全一致（含 User、Entrypoint、Env、WorkingDir 等）。构建导出将层 media type 从 OCI gzip 描述转换为等价 Docker gzip 描述，层内容 digest 未变。
- 两平台补丁层都只包含目标脚本和其父目录条目。镜像静态抽取脚本均为 16,559 字节、0644，SHA256 与本节前述修复源码一致；两个 Agent 包和四种 SDK 包既通过自带清单校验，也逐项匹配原平台上一版本的大小及 SHA256。
- amd64 Docker 运行正式固定标签成功，UID 10001、Node `x64`，以 `--network none` 检查脚本可读、`sh -n`、安装器摘要、两份制品清单和 `lightmoni-admin --help`，均通过。Compose 新默认标签配置 `config --quiet`、本地 `sh -n` 与 `git diff --check` 通过。
- `20261026-admin` 回读 digest 保持原值，供现有用户回退。发布不改变线上容器；用户需在原 `.env` 更新 `LIGHTMONI_IMAGE`，执行 `pull lightmoni` 和 `up -d --no-build --wait`，沿用原项目名和卷。

验证边界：发布主机为 Linux amd64，2 GiB 内存、无 swap、无 arm64 执行环境。本次没有执行 arm64 容器，也未新建 ClickHouse 重跑 HTTP/入库全链路；沿用此前 [SDD 023 双架构完整验收](../023-registry-admin-cli/validation.md) 与本次运行差异审查，不将静态检查说成新一轮完整运行验收。凭据只经受保护 stdin/临时 Docker 配置使用，未进入构建上下文、镜像层、日志或证据。

发布后已删除本次远端 Docker 登录配置和暂存目录，所有测试容器均已移除；已安装的主机 Agent 仍为 active，原有线上平台没有被替换。最终独立只读审查未发现阻塞问题。

证据：[registry-report.json](../../docs/evidence/agent-install-release/registry-report.json)、[container-report.json](../../docs/evidence/agent-install-release/container-report.json)。本次仅修复发布、默认版本和部署说明，架构同步不适用；没有改变组件、数据/控制路径、凭据边界、存储、协议或拓扑。
