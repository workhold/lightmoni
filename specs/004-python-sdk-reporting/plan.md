# Implementation Plan: Python SDK 远程上报控制
**Branch**: `004-python-sdk-reporting` | **Date**: 2026-10-14 | **Spec**: [spec.md](spec.md)

## Summary
复用中心/Agent 的 GET /v1/sdk-config 和现有规则结构。新增 Python 规则验证、稳定采样和独立配置轮询；所有记录路径在共享状态锁内完成决策。用可取消的标准库 HTTP 传输与 reporting generation 保护停报/恢复，维持冻结批次和已有失败语义。

## Technical Context
- **Language/Version**: Python 3.9+，不增加运行时第三方依赖。
- **Primary Dependencies**: 标准库 http.client、threading、json、decimal；现有 Go/TS 算法是契约参考。
- **Storage**: 本地规则/远程规则快照在内存；平台和 Agent 存储结构不变。
- **Testing**: unittest 真实本地 HTTP、跨语言固定向量、既有 scripts/test-sdks.py；隔离 Go 主服务/Agent 集成测试。
- **Target Platform/Type**: Python 库，直连中心或通过 Agent。
- **Performance Goals**: 业务记录不触网；停报唤醒正在退避或等待响应的 flush。
- **Constraints**: GET 总预算最多五秒、响应最多 1 MiB、禁止重定向；规则上限沿用平台；不可撤销已经在接收端提交的数据。
- **Scale/Scope**: 200 表策略、每表 32 保留/排除规则、每规则 8 条件、in 最多 256 值；原有 SDK 队列限额不变。

## Constitution Check
设计前后均 PASS：平台仍拥有认证和规则管理权；规格/契约/任务先于代码；凭证不出现在诊断；不引入 Doca 代码或新依赖；SDK 内存和确认边界不变。AI 专属原则本次不改变。原有 web/tsconfig.tsbuildinfo 保留。

## Project Structure
- specs/004-python-sdk-reporting/: spec、plan、research、data-model、contracts/reporting.md、quickstart、tasks、verification、requirements checklist。
- sdk/python/lightmoni/sampling.py: 严格快照验证、匹配、哈希。
- sdk/python/lightmoni/transport.py: 可取消、有截止时间的 HTTP 交换。
- sdk/python/lightmoni/__init__.py: 公共配置 API、轮询、记录筛选、停报 generation、自监控与 flush。
- sdk/python/tests/test_reporting.py: 规则/真实 HTTP/并发生命周期验收。
- internal/server/python_reporting_test.go: 隔离 SQLite 中心配置 + Python + Agent 转发集成。
- sdk/go/python_sampling_test.go: 直接比对 Python 与 Go 的规则决策固定向量。
- sdk/python/README.md、sdk/README.md、docs/tasks/04-sdk.md: 新 API 和实际线程语义。
- web/src/app/LogReportingSettings.tsx: 支持范围文字包含 Python，管理交互不变。

## Execution
先建立测试并确认新契约未实现；实现纯规则和可取消传输后接入客户端；并行编写独立的中心/Agent 集成测试。完成针对性回归、安装包校验和独立审阅后更新验证证据。前端仅修改支持范围提示，不重启用户正在运行的服务。
