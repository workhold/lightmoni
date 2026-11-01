# Docker 应用低端口预检修复

日期：2026-11-01。分支：`codex/070-docker-low-port-preflight`。

## 问题与验收

- xiangxiaojia 的 Docker 和 Agent 均运行正常，Agent 能执行 Docker 清单命令，80/443 没有监听者；OpenResty 仍以 `host_port_occupied` 失败。
- 实机 `net.ipv4.ip_unprivileged_port_start=1024`。使用 Agent 用户和发行包 Node 复现：80/443 返回 `EACCES`，18080/18443 可临时监听并立即释放。
- 普通用户无法绑定特权端口时，不应推断 Docker 无法发布该端口。低于 1024 的端口收到 `EACCES` 时继续既有 Docker 校验和启动步骤，由 Docker 负责最终的端口绑定检查。
- 真实 `EADDRINUSE` 继续在预检中拒绝；其他错误显示独立、静态的端口检查失败原因，不伪装为冲突，不输出系统错误原文。
- TCP/UDP、IPv4/IPv6 遵循相同分类；探测成功或失败后释放临时 socket。取消的操作不开始探测。
- OpenResty 在探测端口前报告 `checking_ports`，失败记录应指向真实阶段。
- 不修改机器权限、系统低端口阈值或已安装 Agent 文件。线上恢复需要发布修正版 Agent、升级目标机器并重新部署，代码检查通过不能替代该线上验收。

## 架构影响

不适用：修正现有 Agent 本地端口预检的异常分类和进度标记；Docker 仍通过既有受授权命令路径负责容器端口发布，Agent 用户、权限、socket、控制通道、存储和部署拓扑均不变。无需改写 `docs/system-design.md` 或 Doca 系统设计基线。
