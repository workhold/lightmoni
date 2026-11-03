# SDD087 本机发行记录

日期：2026-11-03。构建、Linux 验收、上传均在用户本机执行，没有使用 vchive 或 GitHub Actions 构建，没有升级生产平台。

## 镜像与源码

- 镜像：`docker.heyphp.com/lightmoni/lightmoni:latest`。
- 固定标签：`docker.heyphp.com/lightmoni/lightmoni:20261103-agent-unified-3309b0b36490`。
- 两标签的双架构 index：`sha256:3e63c1dc87501afeda506f5cf1cd613e076b38ec8bb4b2a7e19e2cfa14d75eab`。
- 源码：`3309b0b36490fb7eb8c7b4a4fa602ab1de75f974`，功能分支 `feat/087-agent-permission-boundaries`，GitHub [PR #83](https://github.com/workhold/lightmoni/pull/83)。该发行包含尚未合入 main 的功能代码；之后的验收文档提交不改变该构建身份。

| 平台 | 镜像 manifest |
| --- | --- |
| linux/amd64 | `sha256:95e448273abe056b708c7664a0a17f4d0ffa63cca9a69c86b116e9c01f804531` |
| linux/arm64 | `sha256:a050f5103dbb32f67702fd0b8c199029d1ce6c24b4a2f04332b4a452c22c9f3c` |

两个架构的 Agent 包使用同一构建身份 `0.1.0-3309b0b36490-5382f0e4da8d`。每个中心镜像独立生成发行包，打包时间使压缩包摘要可不同；各自的清单、下载内容、源码与编译模块均已核对。

## 验证与远端确认

- Runtime 1341 项：1308 通过、0 失败、33 环境跳过；跳过名称保存在 [机器可读记录](evidence/release-runtime-validation.json)。
- 最终镜像原始 Agent 包完成 19/19 Linux/systemd 真实生命周期检查；权限专项 14/14、无跳过。详见 [Linux 复现与边界](linux-validation.md)。
- amd64 和 arm64 中心成品各 8 项检查全部通过：真实隔离 ClickHouse、管理员初始化与登录、主机/任务接口、前端资源、双架构 Agent 原始包及对应平台启动入口、四语言 SDK 和 AI 模块加载。[amd64](evidence/release-smoke-amd64.json) / [arm64](evidence/release-smoke-arm64.json)。
- 构建只使用固定 Git archive 快照。两个 Node 基础镜像固定官方摘要；官方校验 Linux Node 缓存后，通过记录了唯一 COPY/ENV 差异的 Dockerfile 派生文件构建。npm 镜像源超时后改用官方 npm registry，源码和依赖锁未变。
- 先上传固定标签，独立 HTTPS GET 完整回读每个 manifest、config 和所有 layer，核对大小与 SHA256 后再提升 latest。首次回读超时没有更改 latest；后续完整重读通过后提升，重新核对 latest index 和两个平台配置。
- 保留旧固定标签 `20261103-1bfd49c` 及原 index `sha256:0991b9bb0cf29369406971d844435563f9f7b44c10cb531b9edbea7b5b533eb2`。

发布证据：[release-published.json](evidence/release-published.json)、[完整远端回读](evidence/release-registry-readback.json)、[源码快照](evidence/release-source-snapshot.json)、[实际构建元数据审查](evidence/release-metadata-normalization-review.json)。

## 本地清理

发布完成后定向删除本轮镜像、专用 builder 缓存、源码快照、OCI blob、临时 Agent 包与 Node 缓存副本，保留小型证据、源码工作树、共享官方 Node 缓存、原有镜像、正在运行的平台和数据库。[清理记录](evidence/release-cleanup.json) 为 passed：本轮镜像标签及 ID 均无本地引用、builder cache 为 0B，额外回收约 15.29 GiB 可用空间。原有平台与 ClickHouse HTTP 健康检查均为 200，运行中的 Docker ClickHouse 保持 healthy。

## 设计与使用边界

本轮补齐现有权限与生命周期约束，没有新增组件、权限或控制通道，架构影响不适用。架构基线与 Doca 同步证据继续见 [validation.md](validation.md)。

Linux 生命周期使用本地登录适配器执行原 SSH 固定命令，不覆盖真实 SSH 网络认证；未对真实 Docker daemon 操作。双架构成品测试在本机 Linux VM 中运行，amd64 使用已注册的架构仿真。旧 root 常驻安装需要先按原受管流程卸载后重装；本发行不接管未知旧安装。
