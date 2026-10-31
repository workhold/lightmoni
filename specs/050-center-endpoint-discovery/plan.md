# Implementation Plan: 中心内外网地址同步

**Branch**: codex/050-center-endpoint-discovery | **Date**: 2026-10-31 | **Spec**: [spec.md](spec.md)

## Summary
沿用管理员上报地址簿，为地址增加scope=internal/public。新增独立中心地址发现与无凭据身份探测，SDK/Agent显式公网引导，内网优先；地址变更从公网引导恢复。移除SDK→Agent公开接收/配置代理，保留Agent进程内采集队列。同集群Nginx约定内网完全互通，不增加公网后端。

## Technical Context
Node/TypeScript中心与Agent、React管理页、四种发布SDK Go/Node/Python/Rust；无新依赖，SQLite instance_settings保存地址及中心稳定ID。HTTP身份/发现响应64KiB上限，30秒缓存/刷新、1秒候选探测；限制整体探测时间。后台/显式刷新及发送前过期刷新确保停报或禁用采样同步时仍可恢复地址。测试使用共享中心的隔离HTTP入口、断链、地址替换及凭据捕获；不冒称真实公网/VPC验收。

## Constitution Check
设计前/后均通过：先规格后代码；管理员唯一写入、SDK/Agent各用原凭据；不向探测入口或跨中心发送秘密；原批次重试与持久队列不变。架构影响适用，更新docs/system-design.md第3/4/6/7/10/11/12节及新增50章并同步Doca原生图/正文回读。AGENTS要求的GitHub功能分支已创建；不直接推main。

## Project Structure
runtime/src/server/settings.ts和新center-endpoints.ts：管理员地址簿、发现协议。
sdk/typescript/src/endpoints.ts：共享选择器；Agent全部中心请求（含任务、下载、心跳/配置、任何持久通道重连）共用选择状态。
sdk/go/endpoints.go、sdk/python/lightmoni/endpoints.py、sdk/rust/src/endpoints.rs：同契约选择器。
web/src/app/ReportingSettings.tsx：用途及更新行为；接入示例为中心公网引导。
runtime/src/agent/agent.ts：移除公网SDK接收及配置代理，保留本地health/status。

## Compatibility and lifecycle
旧地址无scope视为public；旧中心404发现接口时保留单地址。新SDK不再默认4318；必须设置中心URL。Agent旧SDK接口返回404。原local_token仅用于本地诊断，不用于SDK。持久通道使用当前中心入口建立，故障/新修订后重连；Agent现有任务长轮询与artifact下载同样共用选择器。用户业务POST不在同次调用内重发，下一次原批次重试可更换入口，同中心SQLite去重。公网地址保持引导，运行期间可选从当前已验证入口查询，旧入口失效时回到引导查询。
