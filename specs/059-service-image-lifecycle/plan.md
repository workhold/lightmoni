# Implementation Plan: 服务镜像生命周期

**Branch**: `codex/059-service-image-lifecycle` | **Date**: 2026-10-31 | **Spec**: [spec.md](spec.md)
**Delivery**: 本PR只交付设计，下述为目标行为，功能尚未实现。

## Summary

在SDD042逐集群冻结发布与Agent模型上增加不可变镜像发布、候选预热/内网缓存、商店更新检查及主机镜像源。默认运行机+至少1台独立备用，不是全商店全节点下载；默认自动检查与提示，升级逐集群执行。复用并行SDD058安装进度的阶段展示，不重复建立日志体系。

根据用户对集群部署负担的反馈，默认不新增、也不要求配置共享仓库。基础路径为Agent从已有镜像源准备到候选本机；已有内网仓库仅作可选增强，可供多个集群复用，不自动每集群安装。自定义/商店升级不依赖可选缓存阶段。

## Technical Context

Node>=22.19/TypeScript、SQLite、React19/Ant Design、Linux Docker/Compose；复用加密资源/载荷、ops_platform_runs、job lease和系统日志outbox。按Agent能力协商。daemon配置自动应用首版限预检通过的Linux rootful Engine，rootless/Desktop/未知启动方式只显示状态与不支持原因。

## Constitution Check

符合SDD先行、宿主权限、秘密隔离、不可变载荷与真实回执。自动执行仅在管理员确认且可撤销的有限策略内；中心不新增Docker socket。发布、存储、凭据、分发及维护路径属于架构变化，同步仓库第59章与Doca同名章节，保留其他并行设计，证据见 [doca-sync.md](doca-sync.md)。

## Project Structure

- 现状：`runtime/src/ops/catalog.ts`为静态目录；`cluster-workloads.ts`负责逐集群revision和调度；`runtime/src/operations/platform.ts`渲染镜像引用并执行Compose up。
- 拟新增ops领域 `application-releases.ts`、`image-distribution.ts`、`registry-profiles.ts` 及对应store；逐集群部署挂接镜像与发布门禁。
- 拟新增Agent `operations/images.ts`、`docker-settings.ts`；平台执行器使用固定后的清单，不接受任意shell。
- 界面扩展 `OperationsPage.tsx`、`ops/*` 与主机Docker面板；契约/集成测试在 `runtime/test/`，真实证据在本SDD。

## 1. 不可变发布与旧版兼容

ApplicationRelease与应用草稿revision分离，冻结配置、模板revision、秘密引用和每个Compose服务的source_ref、OCI index/manifest digest、OS/arch/variant及平台manifest digest。ready后不可修改。digest是完整性标识，不替代来源授权。受限Agent解析网络manifest，中心校验授权与结果，同一来源引用冻结一次后分发给全部目标，不让各节点各自解析可变tag。

旧部署继续运行。新鲜inspect能证明完整运行镜像集合时生成legacy release；不能证明则legacy_unresolved，由管理员确认锁定方案，不能把当前远端tag冒充旧运行版本。任一Compose服务无法锁定，整套不能宣称ready/已预热。旧Agent不具能力时明确提示，不自动改变旧服务。

## 2. 候选预热与内网分发

先检查集群归属、在线、平台、CPU/内存、端口、持久数据、unknown和既有故障域约束，再按本机镜像就绪优化选择。managed默认standby=1，manual按需，可选all_eligible；备用是运行节点外的不同机器，按所需平台分别计算，所有服务镜像齐全才ready。不足显示degraded。预热不预留运行资源，接管前重新检查，故不等于容量保证。

路径：核验本机精确effective_ref@digest → 已配置时才使用授权内网缓存 → 按策略从已有镜像源拉取。未配置缓存直接跳过，不显示缓存故障、不阻止安装/预热/升级。默认允许正常准备阶段从镜像源下载，故障优先使用已预热本机；全部合格候选都缺失时允许下载就等待拉取，禁回源就waiting_image。Docker复用本地镜像层，平台不实现层引擎。预热与启动用同一effective_ref，核对image ID和平台digest，不用同tag存在判命中。准备后启动禁止意外按tag再次更新。

可选接入现有OCI registry/缓存，profile可配置有序端点，多集群可引用同一可信网络可达端点，保留逐应用/集群仓库权限。仅在镜像较大、重复下载多或公网受限且用户已有基础设施时启用；平台不负责每集群安装、维护或保证其高可用。启用时要求持久存储，避免只依赖应用运行节点。自建镜像可由外部CI推入，其他源经显式映射/受限复制，保持index/manifest/blob摘要，重写导致摘要变化即拒绝。普通机器Docker cache不直接当registry；真正P2P另行设计。

普通pull-through首次miss或tag检查可能回源。禁回源必须使用预填充内部固定digest路径，并限制缓存端回源，不能只设registry-mirrors声称离线。缓存不可用时仅按策略回源；本机已就绪仍可启动。托管缓存自身的引导镜像、数据持久性、认证和故障恢复另评估，不作为无状态应用直接空目录换机。

任务按machine/Agent、release、平台、image_set_hash与profile revision去重；默认每节点并发2、集群4，限制空间水位和带宽。成员、Agent、发布/策略变化触发重算，执行前复核，外部删除使ready失效。回执只保留白名单source/bytes/duration和身份。保护当前、上一可回退、运行和在途内容，只清理平台登记且无引用的过期镜像，核对现场运行容器；禁止全机docker system prune，unknown引用保留。

## 3. 版本更新

自定义路径：外部构建推送v2 → 登记镜像/Compose → 解析锁定 → 审阅差异 → 选集群 → 预热 → 升级。可选受控HTTPS发布清单或显式跟踪一个tag的digest变化；固定digest无源则显示未配置检查。清单提供版本排序/渠道/镜像/兼容信息，不靠仓库tag字典序猜新版本。

商店区分不可变模板revision和应用版本，保存变更、参数schema、兼容/数据迁移/回退声明及最低Agent能力。受信目录随平台版本发布或由管理员配置HTTPS源；抓取有大小、超时、目的地及凭据限制。默认每日带抖动检查，立即检查限流，失败显示check_failed与上次成功时间，不表示最新。

模板升级用旧模板/当前用户配置/新模板三方合并，保留用户参数、秘密引用、卷、端口和资源设置；字段删除、类型变化、冲突和未知迁移阻止ready。仅修改选定集群的release指针，保存当前及上一成功版本的镜像/配置。

默认notify只提示，可选manual停用检查。P2 automatic须管理员确认应用+集群、受信源、版本范围、维护窗口/IANA时区、批次、最大不可用及失败行为。派发和领取时重验授权revision，撤销阻断未开始动作。仅兼容声明明确、无状态且无迁移版本可自动执行；主版本、数据库、本地数据、模板冲突、能力不足、unknown及无兼容证明的tag漂移需人工处理。

滚动默认batch=1；有额外容量且固定端口无冲突才start-first，健康后切流再停旧。容量不足/单机固定端口/host80+443单例预览停机并显式stop-first。全部服务镜像匹配且健康回执新鲜才切换。失败默认暂停，已授权且兼容可回退时恢复上一发布；unknown先inspect，不重放。配置/镜像回退不回滚数据。

## 4. 机器镜像源与维护

全局→集群→单机逐字段解析：unset继承，显式空清空，数组整体覆盖；展示来源、期望/实际revision、最近验证和待维护。profile继承不扩大私有仓库权限，credential_ref另外受application/cluster、registry/repository和有效期约束。

分开Hub registry-mirrors、其他仓库source→endpoint/repository映射、daemon HTTP(S)_PROXY/NO_PROXY、私有认证/受信CA。镜像URL禁止userinfo，认证代理用secret_ref；默认TLS，不自动加入insecure registries。秘密只通过有效lease的私有载荷，在节点权限0600临时Docker config/受管文件使用，不进入命令行、日志或AI。

保存只改期望状态。应用顺序：探测Docker/启动参数/原文件/全部受影响容器 → 冻结文件hash、profile revision、机器/Agent及新鲜影响清单 → 管理员确认维护 → CAS/备份/合并受管键 → 能力支持的dockerd --validate → 原子写入 → 必要时重启 → Docker有效设置与容器状态验证。保留无关键，命令行同名参数/外部修改/未知启动方式拒绝；映射/认证未改daemon时不重启。

首版逐机维护不并发重启；主机级锁与部署/启停等Docker写动作互斥，维护标记避免调度误判换机。预检包括非平台容器，确认不授权过期或扩大的影响范围。中断/失败不报成功，unknown先核对；备份仍适用时恢复受管配置，再验证Docker及业务。配置恢复不等于业务恢复。

## 5. 阶段与验收

P1：固定发布身份、机器源与候选预热，以及自定义版本、商店检查/提示和手动逐集群升级，无需新增仓库即可验收。可选增强：已有内网仓库/源映射和禁回源，不作为P1依赖；P2：限定自动更新。真正P2P及平台自动安装高可用缓存另开SDD。

不承诺固定恢复秒数，实测检测、队列、镜像、启动、健康阶段，记录镜像大小、链路、命中和公网字节。DinD只能证明多个独立daemon，不冒称多台物理机器。验收见 [quickstart.md](quickstart.md) 与 [tasks.md](tasks.md)。
