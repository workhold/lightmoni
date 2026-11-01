# 设计依据与取舍

- 官方安装文档：[Ubuntu](https://docs.docker.com/engine/install/ubuntu/) / [Debian](https://docs.docker.com/engine/install/debian/)，2026-11-01 查阅；使用签名 apt 软件源与 Engine/CLI/containerd.io/Compose 插件，不执行下载的远程安装脚本。已有冲突软件包时停止，不照搬官方卸载步骤。
- Agent 的 User=lightmoni-agent、NoNewPrivileges=true、ProtectSystem=strict 禁止直接执行系统安装。通过已有 SSH 受保护凭据和主机公钥校验执行固定安装流程，不增加 Agent 远程任意命令权限。
- 为避免安装 Engine 后仍卡在 socket 权限，安装对绑定身份及平台标准 unit 做核验，添加固定 SupplementaryGroups=docker drop-in 并重启 Agent；确认面板说明该影响。既有 Docker daemon 仅 enable/start，不主动重启。
- 应用旧错误 operation_dependency_unavailable 未指明具体命令，不能回推为确定未安装。仅 Docker 检查阶段提供检查/补装入口；新 Docker ENOENT 记录 docker_cli_missing。
- 后台 transient unit 独立于浏览器和 SSH 会话，平台保存幂等状态并在重启后转 unknown；只读核对不重新提交安装命令。
