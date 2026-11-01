# Implementation Plan: 应用 Logo 与 YAML 配置

**Branch**: codex/068-application-logos | **Date**: 2026-11-01 | **Spec**: spec.md

## Summary

31 个品牌素材随 Vite 网页打包，共享 ApplicationLogo 用于商店、已安装和详情。图片优先用户上传，其次模板品牌，最后通用图标。自定义应用创建时可提交 Logo 并与资源事务保存；已有应用通过独立 Logo 编辑入口更换，采用独立并发版本，不触发配置修订或 Agent 任务。

## Technical Context

TypeScript / Node >=22.19 / React 19，沿用现有 Router、管理员权限、SQLite 事务和 UI 组件；Logo 无新增依赖，YAML 网页使用与运行时一致的固定 yaml 2.9.1。浏览器支持 PNG/JPEG/WebP、原图上限 5 MiB，解码后等比缩至 256px PNG；中心仅接受 256 KiB 内、512px 内的完整合法非交错 RGB/RGBA PNG，并验证块 CRC、尺寸、解压边界与过滤字节。私有读取端点输出固定 image/png、nosniff、沙箱 CSP、私有缓存及内容 ETag；不接受远端 URL 或用户 SVG。

## Constitution Check

host 管理员拥有读写权；Logo 不进入 Agent/AI 工具和部署修订；事务保存与版本冲突可回读；真实图片、HTTP/SQLite 和浏览器证据；新表随既有中心数据备份。架构适用，同步 system-design 与 Doca，保留原生图。设计后复核无豁免。

## Project Structure

- web/src/assets/application-logos/: 31 项品牌图形、来源和许可说明。
- web/src/app/ops/ApplicationLogo.tsx、ApplicationLogoUpload.tsx、ApplicationLogoEditor.tsx: 共用显示、浏览器归一化与独立编辑。
- CatalogDrawer、InstalledApplications、OperationsPage、model 和 operations.css: 集成。
- runtime/src/ops/application-logos.ts: 有界 PNG 验证与规范化。
- runtime/src/ops/store.ts、index.ts、types.ts: 独立 SQLite 元数据、原子创建、权限读写与清理。
- runtime/test/application-logos.test.ts、platform-clusters.test.ts 与浏览器 verify-application-logos.mjs: 负例、并发、持久化、权限和完整 UI 流程。

## Complexity Tracking

不新增对象存储、全局上传服务、外链代理、运行时图像依赖或 Agent 能力。独立小表避免图片进入所有应用配置、加密修订和派发任务；无 Logo 的旧记录保持兼容。

## YAML 增量设计

用户追加 YAML 要求后先更新此设计。Web 使用与 runtime 相同固定版 yaml@2.9.1。Compose 以 YAML stringify 展示；不额外持久化未脱敏原文，保存后从规范化对象输出 YAML。单容器高级文档为 services.app，反解受支持字段并保留原程序类型、平台挂载与配置；不自动把单容器变成 Compose。多服务选择 Docker Compose。

configuration_mode=yaml 声明 YAML 为配置来源；container 使用 configuration_yaml，compose 使用 compose。中心先解析和规范化，再恢复已有环境占位，最后检查资源与端口。高级文档 services.*.ports 是发布意图，expose 保持内部。托管忽略 published，保留旧/表单监听范围并分配宿主端口；手动取 YAML published。按 service/target/protocol 保持旧端口名称和应用协议，新端口稳定命名；删除引用端口沿用既有拒绝机制。普通表单和商店默认不改变优先级。
