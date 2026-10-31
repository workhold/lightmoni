# 验证记录

日期：2026-10-31。最终同步基线：GitHub `origin/main` 6dae46c（含 PR #36），合并冲突已保留证书下载接口，并将 Docker 任务依赖传入观测模块。

## 现场排查

已登录生产页面 `https://moni.heyphp.com/machines` 只读核对：目标主机 Agent 在线，最近上报正常，CPU、内存、磁盘、网络采集为 ok，应用采集为 `application_collection_unavailable`。旧实现刷新只 GET 中心快照；采集失败保留旧 observed_at，而 UI 优先显示 stale，因此用户看不到真实采集错误。

生产旧版本只保存通用错误，不能据此确认 CLI 缺失、socket 权限或 daemon 故障中的哪一种；没有对生产容器执行启停，也没有声称生产已修复或已升级。标准服务运行用户为 lightmoni-agent，安装器不自动授予 Docker 管理权限；部署文档补充前置要求和只读排查。

## 自动检查

- `npm --prefix runtime run typecheck`：通过。
- `npm --prefix runtime run build`：通过。
- `npm --prefix web run build`：通过；保留现有依赖的 use-client bundler 提示。
- 同步 main 后执行 `node --import tsx --test test/docker-controls.test.ts test/application-observability.test.ts test/agent-jobs.test.ts test/agent-job-runner.test.ts test/platform-api.test.ts test/platform-cloud-certificates.test.ts`：78 项，74 通过，4 按条件跳过，0 失败。跳过项含 2 个既有发行制品测试及 2 个需要显式开启的真实 Docker 测试。
- `LIGHTMONI_DOCKER_LIVE=1 node --import tsx --test test/docker-controls.test.ts`：9 项全部通过。使用本机真实 Docker default daemon；新建仅用于本次测试的 alpine:3.23 容器，network=none，无端口/目录挂载，验证 start→running、restart→running、stop→exited，随后清理。真实 Docker 查询和变化后清单均使用生产受限命令函数。
- `git diff --check`：通过。

覆盖：管理员与 Agent control 鉴权、跨主机拒绝、确认要求、完整 ID、清单新鲜度、旧 Agent 和离线提示、并发刷新复用、写任务幂等、请求冲突、任务过期、错误保留旧清单、白名单与大小上限、回执动作绑定、未知结果与持久写锁、租约生命周期以及既有应用/证书回归。

## UI 验收

通过 Chrome 访问独立本地 Vite 页面；夹具使用真实 Router、SQLite、管理员接口、AgentJobRunner 和租约协议，Docker 命令为合成状态机，与前述真实 Docker 检查分开记录。

1. 未成功采集时显示 CLI 缺失及最近尝试时间，没有显示空清单成功。
2. 点击立即采集显示“等待 Agent 领取”，经 Agent 回执变为“已完成，清单已更新”，Docker 数量 0→2。
3. 空平台应用提供查看 Docker 容器入口，显示外部运行/停止容器及操作。
4. 停止先展示主机、完整 ID、中断说明及确认；确认后显示任务状态，完成后 qa-orders 从 running→exited，操作变成启动。
5. 启动按钮展示对应确认并提交同一受限任务通道；接口与真实 Docker 启动结果另外验证。

截图：`evidence/docker-after-stop.jpg`。未把 UI 夹具作为生产 Docker 修复证据；未声明移动端、所有主题或大规模主机列表性能已验。

## 架构同步

适用：新增手动 UI→中心→Agent→Docker→核验回执路径，分离周期清单与应用日志，按时间合并心跳/即时清单。

仓库：`docs/system-design.md` 第 57 章；[Doca LightMoni 系统设计基线](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53) 同名章节。Doca 成功保存后以最新 seq 891 / 资源版本 892 回读；5 段正文、7 节点、8 连线逐项相符；575 个原有块的顺序和内容完整保留，标题保持不变。详见 `evidence/doca-readback.json`。没有凭据进入正文、仓库或回执。

## 发布要求

本次是功能分支交付，需要合入后发行并升级中心与目标 Agent，再现场核对 Docker CLI、daemon 和服务用户 socket 权限。旧 Agent 心跳保持兼容，即时能力明确提示升级。未知的变更不会自动重试，保留写锁，需要管理员核查现场后恢复。
