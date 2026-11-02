# SDD082：独立 root 执行器实机回测

日期：2026-11-02，Asia/Shanghai。用户明确授权在其开发机临时安装独立 root 执行器，批准三类能力，仅执行身份/版本检查、专用测试容器和 LightMoni 自身检查，结束后卸载。安装和卸载通过平台的 SSH 引导/维护计划及管理员批准完成；三类能力任务通过独立执行器签名执行并回传结果。另行使用 SSH 进行只读现场核验。此记录不包含生产地址、登录秘密、完整配置或终端全量输出。

## 发行与安装

- 复用平台正式 linux/amd64 发行，源码 `ccbb85d3156f428c297422dc679cab3cc215b5dd`，build `0.1.0-ccbb85d3156f-65b859be9837`，包 SHA256 `41537e4bacb85f1a6ae662467fdc49092e8d4cbb8fafb7682a150b3db98aaf16`。
- 安装计划 `21c14ede-bf3e-40cd-9f2a-d1c83d07118d` 从 running/pending 到 succeeded，执行器独立签名心跳 online=true，发行信息匹配。
- 执行器 `9787c71b-bc15-4c91-81d0-d7370e5b4429`，install_generation=1；`script.elevated.v1`、`container.managed.v1`、`operations.managed.v1` 均经显式授权并达到 ready。
- SSH 核验执行器 systemd 服务以 root 运行，普通 Agent 继续以 lightmoni-agent 运行，未加入 Docker 组，NoNewPrivileges=yes。未把普通 Agent 改成 root。

## 提权脚本与批准约束

| 检查 | 实际结果 |
| --- | --- |
| 只读身份脚本 | 计划 `0665cefd-8256-411d-9cba-157482067cf6`，job/task_run `2bd4c6dd-d1b0-497f-ac5a-f954fb4c25ab`，succeeded / script_succeeded，exit_code=0 |
| 执行身份 | 管理员敏感输出显示 UID=0、GID=0、groups=[0]，与 root profile 一致 |
| 主机信息 | CPU=2、内存总量=2061844480 字节、Node=v24.15.0；主机名和独立 SSH 相符 |
| 输出边界 | 普通 task-run 接口 stdout/stderr 为空；结果只经管理员敏感输出接口读取 |
| 幂等重试 | 同计划、同 request_id 返回原 job，没有重复执行 |
| 批准重放 | 同计划换 request_id 返回 HTTP 409 / replay_conflict |

## 专用容器全生命周期

只创建 `LMQA082_pause_20261102`，不操作既有业务容器。使用固定 digest 的 pause 镜像 `registry.aliyuncs.com/google_containers/pause@sha256:8d4106c88ec0bd28001e34c975d65175d994072d65341f62a8ab0754b0fafe10`；本机 inspect 确认 linux/amd64、无 VOLUME，使用默认 /pause，不提交 command/env/volume。

| 动作 | job ID | 平台结果 |
| --- | --- | --- |
| pull | `7603a6d1-2abf-4b9c-bd2e-4dcb359d8838` | succeeded |
| create | `da1190d7-326e-4a58-9b01-44beaced78c8` | succeeded |
| start | `3cde02f7-8285-44f5-bd0e-5b7403fe5238` | succeeded / running |
| restart | `a67faf49-d734-458c-acb1-25af2adf6103` | succeeded / running |
| stop | `793fafbd-57bc-4b51-baf3-0cd2d3301461` | succeeded / exited |
| remove | `6b8b94f1-892d-4daa-aef0-7fbdbb746b74` | succeeded |
| list | `010beec7-faa3-4d4a-9857-31c83c630f10` | succeeded；仅余既有容器，managed=false、running |

SSH 只读 inspect 验证专用容器 user=65532:65532、readonly=true、network=none、CapDrop=ALL、no-new-privileges、mounts=[]。所有创建、启动和删除动作经平台批准执行，没有用 SSH 直接操作容器代替产品验收。原业务容器保持同一 ID，最终仍 Up 5 days。

本机访问 registry.k8s.io 和 Docker Hub 失败；替换为上述固定 digest 的阿里镜像源后，本机镜像检查成功，平台下发的目标开发机 pull 任务成功。该网络限制不计为执行器缺陷。测试镜像缓存没有作全局清理或 prune，不能声明主机完全无新增缓存。

## 受管运维与维护门禁

- 创建仅含目标开发机的临时 cluster `bd65f23b11dd6962ae7097ed8964876a`，执行只读节点 inspect。ops run `b594e7d7435eac17c1b2ae6ee2ad8fae` succeeded，对应 root job `0b63e2a31e776a16e223975d600d2b2c` succeeded，execution_principal=privileged_executor、capability=operations.managed.v1。
- inspect 返回 CPU=2、内存约 1966 MiB、Docker=29.3.0，与 SSH 现场一致。未测试网站发布、备份、挂载或用户业务部署。
- 维护 probe：fenced=null、pending_results=0、phase=ready、repairable=false、previous=null，当前正式发行匹配。
- 同发行 upgrade 返回 409 / executor_target_release_unavailable；无 previous 的 rollback 返回 409 / executor_previous_release_unavailable；健康现场 repair 返回 409 / executor_repair_phase_unverified。以上是预期门禁通过，**没有执行独立执行器成功升级、成功回退或成功修复**。

## 清理与最终独立核对

1. 专用容器已通过平台 remove 删除；list 及 SSH 的 docker ps -a 均只剩原业务容器。
2. 临时 cluster 移除成员后 revision 升至 2，再删除成功；最终 GET 返回 404 / platform_resource_not_found。执行审计保留。
3. 卸载计划 `1ae726e9-fac5-4e27-b355-d8da00c3a535` succeeded，error 为空，完成时间 `2026-11-02T01:19:40.189Z`。
4. 平台 execution-status：executor.state=revoked、online=false、policy_generation=2；浏览器主机详情再次确认容器管理、提权脚本和受管运维均为“中心未授权 / 已关闭”，普通 Agent 在线。
5. SSH 核验 lightmoni-executor.service 为 not-found / inactive；`/opt/lightmoni-executor`、`/etc/lightmoni-executor`、`/var/lib/lightmoni-executor`、`/usr/local/sbin/lightmoni-executor` 均不存在。普通 Agent 服务为 loaded / active、User/Group=lightmoni-agent、NoNewPrivileges=yes。
6. 最终普通 Agent 心跳 `2026-11-02T01:23:41.387Z`，六项主机采集均 ok；queue_bytes、queue_batches、quarantine_batches 均为 0，last_error 为空，receipts=1700。
7. 去秘密请求元数据及清理后截图只保存在本机临时证据目录，截图随本次交付展示，不将生产详情提交开源仓库。

此次只验收现有架构和批准边界，没有新增职责、协议或权限模型，架构同步不适用。未知 journal、身份损坏、断网、竞争、真实业务锁及自动恢复未在用户开发机注入；对应隔离回归见 [本地维护证据](evidence-node-remove.md)，不冒充线上通过。
