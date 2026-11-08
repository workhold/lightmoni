# Implementation Plan: 私有镜像拉取凭据

**Branch**: `codex/111-registry-pull-credentials` | **Date**: 2026-11-08 | **Spec**: [spec.md](spec.md)

## Summary
中心管理独立加密仓库凭据，应用记录 registry_credential_ids。中心冻结无秘密授权元数据，拉取前通过已签名执行器与有效任务租约重新核对并临时解密。节点仅对授权镜像创建临时 Docker 配置，直接预拉取并以已验证本机镜像 ID 启动；不修改节点持久登录、daemon 或容器环境。

## Technical Context
TypeScript / Node 24.15.0；React / Ant Design；既有 SQLite、AES-256-GCM、Agent jobs/签名执行模块。测试采用 node:test、真实 HTTP 管理 API、Playwright 和隔离 Docker Registry。沿用仓库组件和发行脚本，无新增依赖。

## Constitution Check
主机授权与租约边界复用；密码仅私有载荷与0600临时文件；规格先于代码；保持当前数据；架构同步适用（凭据存储、中心到执行器私有载荷及镜像拉取路径）。仓库设计新增111章，Doca同节原生文字与流程图，保留原块并最新版本回读。

## Project Structure
- runtime/src/ops/registry-credentials.ts：独立加密仓库、脱敏CRUD、引用检查和任务授权。
- runtime/src/operations/registry-auth.ts：规范化地址/镜像匹配、临时认证拉取与清理。
- runtime/src/ops/store.ts、cluster-workloads.ts：冻结授权、领取复验和能力门槛。
- runtime/src/operations/image-sources.ts：每镜像选择认证路径并验证镜像ID。
- web/src/app/ops/RegistryCredentialsPanel.tsx、RegistryCredentialSelect.tsx：沿用镜像管理页和应用表单。
- runtime/test/registry-credentials.test.ts、registry-auth.test.ts；scripts/verify-registry-credentials.mjs。

## Delivery
完成相关检查后同步 origin/main、创建 GitHub PR并按用户授权合并。按既有可重现镜像发行流程从合并提交构建amd64/arm64，带两架构Agent包，固定标签20261108-registry-credentials-v1并回读摘要。只推送此次固定标签并保留latest；发行阶段尚未要求生产切换，后续追加授权见下。用户追加要求包含DNSPod默认线路修复PR149，合并两项后从同一main提交发行。

## 生产发布追加范围（2026-11-08）

用户在发行完成后明确要求发布线上。沿用已登录1Panel终端，先核对中心健康、原镜像和卷，生成root私有配置/环境/主密钥与SQLite一致性备份，校验完整性和权限。拉取已验收固定标签，核对revision与OCI索引摘要；只原子替换现有Compose中的中心镜像，保留项目名、配置、数据及其他容器。部署失败恢复原Compose与旧镜像，不恢复数据库。健康与公开入口通过后，在现有管理界面审阅并执行完整管理节点的Agent更新，维持授权和运行模式；仅监控且无SSH凭据节点不新增授权。回读凭据入口、Agent能力及DNS协调状态，不为了验收创建或删除生产应用。

此次发布不改变现有部署拓扑、凭据边界或协议，架构同步不适用；功能设计已在PR150完成仓库第111章与Doca seq1768同步。
