# 私有镜像巡检、Gitea 端口与卸载显示

ABC 新实例 8cf688b32d63a901a89b4984a451735f 的 apply b7fc4a06c07f70d6520d410ac34516a2 成功，但 inspect ae15dfb2ce4637966461ea789f60a14a 被 approval_invalid: private_registry_cache_policy_changed 取消。全局对账按字段排序冻结策略，与预期对象字段创建顺序不同。复用 desiredJSON 比较完整 JSON 值，真实策略变化继续拒绝。

Gitea 实际资源 2bc55c4b89cad669709bad3fceac2a7b，v1，预算 1 CPU /1024 MiB，旧默认 SSH 22→22。集群预算 2 CPU /2048 MiB；当前 Registry .25/256、OpenResty .25/128、DBX .5/512、ABC .25/128，共1.25 CPU /1024 MiB，剩余 .75 CPU，无法容纳 Gitea。新安装默认2222→22，环境克隆端口同步；容量门禁保留。Gitea 官方文档同样使用独立宿主 SSH 端口：https://docs.gitea.com/installation/install-with-docker/ 。已有资源不自动改写，实际配置经正常编辑后再部署。

SDK 环境验收容器正常移除后，成功 inspect containers=[] 却把 removed 改回 stopped 并累加健康失败。修正成功且明确无容器的移除状态投影；停止容器不等于移除，失败/未知巡检不算移除成功。

源码回归 application-catalog、platform-clusters、managed-executor-jobs 共90项通过、零跳过：规范化加密策略载荷和6种真实变化拒绝；Gitea默认/显式覆盖/0拒绝；移除、停止、运行缺失、失败及未知回执。runtime typecheck/build、web build通过。架构影响不适用：比较、默认值和状态投影修正，既有权限、执行、存储和协议不变。设计保持本地，不同步 Doca。

上个7061fd镜像生产回读 healthy，index 1c0308906b9e4bb32908b890139ca8903fd20c9d4779cf470a6adba1abe8d6e2，原 lightmoni_lightmoni-state-v2-20261103:/data 保持。新修复的固定发行与生产实际复测待完成。

## 实际生产回执

4dd3752 镜像经1Panel于11月7日00:21:17就绪，实际回读源码修订及 index 021ac562c1a694c96a6b175cd9f2022a9de6e53d1e3dc8683c406bb22bb9e429、healthy和原数据卷。SDK验收实例6a00a7a456c647204057a7d594f908b1已稳定为removed，health_failures=0，页面显示已卸载。

Gitea 经正常YAML编辑为v2，SSH_PORT与published均2222，其余脱敏环境原样保留。ABC正常停止释放配额后，780734f1e2f72a342bb0f7df2cd1f461于01:33:44部署成功；重试域名配置后HTTPS就绪。外部首页与/api/healthz均200，ssl_verify_result=0；install-091入口200、Registry /v2/401且TLS均正常。

Gitea新实例454a1339955690ed9d569ae9cf6f8185在18:05:42Z至18:16:06Z连续8次inspect均healthy=true、configuration_matches=true，容器132d0dc703e0a042a2a536cd9a5e38a813fb389b7059974d479a7cc2dc516f26保持同一。之后正常停止用于释放ABC验收配额，数据保留，最终需恢复运行。停止本身成功，但页面显示11月5日旧last_error，修复另见T026。

ABC巡检开始执行后发现第二个误报：manifest.command=[]而Docker Cmd=[node,server.mjs]。实际镜像、CPU、内存、环境和端口一致；单容器空列表继承镜像默认值的修复PR122已合入。此时仍不把ABC判为通过，需新Agent实际复测。

18:13:04Z第三轮内部运行查询：中心heartbeat与heap各17个新样本，最新18:12:51Z；zz-bj-1 Agent heartbeat 6个，最新18:12:40Z。Registry/Gitea/DBX/OpenResty每服务81个容器gauge样本、机器名zz-bj-1，最新18:12:48Z；主机zz-bj-1 192个样本最新18:12:59Z。SDK一次性环境探针日志实际为log_sdd091live，13:14:34Z，service=sdd091-sdk-environment、显式host=sdd091-explicit-host；该探针不生成连续心跳，连续业务SDK验收另使用ABC。

## 最终恢复结果

PR122镜像默认命令修复、PR124旧错误提示清理和PR126网站日志身份修复均已合入并包含在最终573b644发行。新Agent下ABC启动成功，连续5次巡检健康且配置一致、同一容器；实际切换v4镜像再恢复带SDK的v5均成功，最后21:21–21:24Z有9个gauge、18条新日志，来源abc-demo/zz-bj-1。21:33:27.493Z正常卸载容器成功，保留原数据与登记，最终removed、health_failures=0。

Gitea最终通过正常apply 9a793410637f94cb67db8f2884874501于2026-11-06T21:40:19.718Z成功恢复，卡片为运行中，原容量错误清除；仍为1 CPU/1024 MiB、SSH 2222→22及SSH_PORT=2222，原数据保留。首页和/api/healthz正常DNS/TLS返回200，网站QPS/耗时及三轮真实访问日志归属正确。最终中心与zz Agent均更新到573b644；00:43:13Z回查Gitea、DBX、Registry、OpenResty运行正常，未结束unknown作业和观测积压均0。详细时间、发行与验收见live-matrix.md、website-identity.md。以上早期“待完成”记录保留诊断过程，最终结论以本节和最终矩阵为准。
