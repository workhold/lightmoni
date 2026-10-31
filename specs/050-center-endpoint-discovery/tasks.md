# Tasks: 中心内外网地址同步

## Setup
- [x] T001 完成specs/050-center-endpoint-discovery/spec.md及质量检查；同步origin/main并创建功能分支。
- [x] T002 完成specs/050-center-endpoint-discovery/plan.md、research.md、data-model.md、contracts/endpoints.md和quickstart.md。

## US1 管理与发现
- [x] T003 [US1] 在runtime/src/server/settings.ts及center-endpoints.ts实现scope、稳定中心身份与认证发现协议，增加runtime/test/center-endpoints.test.ts。
- [x] T004 [US1] 更新web/src/app/ReportingSettings.tsx和reporting-addresses.ts用途选择、运行中同步说明及接入引导；验证页面。

## US2 客户端统一选路
- [x] T005 [US2] 在sdk/typescript/src/endpoints.ts实现共享选择器并接入core.ts配置/上报和显式刷新，增加真实HTTP故障恢复测试。
- [x] T006 [US2] 在runtime/src/agent/agent.ts将心跳、配置、数据、任务长轮询、下载及持久通道统一入口并增加Agent验收。
- [x] T007 [US2] 实现sdk/go/endpoints.go、sdk/python/lightmoni/endpoints.py、sdk/rust/src/endpoints.rs及对应刷新操作、发送/配置选路与跨语言验收。

## US3 删除Agent中转
- [x] T008 [US3] 删除runtime/src/agent/agent.ts中的SDK接收与配置代理；更新测试证明404及自身采集仍正常。
- [x] T009 [US3] 清理sdk、examples、scripts、web/src/app/sdkExamples.ts中的Agent配置/默认地址/示例，更新当前指南和过时规格标记；runtime/src/assistant/instrumentation.ts与tool schema仅允许direct，停止生成Agent初始化代码并更新插桩验收。

## Validation and architecture
- [x] T010 更新docs/system-design.md与Doca同章节、原生图并回读，保存specs/050-center-endpoint-discovery/doca-readback.json。
- [x] T011 完成相关构建、类型检查、SDK/Runtime回归与页面验收，记录specs/050-center-endpoint-discovery/validation.md并审阅diff。

## Dependencies
T003后T004/T005；T005后T006；T007遵循同契约；T006后T008；T009/T010和最终验证收尾。研究代理已完成只读跨语言研究。MVP必须覆盖四种发布SDK和Agent全部中心通道，不能只交付单语言。
