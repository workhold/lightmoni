# Tasks: 网站多集群入口与线路流量管理

## Phase 1 Setup
- [x] T001 生成spec、需求检查、plan/research/data-model/contracts/quickstart及UI设计，位于specs/043-website-cluster-routing/。

## Phase 2 Foundation
- [x] T002 在runtime/test/platform-website-routing.test.ts增加契约与DNS归属/健康验证。
- [x] T003 在runtime/src/ops/cloud.ts,index.ts扩展线路能力查询、weight与归属增量迁移，防止不同线路混同。

## Phase 3 US1 调整部署与入口
独立验证：已有应用编辑、全局唯一OpenResty和双集群域名保存读回。
- [x] T004 [US1] 在runtime/src/ops/cluster-workloads.ts实现全局OpenResty单例、部署域名与托管zone验证。
- [x] T005 [US1] 在web/src/app/ops/ClusterFields.tsx及OperationsPage.tsx提供部署入口编辑和网站页OpenResty列表。

## Phase 4 US2 网站发现与流量控制
独立验证：托管自动发现、手动不同后端、策略保存读回。
- [x] T006 [US2] 在runtime/src/ops/cluster-workloads.ts实现managed服务发现、实际集群/独立策略和自动绑定生命周期。
- [x] T007 [US2] 在web/src/app/ops/WebsiteFields.tsx,NginxFields.tsx,model.ts及OperationsPage.tsx实现模式选择与实际集群策略。

## Phase 5 US3 两层DNS与故障回退
独立验证：南北默认1:1及省线路，南方失效撤下，恢复后重加。
- [x] T008 [US3] 在runtime/src/ops/cluster-workloads.ts实现CNAME线路权重和共享入口A/AAAA健康刷新，保留旧address兼容。
- [x] T009 [US3] 在web/src/app/ops/WebsiteFields.tsx展示厂商目录选择与DNS错误状态。

## Phase 6 Validation and documentation
- [x] T010 在web/src/app/ops/verify-website-routing-ui.mjs完成实际SQLite保存/刷新/失败/窄屏/200%及连续三轮验证，截图独立评审。
- [x] T011 更新docs/system-design.md42.4–42.6及42.9与Doca基线，保存并回读正文与原生图节点连线，在specs/043-website-cluster-routing/validation.md记录。
- [ ] T012 运行相关回归和runtime/web类型检查、同步origin/main与diff检查，在specs/043-website-cluster-routing/validation.md记录最终验证及限制，并推送GitHub功能分支创建面向main的草稿PR，不合并。

## Dependencies and implementation strategy
T001→T002→T003→US1→US2→US3→验证。MVP先完成US1再逐故事推进；共享cluster-workloads.ts顺序编辑，避免冲突。只读DNS研究按speckit-plan要求隔离派发；最终UI独立视觉评审按oil-ui要求派发。独立验证可并行运行，代码与审批保持顺序。不创建与本请求无关的服务或部署生产资源。
