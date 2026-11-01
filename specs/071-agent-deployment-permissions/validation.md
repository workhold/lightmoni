# 验收记录

日期：2026-11-01。与 SDD 070 同一 PR #58，分支 codex/070-docker-low-port-preflight。

标准安装/升级会准备 Docker 服务附加组、独立公开网站目录，并安装 CAP_NET_BIND_SERVICE、明确系统命令 PATH 和真实服务身份的启动前检查。检查覆盖配置读取、目录写入/fsync/原子切换、低端口和 Docker socket/CLI；缺少依赖保持待就绪，权限不足阻止 ready。旧包无 helper 时保持原契约，失败升级和主动回退仍使用原 unit，身份、配置和队列不回退快照。

## 已执行

- Node 24.15.0 定向测试：agent-deployment-permissions、install-release、agent-update-runner、operations-websites 共 65 项全部通过；包括首装、权限准备失败、目标升级和旧包/原 unit 恢复。host-ports、platform-executor、application-install、operations-certificates 另 77 项全部通过。
- helper 数值检查加固后，权限、网站和证书 18 项再次全部通过。runtime/web 类型检查、Node/shell 语法及 git diff --check 通过。
- [真实 Linux 验收输出](evidence/linux-websites.txt)：只读根、无外网、真实非 root UID、Docker 附加组、唯一 NET_BIND_SERVICE capability、NoNewPrivs=1、低端口阈值 1024。无 Docker 组的对照被拒绝；相同 UID 正确组下启动检查通过，80/443 实际绑定成功。
- 同环境调用生产网站与证书执行代码，真实 Nginx 完成静态站点、反向代理、更新重载、旧版本恢复、错误更新自动恢复、HTTPS 443、证书轮换与指纹读回、日志读取和禁用。私钥 0600，默认公开目录与五类 Nginx 临时目录均核对；系统目录写入被拒绝。测试 HTTP 使用新连接，避免重载期间既有 keepalive 连接的正常旧 worker 响应影响内容判定。
- [复现入口](evidence/run-linux.sh) 构建 [Linux fixture](evidence/Dockerfile)，调用 [验收代码](evidence/permissions-linux.mjs)。Debian HTTPS 官方镜像可通过 DEBIAN_MIRROR 选择，本轮使用 USTC；软件包签名及 TLS 校验保持。
- unit 在 systemd 252 通过 systemd-analyze verify。实际执行身份/附加组/capability/只读根由 setpriv 与隔离 Linux 容器验证；没有把该测试描述为启动了整台 systemd 主机。父测试进程为初始化 tmpfs 和切换 UID 保留额外 capability，受测 Agent/Nginx 子进程只保留 NET_BIND_SERVICE。
- Docker socket 使用真实 Unix 权限和真实 Docker CLI，对接只读 Engine API fixture；只验证本地访问权限，未挂载宿主 socket，也不代表已经真实部署全部第三方 Docker 应用。

## 架构同步

适用。仓库 docs/system-design.md 第 71 节与 docs/agent-deployment.md 已同步；[Doca 系统设计基线](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53) 最终 seq 917。全文回读保留全部 707 个原块及 34 个原生图，新章节正文与 8 节点/10 连线原生图一致，见 [回读证据](evidence/doca-readback.json)。SDD 060 的独立特权执行器仍是单独规划；本次标准 Docker 授权接近宿主 root，普通管理员脚本继承服务权限，不提供脚本隔离保证。

## 发布边界

当前验收没有修改 xiangxiaojia 的服务、业务或配置。生产机器仍需安装含本改动的新 Agent；镜像发布不会自动升级已有 Agent。本轮后续按用户授权汇总其他会话，通过 PR 合入 main 并发布 Docker/GitHub，最终版本与结果由发布 SDD 另行记录。

## 汇总合入

已同步最新 origin/main 286c8ba（包含其他会话 PR #44/#47/#55），保留全部章节和诊断分支；本次更新 [PR #58](https://github.com/workhold/lightmoni/pull/58) 的最终行为、Docker 信任边界和真实验收限制。旧设计中 SDD060 建立时的“当前”描述是历史基线，发布运行契约以本 SDD071 为准，独立执行器任务仍未实施。
