# Implementation Plan: 应用商店扩展与 DBX

**Branch**: `codex/066-app-catalog-expansion` | **Date**: 2026-11-01 | **Spec**: [spec.md](spec.md)

## Summary

扩展 27 个安装模板，共 31 个。新模板按数据库/中间件/DevOps/AI/工具/网站与网关组织，工具仅 DBX。使用既有管理员安装 API、加密资源修订、Compose 执行与应用观测；引入有边界的模板参数元数据与构建器，负责类型/URL/端口验证和仅环境传递的秘密。复杂应用使用独立 named volumes、内部网络与显式依赖，初始化服务以已授权标签和退出码判断完成。

## Technical Context

- Language/Version: TypeScript / Node.js >=22.19；React 19。
- Primary Dependencies: 既有 YAML、React/Ant Design、Docker Compose；无新运行时依赖。
- Storage: 既有 SQLite 加密资源与修订；容器数据使用每安装项目独立的命名卷。
- Testing: node:test、现有 SQLite/HTTP fixture、Compose config、真实本地 Docker 冒烟和浏览器表单验收。
- Target Platform: Linux Agent；浏览器中英文、390px、1440px、深浅色。
- Project Type: 运维平台 catalog 与安装链路增量。
- Performance Goals: 31 个模板直接本地读取；列表不执行网络请求或拉镜像。
- Constraints: 不读取宿主 ambient 文件/环境，不增加 Docker socket 挂载；秘密只在受保护环境/加密快照中。
- Scale/Scope: 27 个新模板、6 类；旧 4 个模板保持 ID/API 兼容。

## Constitution Check

- Host authority: 安装沿用管理员确认、现有资源校验和 Agent 任务。
- Reviewable effects: catalog 仅列本地模板；本轮不部署用户主机或发布。
- SDD: spec、research、data-model、contracts、quickstart、tasks 在实现前生成。
- Operability: 固定镜像标签，数据项目隔离；无法真实验证的 GPU/重型项目明确记录。
- Architecture parity: 适用；参数元数据、模板构建职责、初始化就绪、第三方 AI 与存储拓扑变化同步 docs/system-design.md 与 Doca。
- 设计后复核：无宪章豁免；外部 AI 应用无 LightMoni 凭据/工具授权。

## Project Structure

- runtime/src/ops/catalog.ts: 兼容旧模板并注册扩展、统一分类。
- runtime/src/ops/catalog/: 模板类型、构建器、基础服务及复杂应用配方。
- runtime/src/operations/platform.ts: 一次性服务就绪与有界启动等待。
- web/src/app/ops/{model.ts,CatalogDrawer.tsx,CatalogInstallFields.tsx}: 元数据驱动分类、参数、说明与资源。
- runtime/test/application-catalog.test.ts、platform-clusters.test.ts: 安装契约/脱敏/回执集成。
- web/src/app/ops/verify-catalog-ui.mjs: 分类与表单浏览器验收。
- specs/066-app-catalog-expansion/: 完整 SDD 与验证证据。

## Complexity Tracking

无宪章违规。沿用既有 Compose 机制，避免新增市场同步服务、任意宿主脚本或特权部署通道。
