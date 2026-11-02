# SDD083 验收记录

日期：2026-11-02。实际开发分支为 `feat/083-unified-agent-runtime`，基于 `e2f19db9d8f9f08a6fcdf0d47d49780b911a2d42`。所有验证均在本机或隔离环境运行，未升级线上平台或 vchive。

## 自动化检查

| 检查 | 结果 |
| --- | --- |
| runtime 完整测试（最终代码） | 1,591项：1,559通过、32跳过、0失败 |
| ai-runtime 完整测试 | 71通过、0失败 |
| TypeScript SDK 完整测试 | 22通过、0失败 |
| 根目录 typecheck | runtime、ai-runtime、web 全部通过 |
| 根目录 build | SDK、runtime、ai-runtime、web 全部通过；现有依赖 use client 打包提示不影响退出码 |
| 隔离浏览器验收 | 17项全部通过，详见 ui-validation.md |
| 安装/维护/运行账户最终定向 | 54项通过 |
| git diff --check | 通过 |

完整 runtime 日志为本地 `/tmp/lightmoni-083-runtime-final2.tap`；其余日志分别为 `/tmp/lightmoni-083-ai-final.tap`、`/tmp/lightmoni-083-sdk-final.tap`、`/tmp/lightmoni-083-typecheck-complete.log`、`/tmp/lightmoni-083-build-complete.log`。自动化覆盖严格身份、签名边界、双向切换、陈旧与重放拒绝、凭据撤销、维护互斥、失败回滚、完整回执与同 boot 心跳双确认、unknown 只读核对、首装失败精确撤权、模式保留及统一卸载。

最终仅对新增模块应用格式整理后，重新执行相关运行时78项、界面17项及根 typecheck，全部通过；两种 service 模板 SHA 保持不变。

## 实际 Linux/systemd 验收

使用本机专用 Colima VM 和 network none 的 Linux arm64 systemd 容器，中心为容器内回环 TLS mock。实际完成 user 首装（UID/GID997）、两种 unit 的 systemd-analyze verify、同一服务 user→root→user→root 连续切换（代次2/3/4），身份保持不变。root 的 managed-check/status 通过，普通及签名心跳在同一 Agent 进程正常工作。

root 同版本重装保留模式和内部身份；官方 update-runner 通过真实 systemd-run 后台执行不同 SHA 制品更新，进入等待确认后提交成功；更新后 root 模式与 managed-check 正常。手动 uninstall --purge 成功，程序、unit、managed 配置、activation 与内部数据均已移除。之前另一次隔离 Linux 执行验证了普通脚本实际降权、零有效 capabilities、无附加组、NoNewPrivs，以及不能读取或写入 root 私有目录。

集成验收发现并修复了维护备份父目录重复创建失败、root 配置目录0750与密钥0700要求冲突两处真实缺陷；修复后连续流程通过。专用容器已删除、Colima VM 已停止。可分享的无秘密摘要见 validation-evidence/linux-systemd-summary.json。

边界：Linux fixture 未连接真实平台或 SSH 目标；更新为同一 build 重打包产生不同 SHA，未验证功能版本差异；本次未做真实平台首次 root 注册安装、完整 root 脚本或 Docker 业务任务端到端派发。amd64 制品完成构建但未在 amd64 systemd 主机运行。32项跳过不计为通过。

## 普通 SSH 账户与按需高权补验

针对普通 SSH 登录、未登记 root 账户的模式切换，以及 root 凭据与任务执行身份的边界，追加以下核验：

- HTTP/数据库集成测试使用唯一的普通 `deploy` SSH 登录凭据，确认免交互 sudo 能完成 root/user 首装及 user→root 切换，期间没有新增 root 登录、替换 SSH 用户名或修改登录秘密。SSH 返回由 fixture 模拟。
- sudo 不可用、需要交互密码或权限状态未知时，计划与执行阶段都拒绝账户切换；不派发维护、不签发内部执行身份，也不扩大已批准权限。相关三份服务端测试118项通过；普通任务及高权执行定向回归19项通过，SSH/主机检查62项通过。
- 在本机隔离 Linux 容器启动真实 sshd，禁用 root SSH，分别以三个全新普通账户公钥登录，实际 UID 为10002/10003/10004。真实 sudoers 的 NOPASSWD 账户可通过 sudo -n 获得 UID0；项目完整 preflight 命令正确返回 sudo_noninteractive/install_privilege=1。禁止 sudo 与需要 sudo 密码的两个账户均返回 unavailable/install_privilege=0，固定维护 wrapper 拒绝执行。
- 有免交互 sudo 的维护 probe 到达真实 root helper 后，因 fixture 故意未安装配置而返回 runtime_maintenance_failed；没有执行安装或切换。安装目录、生命周期锁与三个 helper 摘要前后一致。临时容器和密钥已删除，专用 Colima VM 已停止。无秘密证据见 validation-evidence/nonroot-ssh-summary.json。

结论边界：不要求 root 直接 SSH 登录，但系统级安装、维护和账户切换要求当前 SSH 登录具有 root 或免交互 sudo 权限；平台审批不能替代操作系统权限。此真实 SSH fixture 没有 systemd、curl 或可达中心，整体安装就绪检查预期不通过，只证明 SSH/sudo 与项目命令的权限边界。完整首装/切换的服务端流转使用模拟 SSH，真实 systemd 生命周期的覆盖范围见上文，不能合并描述为真实平台端到端验收。

登记 root 登录凭据不会自动改变已选 Agent 模式。root 模式的常驻 Agent 主进程为 UID0，普通脚本固定降权到 lightmoni-agent；root 作业经单独批准并记录审计。user 模式不会因保存了 root 凭据而自动为普通作业提权，必须先批准并完成显式运行账户切换。

本轮追加仅涉及测试与验收证据，架构同步不适用：运行账户、SSH 权限和任务审计契约未变，既有仓库第83章与 Doca seq937 保持有效。

追加主机编辑互斥修复：运行账户切换为 awaiting_approval、running、verifying 或 unknown 时，编辑主机在请求开始及写事务内均检查维护门禁，避免名称或 SSH 目标变化使原计划无法只读核对。取消待审阅计划后可编辑；unknown 期间仍可添加同登录账户的新凭据供只读核对。包含请求体读取后的并发维护状态变更回归，相关服务端126项通过，runtime typecheck 与 diff-check 通过。此修复只落实已有维护互斥契约，不新增账户模型或权限路径。

## 设计与 Doca

仓库 docs/system-design.md 更新当前基线及第83章，旧分离进程拓扑明确标注历史。Doca [LightMoni 系统设计基线](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53) 同步正文和两张原生可编辑图。

seq936 完整回读确认原746块保留，38张原生图保持原始节点和连线，新增37块含2张原生图；随后 seq937 定向更新并回读6段正文和维护流程图，逐字/逐节点/逐连线相等，涵盖成功回执加同 boot 心跳、失败恢复、新凭据只读核对及升级限制。证据见 validation-evidence/doca-readback-proof.json。

未发布镜像、未更新用户机器，也未恢复 vchive 已撤销的 root 授权。生产部署后的首次 root 安装、功能版本升级和实际 Docker/提权任务仍需独立验收。
