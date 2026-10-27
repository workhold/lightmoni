# SDD 026：容器与 Compose 验证

日期：2026-10-27。范围：`runtime/src/operations/containers.ts` 的领域执行器；本记录不代替中心审批、浏览器或端到端 Agent 通信验收。

## 实现契约

- 配置：`{project_name, compose, service_id?}`；`compose` 是受限 JSON Compose 声明。支持固定版本/摘要镜像、字面量环境变量、容器命令、端口、项目命名卷/bridge 网络、容器健康检查及部分资源限制。
- 不接受 build、宿主 bind、外部用户指定卷/网络、privileged、host network/PID、设备、cap_add、env_file、任意主机路径或 Docker socket。未固定版本和 `latest` 镜像拒绝。
- 动作：`discover / inspect / logs / apply / adopt / start / stop / restart / rollback`。只有管理员已批准任务才由中心派发；读取动作也不是隐式后台执行。
- 写动作必须传 `expected_generation`。每个成功写动作增加远端 generation；它与中心资源 revision 不同。`rollback` 另传 `target_generation`。
- `adopt` 只接受 generation 0、最近 inspect 的 `inventory_sha256`、`acknowledge_recreate:true`；它会重建容器使其带受管归属标签，因此可能中断服务。服务和镜像、现有安全命名卷映射必须匹配；外部未知项目默认只读。
- 接管的既有卷/网络在**内部生成配置**中按已核验的实际名称作为 external 引用；用户声明依然不能提供 external。原因是 Compose v5 在卷标签变化时可能提示销毁重建；系统不使用该路径修改既有卷标签。
- 受管配置位于 Agent `dataDir/operations/compose/<resource_id>`。受管目录不允许符号链接、其他用户可写或非 Agent 用户拥有；文件为 0600。项目锁、全局归属登记、历史摘要、pending journal 防止并发、误接管及未知结果自动重放。
- 写请求部分失败或验证不明时返回 unknown。原 operation ID 不重放；管理员查看后可创建新 apply/rollback 并传 `acknowledge_unknown:true`。若仍存在不符合归属规则的旧容器，保守拒绝，要求人工核实；不以删除卷来恢复。
- 恢复仅针对配置，不恢复数据卷、数据库数据或数据迁移。执行器无 `down --volumes`、`volume rm` 或 prune 动作。

## 自动边界测试

命令：在 `runtime` 目录执行 `node --import tsx --test test/operations-containers.test.ts`。10 项通过：

1. 严格配置子集、固定镜像、环境与命令遮蔽。
2. 参数数组执行、Compose `$` 转义、0600 文件、乐观 generation 与成功操作幂等回执。
3. 外部项目只读，准确 inventory＋重建确认后才接管。
4. 拒绝其他资源归属与宿主 bind 挂载。
5. unknown journal、禁止原操作重放、新方案显式收敛。
6. 日志项目绑定、已知环境值遮蔽、结果按 JSON 字节限制在 48 KiB 内。
7. 拒绝受管目录符号链接。
8. 同项目并发请求在调用 Docker 前被锁拒绝。
9. 接管后既有卷名称保持不变，更新不触发卷标签重建，用户不能注入 external 名称。
10. restart 等待健康检查离开 starting，避免把正常启动期误判 unknown。

`npm --prefix runtime run typecheck` 通过。仅使用执行器注入接口验证参数和失败边界；下面另列真实 Docker 证据。

## Linux 真实 Docker 验收

环境：经授权的 `vchive` Linux 主机，Docker Engine **29.3.0**、Docker Compose **5.1.0**。主机无 Node，测试从已存在的 LightMoni 镜像中复制 Node **24.15.0** 到专属临时目录运行；没有在宿主安装软件。测试使用已有 `python:3.12-slim` 镜像，没有拉取或重建业务镜像。

隔离项目：`lightmoni-ops026-qa-main-bohk`、`lightmoni-ops026-qa-adopt-bohk`、`lightmoni-ops026-qa-failure-bohk`。未发布主机端口，只使用各自命名卷、bridge 网络和专属临时 Agent 数据目录。测试驱动直接调用编译后的真实领域执行器；Docker 使用参数数组、关闭 stdin、有输出及超时限制，不通过 shell 执行用户内容。

完整脚本得到 `passed:true`、18 条运行/断言记录：

| 场景 | 结果 |
|---|---|
| 新项目 apply、inspect | 容器 running/healthy、归属正确、generation 1 |
| 相同成功 operation ID 再次提交 | 返回之前的验证回执，未再次调用 Docker |
| logs | 有真实业务日志；配置中的测试 token 值被遮蔽 |
| stop、start、restart | 分别 generation 2、3、4；核对真实容器状态 |
| 配置更新 | generation 5，容器重建使用新版本内容 |
| 陈旧 generation 写操作 | 拒绝执行 |
| 配置 rollback 到 generation 1 | 新 generation 6，恢复原配置 |
| 数据卷边界 | 卷中同时保留 v1/v2 写入记录，证明配置回退没有还原或清空数据 |
| 外部 Compose 项目 | inspect 显示未受管；apply 和错误 inventory 的 adopt 均被拒绝 |
| 正确 inventory 的显式 adopt | 容器带上 LightMoni 归属，已有命名卷不重建；接管后 restart 成功 |
| 容器真实退出码 4 | apply 返回 unknown，pending 可见，原 operation ID 不能重放 |
| 新方案显式确认 unknown | 修改为可运行配置后成功收敛，不自动重试原操作 |
| privileged 配置 | 验证阶段拒绝 |

实测发现并修正：restart 的 Docker 命令返回时健康检查可能还处于 starting，现以最多 60 秒有界轮询确认；Compose v5 对既有卷标签变化存在交互重建路径，现对已核验接管的卷/网络使用内部精确 external 引用。存储发现随后从宽泛名前缀收窄为实际声明名的精确正则，避免相似项目前缀冲突；最终短冒烟复核见下。

完整脚本 finally 仅清理上述 QA 项目，并分别核对其 `docker ps / volume ls / network ls` 列表为空；301 条 Docker 调用，不包含 `docker prune`、宿主服务重启或非 QA 项目写操作。测试清理允许删除测试自己创建的数据卷；产品执行器不提供此删除操作。

## 使用限制与后续边界

- 目前为受限 JSON Compose，不是任意 YAML/Compose 文件兼容器；不支持 build、宿主目录挂载、扩容、GPU、Kubernetes 或数据库迁移恢复。
- 固定 tag 确定了用户选择，但 registry 的 tag 仍可能被重打；需要严格不可变交付时使用 sha256 digest。
- Compose v2.20 及以上是执行器依赖下限，真实运行版本为 v5.1.0；未声明已在所有 v2 小版本逐一运行。
- 没有 healthcheck 的容器仅验证 running；有 healthcheck 时要求 healthy，不代表已验证对外业务功能。
- 任意业务日志仍可能含未知敏感数据；当前配置环境值与常见凭据格式会遮蔽，AI 读取路径应整体省略原始日志。
- 进程被终止可能留下项目锁。为避免错误回收他人新锁，系统不自动删除死进程锁；需管理员核对项目、pending journal 及进程后在节点清理旧锁。未知 Docker daemon 请求不能当作已回滚。
- 最多保留 1000 个受管配置/动作代数；达到上限会明确拒绝继续写入，需要后续归档方案。

## 最终过滤规则冒烟复核

使用最终编译模块再运行两个独立项目：新建 apply→inspect 验证准确发现自己的 1 个卷和 1 个网络；外部项目 inspect→adopt 验证已有卷/网络精确引用。结果 `passed:true`，6 条运行/断言记录；72 条 Docker 调用。两个项目再次逐一清理并核对容器、卷、网络为空。此次重新验证针对名字正则过滤变更，没有扩大验收声明到未执行的协议或环境。

## Docker 本机目标绑定复核

安全复核发现：只移除 `DOCKER_HOST` / `DOCKER_CONTEXT` 环境变量还不够；CLI 会读取继承 HOME 下 `.docker/config.json` 的 `currentContext`，可能把节点任务发给其他 daemon。因此所有领域 Docker 参数数组现在固定前置 `--context default`，本地测试 fixture 逐条断言该前缀。

在同一 Linux / Docker / Compose 环境追加独立短冒烟：临时 HOME 中写入一个不存在的 `currentContext`。未固定 context 的 `docker version` 按预期失败；真实领域 apply 和 inspect 均成功，generation 1、1 个本机运行容器、22 条领域 Docker 调用，证明持久化 currentContext 不能改写目标。QA 项目 `lightmoni-ops026-qa-context-yeyt` 的容器、卷、网络已逐项清空，临时 Node 和 HOME 均清理。本机 Docker 默认 Unix socket 为此版本的目标，不声称支持任意 rootless socket 或远端 Docker context。
