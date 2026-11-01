# 验收记录

日期：2026-11-01。基线：`origin/main` 的 `290d41c`。

交付：[GitHub PR #58](https://github.com/workhold/lightmoni/pull/58)，目标 `main`，未合并、未发布。

## 用户指定机器的只读排查

通过 LightMoni 已认证的网页 SSH 终端连接用户指定的 CentOS 目标，核对系统主机名。未读取、导出或记录 SSH 密码、Agent 配置和运行时凭据。

- `systemctl is-active docker lightmoni-agent`：两个服务均为 `active`。
- root 和 `sudo -u lightmoni-agent docker --context default ps` 均成功；当前容器清单为空。
- `ss -ltnp '( sport = :80 or sport = :443 )'`：无监听记录。
- `sysctl net.ipv4.ip_unprivileged_port_start`：`1024`。
- systemd 服务用户/组为 `lightmoni-agent`，`AmbientCapabilities` 为空，`NoNewPrivileges=yes`。
- 使用发行包自带 Node、以 Agent 用户临时探测并立即释放：`80 EACCES`、`443 EACCES`、`18080 AVAILABLE`、`18443 AVAILABLE`。
- 页面确认 OpenResty v1 配置发布 80/443；最新失败回执为 `host_port_occupied`，进度停留在 `checking_docker`。源码确认此后执行的端口预检把所有 socket 错误统一抛为 `HOST_PORT_OCCUPIED`，Gateway 进入端口循环前未上报 `checking_ports`。

结论：Docker 已能被 Agent 访问。本次失败为 Agent 非 root 低端口探测返回 `EACCES` 被错误分类；检查时 80/443 均空闲。

## 自动化验证

均在独立工作树执行，依赖只读复用主工作区已有 `node_modules`，未安装或修改依赖。

```sh
cd runtime
node --import tsx --test --test-concurrency=1 test/host-ports.test.ts test/platform-executor.test.ts test/application-install.test.ts
```

71 项通过，0 失败、0 跳过。覆盖真实 TCP/UDP 冲突和释放、IPv4/IPv6 wildcard 与具体地址、低端口 `EACCES`、1023/1024 边界、高端口拒绝、`EADDRINUSE`、`EADDRNOTAVAIL`、`EPERM`、预先取消、中英文白名单诊断，以及 workload/OpenResty 跳过本地低端口探测后继续进入 Docker 校验且仍接受其失败结果。

```sh
npm --prefix runtime run typecheck
npm --prefix web run typecheck
npm --prefix runtime run build
git diff --check
```

全部通过。

## 真实 Linux socket 验证

构建后的实际 `operations/host-ports.js` 在本机隔离 Linux arm64 容器中运行，`node:24.15.0-bookworm-slim`，UID/GID 65534，移除全部 capabilities，网络隔离，`net.ipv4.ip_unprivileged_port_start=1024`，源码目录只读挂载。

可复现命令（仓库根目录执行，需先构建 runtime，使用本机已有镜像）：

```sh
docker run --rm --pull never --network none --cap-drop ALL \
  --user 65534:65534 --sysctl net.ipv4.ip_unprivileged_port_start=1024 \
  --mount "type=bind,src=$(pwd),dst=/work,readonly" \
  --entrypoint node node:24.15.0-bookworm-slim \
  /work/specs/070-docker-low-port-preflight/evidence/linux-low-port-probe.mjs
```

13 项真实 socket 检查全部通过，输出见 [linux-low-port.txt](evidence/linux-low-port.txt)。首次实测还发现具体 IPv6 UDP 地址错误选择 `udp4`，已按 IP 地址族选择 socket 并通过包含 `::1` 的最终验证。

## 架构与验收边界

架构同步：不适用。此变更只修正现有预检的错误处理与阶段记录，不改变组件职责、Docker 执行通道、权限、凭据、存储、协议或部署拓扑；未改写仓库系统设计或 Doca 在线设计基线。

线上诊断与隔离 Linux 修复验证是两组证据，不能合并声称线上部署成功。本次没有发布或替换 Agent，没有调整目标机的 capabilities、Docker socket 权限或 sysctl，也没有触发新的生产 OpenResty 部署。需要合并 PR、发布修复版 Agent、升级目标机器后重新部署，才能完成线上安装验收。未执行完整 OpenResty 容器安装/健康/网站回源验证。
