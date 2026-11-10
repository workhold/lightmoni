# Implementation Plan: 单机内存图显示总内存

**Branch**: `codex/119-host-memory-total` | **Date**: 2026-11-10 | **Spec**: [spec.md](spec.md)

在 `web/src/app/HostMonitoring.tsx` 读取当前 `host.capacity.memory_total_mb`。仅有效正数参与 MiB→GiB 转换，保留与现有摘要相同的一位小数。内存图标题中文为“内存 · 总内存 16.0 GiB”，英文为“Memory · 16.0 GiB total”；未知明确标识。不修改任何查询、图表类型、采集或刷新机制，标题自然跟随原 host 状态更新。

先规格/设计/契约/任务，再改代码。只需 web typecheck 和浏览器局部验证（已知/未知/切换机器/刷新、中英/主题/窄屏）；不为这次可逆文案展示增加实现镜像单测。架构影响不适用，理由见规格。
