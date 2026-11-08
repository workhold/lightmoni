# Tasks: 私有镜像拉取凭据

## Phase 1 - specification
- [x] T001 更新spec/plan/research/data-model/contracts/quickstart与UI说明；无扩展hooks。

## Phase 2 - foundation
- [x] T002 在runtime/test/registry-credentials.test.ts与registry-auth.test.ts建立凭据/授权/临时文件契约验收。
- [x] T003 实现runtime/src/ops/registry-credentials.ts的加密CRUD、脱敏投影、CAS、引用与撤销。

## Phase 3 - application pulls (US2)
- [x] T004 在cluster-workloads.ts/store.ts加入应用引用与队列/领取复验、旧Agent能力拒绝。
- [x] T005 在operations/registry-auth.ts和image-sources.ts实现按镜像临时认证、ID固定、取消与失败清理。

## Phase 4 - UI (US1/US3)
- [x] T006 新增RegistryCredentialsPanel/RegistryCredentialSelect，接入镜像管理和应用配置，提供明确诊断。
- [x] T007 运行scripts/verify-registry-credentials.mjs，检查保存读回/失败/刷新/绑定/撤销与实际截图。

## Phase 5 - acceptance/delivery
- [x] T008 真实隔离鉴权Registry验收与相关类型/回归检查，记录validation.md。
- [x] T009 更新docs/system-design.md第111章和Doca原生章节/图，最新版本回读核对。
- [x] T010 同步main、创建并合并GitHub PR，双架构Docker固定标签发布和摘要回读，保存发行证据。
- [x] T011 按追加授权完成生产受保护备份、中心及完整管理节点Agent更新，回读健康、配置与DNS状态，记录真实线上证据。

T001→T002→T003→T004→T005→T006→T007/T008→T009→T010；单工作树按依赖执行，独立只读研究另行回报。
