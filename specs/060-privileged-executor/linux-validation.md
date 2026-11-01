# SDD060：真实 Linux 执行器验收

本验收使用本地可销毁的 Linux systemd Docker 容器、内存数据库、临时 Ed25519 身份和 localhost HTTPS 中心，不使用用户主机、生产地址或真实凭据。不得把测试 harness 放到用户机器上运行。`scripts/test-privileged-executor-linux.mjs` 要求 Linux root、Docker 容器和 `--isolated-systemd-container`，并拒绝覆盖已有执行器配置或 journal。

## 已验证

2026-11-01，在本地 Colima Linux arm64/systemd 252、Node 24.15.0 环境：同包安装、独立注册、签名计划、在线许可、真实 UID 0 脚本、任务主体隔离、敏感正文隔离、签名策略关闭、本地卸载与中心身份精确撤销通过。最终加固版安装/卸载使用追加模式 FD 锁与 inode 绑定，卸载核验固定 unit、有效 DropInPaths、停止后 inactive 和 writer 锁；这些实际生产路径已在全新容器重新通过。一次性测试 CA 经 `NODE_EXTRA_CA_CERTS` 显式信任，没有关闭 TLS 校验。

负例：关闭 system bus 后 `scriptDependenciesReady()` 为 false，恢复后为 true；真实 `sleep 20` 配置 1 秒超时，以 `failed/timeout` 结束，约 1.02 秒返回。核心单元/协议/恢复测试另有独立记录。

发现并修复了两项实际接缝：systemctl 私有 socket 正常不代表 systemd-run 所需 system bus 可用；RemainAfterExit 会保留 IO FD，须先冻结真实 InvocationID/退出结果，再停止已完成的单元释放 FD。停止或观察不确定时仍保留 unknown，不以客户端退出码替代服务结果。

Docker 的真实执行范围以 harness 回执为准；即使 create/remove 通过，也不代表 pull/start/stop/restart、Compose、日志尾读、仓库鉴权或完整生命周期都已实机验收。

## 复现前提

需要安装了本仓库运行时依赖的本地平台镜像，以及本地编译的 `runtime/dist`。可复用一次已构建的平台镜像，派生一个**仅用于验收**的镜像：

```dockerfile
FROM your-local-platform-image
USER root
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends systemd systemd-sysv dbus openssl curl && rm -rf /var/lib/apt/lists/*
ENTRYPOINT ["/sbin/init"]
```

下列命令的 Docker context 必须是**隔离的本地测试 VM**。`--privileged` 和 cgroup 挂载只服务于容器内真实 systemd，不用于生产 Agent 配置。镜像名、context、容器名按本机情况替换。不要在同一个已有 unknown journal 的容器内重跑。

```sh
npm --prefix runtime run build
docker --context colima-lightmoni-release run -d --name lightmoni-executor-qa-new --privileged --cgroupns=host --tmpfs /run --tmpfs /run/lock -v /sys/fs/cgroup:/sys/fs/cgroup:rw --security-opt label=disable local/lightmoni-executor-systemd-qa:latest
docker --context colima-lightmoni-release exec lightmoni-executor-qa-new mkdir -p /opt/lm060-package/app/runtime /opt/lightmoni/runtime/node_modules
docker --context colima-lightmoni-release cp runtime/dist/. lightmoni-executor-qa-new:/opt/lightmoni/runtime/dist/
docker --context colima-lightmoni-release cp runtime/dist lightmoni-executor-qa-new:/opt/lm060-package/app/runtime/
docker --context colima-lightmoni-release cp runtime/node_modules/cron-parser lightmoni-executor-qa-new:/opt/lightmoni/runtime/node_modules/
docker --context colima-lightmoni-release cp runtime/node_modules/luxon lightmoni-executor-qa-new:/opt/lightmoni/runtime/node_modules/
docker --context colima-lightmoni-release cp deploy/executor lightmoni-executor-qa-new:/opt/lm060-package/
docker --context colima-lightmoni-release cp scripts/test-privileged-executor-linux.mjs lightmoni-executor-qa-new:/opt/lm060-harness.mjs
docker --context colima-lightmoni-release exec lightmoni-executor-qa-new sh -c 'mkdir -p /run/lm060; cp /usr/local/bin/node /opt/lm060-package/node; printf "{\"version\":\"0.1.0\",\"source_revision\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"build_id\":\"sdd060-linux-qa\",\"state_schema\":1,\"platform\":\"linux\",\"arch\":\"arm64\"}\n" > /opt/lm060-package/release.json; chown -R root:root /opt/lm060-package /opt/lightmoni/runtime/dist; chmod -R go-w /opt/lm060-package /opt/lightmoni/runtime/dist; openssl req -x509 -newkey rsa:2048 -nodes -keyout /run/lm060/tls.key -out /run/lm060/tls.crt -days 1 -subj /CN=localhost -addext subjectAltName=DNS:localhost; systemctl start dbus; node /opt/lm060-harness.mjs --isolated-systemd-container'
```

amd64 测试时将 fixture manifest 的 `arch` 改为 `amd64`。本 fixture 的首次安装摘要与源码版本为固定测试值，验证安装/身份/执行协议；后续维护由 harness 现场生成真实 archive 并校验其真实 SHA-256，不代表正式发行包已验收。

harness 成功时输出 `pass: true`，同一份无秘密 JSON 写入容器 `/run/lm060/report.json`。harness 会先证明生产卸载器拒绝自身测试 CA drop-in 且保留身份和 journal，再仅删除本 harness 创建的精确 `qa.conf` 与空目录、重载 systemd 后调用未修改的生产卸载器。测试身份、私钥和 CA 留在容器内，不应导出或提交；仅导出报告。测试失败时保留该容器和 journal 排查，重新验收使用新容器，不能删除未知结果后继续当新任务执行。

可选 Docker 验收：仅在隔离测试 VM 上给**新容器**增加 `-v /var/run/docker.sock:/var/run/docker.sock`，并给 harness 设置 `LIGHTMONI_QA_DOCKER_IMAGE=repository@sha256:...`。该 image 必须已经在测试 daemon 中，Linux/原生架构固定、不含 image Config.Volumes。harness 经同一签名任务通道测试脱敏 list、外部资源拒绝、受管 create/remove，不启动创建的容器，不操作已有容器。失败时不执行 prune 或按名称模糊清理。


## #64 完成收口的新增验收（2026-11-02）

最终代码在全新隔离 Linux arm64/systemd 252.39/Node 24.15.0 容器中再次通过。无秘密报告见 [linux-completion-report.json](linux-completion-report.json)，原始首次 Docker 验收报告保留于 [linux-validation-report.json](linux-validation-report.json)，两者对应不同运行，不混用结果。

本轮使用未修改的生产维护 shell、独立 root 监督器、固定生产 unit 与真实下载的 fixture archive，验证 upgrade、精确 previous rollback、独立 activation 回执、实际 stop→writer 锁竞争后的持久 unknown、只读状态不改变 journal、由新明确请求执行 repair、身份与完整逻辑 journal 保持，以及最终离线卸载和中心精确撤权。整个过程没有重新 enrollment 或重放旧操作。实际发现 Linux 的 umask 077 会改变复制后的目录 mode；修复为经无跟随 FD/inode/owner/type 核验后恢复已验证源权限、fsync 再校验指纹，回归与最终全新容器均通过。

维护 fixture archive 的真实摘要为 `7fc5ba0d2b275d7da846cc15665ef425700f901509cb665bab5474467122c175`；生产源文件及 harness 摘要记录在报告中。首次安装 manifest 的源码版本及初始摘要仍是 synthetic fixture，不能据此宣称正式发行完成。

固定生产 unit 不继承 harness 的测试 CA，因此本段证明本地程序、锁与状态生命周期；中心 started receipt 与本次 activation 签名心跳联合确认，由另外的 HTTP/SQLite 真实签名集成 fixture 验证，未声称本轮完成真实中心的端到端升级。首次安装、签名 root 脚本、1 秒超时、主体/敏感正文隔离与签名策略关闭也在此新容器复验。本轮未挂 Docker socket，没有新的真实 Docker 操作结果；此前 list/create/remove 只属于首次报告。

失败尝试各自保留独立容器与现场，不清除 unknown 后重跑。最终验收后停止本轮容器，不删除失败 journal，不连接用户主机，不发布镜像。
