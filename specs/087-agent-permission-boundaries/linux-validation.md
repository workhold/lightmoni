# 独立 Linux/systemd 生命周期验收

验收夹具：[`agent-linux-systemd-smoke.ts`](../../runtime/test/fixtures/agent-linux-systemd-smoke.ts)。该夹具不进入发行包，也不会连接 vchive 或生产平台。

## 环境与执行方式

在本机 Colima 的专用容器中运行 Debian Bookworm ARM64、Node 24.15.0 和真实 systemd。容器需要独立 PID/cgroup 命名空间、容器内 root 和 systemd 所需能力；不挂载 Docker socket或宿主 `/etc`、`/var/lib`、`/opt`。`/tmp` 必须允许执行，避免 Docker tmpfs 的默认 `noexec` 把发行包 Node 阻挡。

准备生产代码、Linux 平台安装的 runtime 依赖，以及两个不改字节的发行目录。`target` 来自待发布镜像内的 `/opt/lightmoni/runtime/downloads`；`previous` 使用本轮已固定的前一个可用构建。容器内测试工具放在 `/qa/tool-bin`，以便每次首装前都删除 `/usr/local/bin`，验证安装器会创建它。

容器中还需：

- systemd、dbus、sudo、util-linux、passwd、curl、CA 证书与 iproute2。
- 测试登录账号 `qa-deploy`，只在该容器设置 `/bin/sh` 的免交互 sudo；不登记 root 凭据来完成其监控模式安装和模式切换。
- `USERGROUPS_ENAB=no`。每次首装前，专用 Agent 账号、同名组、程序与管理状态均不存在。
- 仅监听容器 loopback 的 HTTPS 中心，测试证书由 curl 的容器 CA 存储和 Node 的 `NODE_EXTRA_CA_CERTS` 信任。systemd manager 和测试 sudo 只透传这个 CA 路径，不关闭 TLS 验证。

运行：

```sh
LIGHTMONI_LINUX_SYSTEMD_SMOKE=disposable-container \
NODE_EXTRA_CA_CERTS=/qa/tls/cert.pem \
/qa/tool-bin/node --import tsx \
  runtime/test/fixtures/agent-linux-systemd-smoke.ts \
  /qa/target /qa/linux-systemd-report.json /qa/previous
```

夹具启动时会拒绝非 Linux、非 root、没有 `/.dockerenv`/systemd、已有 Agent 账号或同名组、已有程序或 `/usr/local/bin` 的环境。仅限一次性容器，不能在待托管业务主机直接执行。

## 覆盖与真实边界

- 原安装器和平台固定安装命令、真实发行包校验、平台注册与激活、真实 systemd 单元启动。
- root 登录完整管理模式、普通登录账号经 sudo 安装监控模式；两轮均从无 Agent 账号与同名组、无 `/usr/local/bin` 开始。
- 常驻进程实际为非零 Agent UID/GID，NoNewPrivileges 生效；helper 实际为 root。额外的 Linux 专项用例读取 `/proc/self/status`，验证普通脚本的空附加组与全零 capabilities。
- 真实签名 helper 领取普通脚本，同 Agent UID 执行并回报；批准的提权脚本经真实 systemd 瞬态单元执行，核对 root 输出与审计。
- 前一构建升级到镜像原产物、回退到保留构建、再次升级；要求两组件的目标 source/build/artifact 相符，helper 激活 ID 变化。
- root 与 user 模式双向切换，以及 sudo 登录且未登记 root 凭据时的双向切换；核对实际服务、权限代次与切换后脚本身份。
- 平台统一卸载两个服务、清除 helper 私密状态、撤销两条凭据，同时保留普通数据。夹具随后额外删除测试账号、组与目录，为下一轮制造真正空白环境；产品卸载仍保留系统账号及业务数据。

SSH runner 只替换为容器内对应登录身份执行的本地适配器，执行内容和保护的 stdin 使用平台原命令；本验收不声称覆盖 SSH 网络握手、密码/私钥认证或主机指纹发现。HTTPS 由真实传输完成，中心使用生产代码的主机、凭据、节点、任务与签名模块；遥测存储由内存接收端替代，不声称验证 ClickHouse。未挂载真实 Docker daemon，因此不声称验证真实容器管理。

## 本轮最终结果

2026-11-03，镜像原产物的 **19/19 生命周期检查通过**，没有失败或跳过。中心和目标源码均为 `3309b0b36490fb7eb8c7b4a4fa602ab1de75f974`，前一构建为 `5e42388b210146ad28edaeecc38390a5deea7f7e`。目标 ARM64 Agent archive SHA256 为 `089287cc4ba12bc96c824ae74bf44eeb785bfa73c52cbf0ac6cf7505f6c2363b`。

- [最终生命周期报告](evidence/linux-systemd-final.json)：保留旧构建、目标构建、原始摘要和每项观察；升级、回退、再次升级均核对签名 helper 的目标构建与新激活 ID。
- [Linux 权限专项输出](evidence/linux-security-final.tap)：镜像原包的绝对 `/etc` helper-check 通过；真实普通脚本身份检查 1/1、权限回归 13/13 通过，均无跳过。

探索报告不作为最终发行证据。完成后删除 QA 容器、临时镜像及测试源码输入 tar；发布共用的原始发行目录交由主发布流程清理，保留小型报告和该复现说明。
