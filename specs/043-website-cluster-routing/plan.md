# Implementation Plan: 网站多集群入口与线路流量管理

**Branch**: codex/043-website-cluster-routing | **Date**: 2026-10-30 | **Spec**: [spec.md](spec.md)

## Summary
扩展042控制面：应用部署增加gateway_domain/gateway_dns_zone_id；全局OpenResty单例；网站routing_mode=manual/managed、service_application_id/service_port_name及独立cluster_policies。新网站dns_record_mode=cname，旧数据默认address保持兼容。中心根据已发布网站回执和新鲜入口健康生成CNAME，按线路/权重管理自有DNS记录。可选托管入口A/AAAA以OpenResty应用为owner统一刷新。

## Technical Context
Node >=22.19 / TypeScript，React19 / Ant Design，SQLite增量迁移，既有Agent配置/回执与授权边界。无新运行时依赖。测试使用node:test、HTTP/SQLite夹具和Playwright；本次要求针对性契约及集成回归，不冒称公网DNS或真实云套餐已验。权重1–100正整数，暂停独立enabled。DNS能力依赖阿里云/DNSPod域名套餐，实时查询厂商线路，拒绝不支持的高级规则，保持脱敏错误。

## Constitution Check
SDD先于代码；中心管理员、revision及confirmed不变；秘密只存后端加密配置；Agent未获得DNS凭据；旧数据不静默重写；DNS未知归属保留保护。架构同步适用：docs/system-design.md42.4–42.6及42.9和Doca同一PR记录回读。设计前后均通过，无原则豁免。

## Project Structure
- runtime/src/ops/cluster-workloads.ts：域名/策略校验、发现和健康驱动DNS、共享入口DNS。
- runtime/src/ops/cloud.ts,index.ts：线路查询、权重协议、DNS归属增量字段及按线路核对。
- web/src/app/OperationsPage.tsx,ops/*：网站主表优先；次要“OpenResty 管理”抽屉承载入口配置；应用编辑、网站模式与实际集群流量策略。
- runtime/test/platform-website-routing.test.ts,platform-clusters.test.ts：HTTP、持久化、调度和DNS回归。
- web/src/app/ops/verify-website-routing-ui.mjs：真实保存/刷新/失败/窄屏验证。

## Design Decisions
托管服务在网站层选择一次应用与命名HTTP端口；每个代理路径沿用公共选项，后端由当前集群的已发布应用端点解析。实际集群由所选服务deployments发现；已发布的托管网站后续自动跟随服务部署变化，冻结公共网站修订不变，新集群首次发布通过原有完整网关包和回执。手动模式维持逐路径逐集群代理能力。cluster_policies为即时流量策略，保存后仅影响DNS资格；不将草稿公共配置隐式发布。开启/关闭仍需站点有效回执，关闭立即撤下期望DNS。
入口域名由OpenResty部署配置直接读取，修改该域名无需重发网站配置。可选择外部维护或由指定托管zone维护本集群健康公网IP。网站CNAME只能引用入口域名，防止循环；旧address模式明确保留。DNS归属身份包含线路；权重更新同记录，TTL/权重/线路均读回验证。所有计划先预检可用线路及记录冲突，再修改自有记录，跨厂商不承诺原子提交。

## Delivery and Validation
先完成契约和核心集成测试，再后端与UI；SDD任务按依赖推进。UI沿用现有视觉，用真实SQLite夹具连续三轮保存、刷新和失败保留输入，查看桌面/390px/200%与动效证据并独立评审。同步双端设计并回读；相关回归和类型检查。当前分支基于042未合并提交，最终交付PR依赖其main合入状态，不能直接推main。
