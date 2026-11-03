# Implementation Plan: 自动部署与统一入口

**Branch**: `codex/091-deployment-autoconfiguration` | **Date**: 2026-11-03 | **Spec**: [spec.md](spec.md)

## Summary
修复受管任务入队被活动受管任务误阻塞；平台在已授权 DNS 区域内生成稳定入口，网站仅 CNAME；应用安装自动编排位置、端口、入口、证书与网站；仓库只发布5000；部署环境为后端 SDK 提供可覆盖默认值。

## Technical Context
TypeScript / Node.js 22+ 中心与受管执行，React19 / Ant Design Web，SQLite 管理状态和加密资源修订；各后端 SDK 保留原生语言。复用 DNS 所有权、ACME、系统应用身份、签名队列、Compose 配置文件和版本回执，无新外部运行依赖。相关 Node/SDK 测试与既有 Playwright 夹具验收，不对生产域名和机器作实验。

## Constitution Check
规格先于实现、宿主权威、秘密保护、可恢复和有界执行通过。管理员确认、版本检查、DNS所有权与真实未知结果栅栏保持。架构同步适用，仓库与Doca同一交付且成功回读；无宪法例外。设计后复核：上述边界继续满足。

## Project Structure
runtime/src/ops：自动入口、快速安装、SDK 环境和仓库。runtime/src/server：受管执行互斥与凭据/中心地址来源。runtime/src/operations：缓存路由。web/src/app/ops 与 PrivateRegistryPage.tsx：流程与状态。sdk：各后端环境默认，浏览器core保持显式配置。runtime/test 和本目录evidence：契约/视觉证据。

## Implementation Strategy
先修执行和DNS基础路径，再做快速安装。仓库/SDK为独立纵向增量。缺少托管区域、在线位置、有效证书或已同意条款ACME账号时在创建前明确拒绝。安装关联与阶段持久保存，证书由调和循环异步签发；保留高级覆盖。底层仅一个可写仓库与存储，删除独立缓存实例。

## 用户追加的发行范围
用户已要求打包、部署、发版并实测。功能 PR 经检查后合入 main，以固定 SHA 的 git archive 构建双架构镜像，实际成品检查后发布固定标签与 latest，再备份并仅更新生产中心镜像，执行真实发布、CNAME、仓库和 SDK 验证。若需更新 Agent 则走既有受管升级流程。用户业务数据与历史 unknown 审计保留。
