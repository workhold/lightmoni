# 私有镜像巡检、Gitea 端口与卸载显示

ABC 新实例 8cf688b32d63a901a8b4984a451735f 的 apply b7fc4a06c07f70d6520d410ac34516a2 成功，但 inspect ae15dfb2ce4637966461ea789f60a14a 被 approval_invalid: private_registry_cache_policy_changed 取消。全局对账按字段排序冻结策略，与预期对象字段创建顺序不同。复用 desiredJSON 比较完整 JSON 值，真实策略变化继续拒绝。

Gitea 实际资源 2bc55c4b89cda669709bad3fceac2a7b，v1，预算 1 CPU /1024 MiB，旧默认 SSH 22→22。集群预算 2 CPU /2048 MiB；当前 Registry .25/256、OpenResty .25/128、DBX .5/512、ABC .25/128，共1.25 CPU /1024 MiB，剩余 .75 CPU，无法容纳 Gitea。新安装默认2222→22，环境克隆端口同步；容量门禁保留。Gitea 官方文档同样使用独立宿主 SSH 端口：https://docs.gitea.com/installation/install-with-docker/ 。已有资源不自动改写，实际配置经正常编辑后再部署。

SDK 环境验收容器正常移除后，成功 inspect containers=[] 却把 removed 改回 stopped 并累加健康失败。修正成功且明确无容器的移除状态投影；停止容器不等于移除，失败/未知巡检不算移除成功。

源码回归 application-catalog、platform-clusters、managed-executor-jobs 共90项通过、零跳过：规范化加密策略载荷和6种真实变化拒绝；Gitea默认/显式覆盖/0拒绝；移除、停止、运行缺失、失败及未知回执。runtime typecheck/build、web build通过。架构影响不适用：比较、默认值和状态投影修正，既有权限、执行、存储和协议不变。设计保持本地，不同步 Doca。

上个7061fd镜像生产回读 healthy，index 1c0308906b9e4bb32908b890139ca8903fd20c9d4779cf470a6adba1abe8d6e2，原 lightmoni_lightmoni-state-v2-20261103:/data 保持。新修复的固定发行与生产实际复测待完成。
