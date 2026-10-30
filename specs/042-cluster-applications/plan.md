# Implementation Plan: 集群与应用统一部署

**Branch**: codex/042-cluster-applications | **Date**: 2026-10-29 | **Spec**: [spec.md](spec.md)

## Summary
重构现有033控制面：cluster稳定主机唯一归属；全局application包含manual/managed策略、不可变service_name、多命名端口、OpenResty角色和逐集群deployments。全局网站统一公共配置，只有上游按集群设置，引用该集群唯一OpenResty部署和同集群应用端口。删除独立service/gateway_group用户入口。DNS/证书继续中心共享。内置商店复用普通应用创建/发布，提供MySQL与OpenResty以及自定义程序Demo。

## Technical Context
TypeScript / Node >=22.19；SQLite事务与加密spec，React19/Ant Design，Linux Docker/Compose，现有Agent pull job/control lease。中心不接Docker socket；仅隔离QA执行环境为测试Agent挂载socket。端口使用机器可达IP+发布端口，不引入overlay/DNS服务。serviceName+cluster_id+port_name作为平台发现键，网站编译成实际upstream。

## Constitution Check
通过：SDD先于应用改动；管理员与版本授权保持；Agent身份/租约与秘密边界保持；真实回执驱动状态。展示名取消应用唯一限制，数据库持久唯一索引保证serviceName、OpenResty和机器归属。演示不修改生产资源。设计同步在本SDD和交付PR完成；写入后回读原生图与文字。不存在需豁免的原则。

## Project Structure
- runtime/src/ops/types.ts, store.ts, index.ts：资源类型、事务索引、catalog与集群过滤API。
- runtime/src/ops/cluster-workloads.ts：cluster/application/website验证、逐集群实例/端口、调度、发现、OpenResty与DNS；workloads.ts仅保留旧模型历史路径。
- runtime/src/ops/catalog.ts：版本化内置模板、参数校验与安装。
- runtime/src/operations/platform.ts, nginx.ts：复用多端口Docker/Compose和OpenResty执行，保留秘密安全边界。
- web/src/app/OperationsPage.tsx, ops/*, App.tsx, navigation.ts：集群、应用、网站、独立域名/证书，快捷创建与实际映射。
- runtime/test/platform-*.test.ts：领域/HTTP/SQLite/租约和失败边界。
- examples/cluster-demo/*：自定义程序源码、Dockerfile、数据库与网站实测脚本。

## Design Decisions
稳定 managed_machines.id 保存集群成员，Agent替换只改变可执行身份。app.name是可重复展示名；service_name数据库唯一且创建后不可改；OpenResty部署按cluster_id唯一。deployments逐集群配置机器或副本数、CPU/内存；部署分别冻结application_revision和cluster_revision，保存草稿不改变线上期望，发布一个集群不隐式升级其他集群。手动模式只巡检不补副本；托管保持期望副本及健康发现，只对明确无本地持久状态应用自动跨机替换。原节点未知端口保留，重连清理旧attempt。
每实例命名端口整体事务预留，实际Agent复核，全部映射完成后按配置探活；配置更新/重启保持稳定分配。OpenResty使用application作为owner，内部gateway.*任务名允许复用，80/443固定且支持托管换机。网站bindings支持每组域名独立证书/DNS和多路径；locations.cluster_targets仅保存各集群上游，其他配置全部公共。完整配置按集群编译下发，只有通过HTTP/TLS验证的入口加入网站DNS聚合，保留其他集群和非平台记录。
旧数据不静默删除。旧模型作为历史保留或显式转换；任何冲突暂停自动执行并报告。首版不构建自动源码CI，Demo在独立构建步骤生成自定义镜像。

## Delivery and Validation
先契约与核心测试，再后端/前端可独立并行；真实Linux Docker环境通过HTTP/Agent lease执行三套应用，验证MySQL写入与Web重建持久性、多端口路由与TLS。UI从实际入口保存、刷新、失败、窄屏和200%取证；复用验证脚本连续三轮。最终双端设计回读、相关回归、类型与构建、同步origin/main，通过功能分支GitHub PR交付，不合并。

单cluster数据原位规范化为deployments单项，资源、实例、数据目录和容器保持；相关约束与接口以contracts/data-model为准。
