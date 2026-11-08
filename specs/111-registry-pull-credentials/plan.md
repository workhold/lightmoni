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
完成相关检查后同步 origin/main、创建 GitHub PR并按用户授权合并。按既有可重现镜像发行流程从合并提交构建amd64/arm64，带两架构Agent包，固定标签20261108-registry-credentials-v1并回读摘要。只推送此次固定标签并保留latest；本次未要求生产切换。用户追加要求包含DNSPod默认线路修复PR149，合并两项后从同一main提交发行。
