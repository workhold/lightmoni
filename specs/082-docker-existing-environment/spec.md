# Feature Specification: 已有 Docker 环境验证

**Feature Branch**: `codex/082-docker-existing-environment`
**Created**: 2026-11-02
**Status**: In progress
**Input**: Docker 环境安装也有问题。

## 问题与验收场景

实机为 CentOS 8，已有正常运行的 Docker Engine 26.1.3 和 Compose 2.27.0。当前安装器先拒绝 Ubuntu/Debian 以外的系统，没有验证已有组件。页面的“待检测”来自缺少独立执行器观测，不能据此认定主机缺少 Docker。

1. 已有完整 Engine/Compose 的 Linux amd64/arm64 systemd 主机，即使不在自动补装发行版范围，也应跳过软件包管理，仅启动/验证已有服务并保存真实结果。
2. 缺少 Engine 或 Compose 时，自动补装仍限 Ubuntu/Debian；其他发行版明确返回不支持，不配置软件源、不安装软件包。
3. 软件包冲突、daemon/Compose 验证失败、锁与未知结果继续按当前契约处理，不升级已有 Engine，不删除容器和数据。
4. 页面明确区分主机依赖验证和执行器访问验证；没有执行器有效观测时解释“待检测”，提供原有执行权限入口，不能自动授权或将 SSH 成功当成执行器就绪。
5. 安装器不授予普通 Agent Docker 权限，不重启 Agent 或已有 Docker daemon。

## 成功标准

- 执行真实固定 shell 的隔离回归覆盖 CentOS 完整组件成功、缺失组件拒绝、Compose 验证失败和已有 Ubuntu 环境跳过包管理。
- 当前 Docker API/互斥回归、类型检查、构建和中英文页面核验通过。
- 记录实机只读证据与验证限制；代码通过 GitHub 功能分支 PR 合入流程交付。
