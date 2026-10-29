# Research

- Decision: 集群成员使用稳定主机ID；现有agents.group_id保持采集标签语义。Rationale: Agent重装不改变机器归属。Alternative: 直接复用Agent分组会混淆两种边界。
- Decision: 合并service策略到application，复用workload executor。Rationale: executor已支持容器/Compose多端口，原service控制面却覆盖成单端口。Alternative: 增加独立service/gateway资源已被用户否决。
- Decision: 唯一约束物化到SQLite事务索引。Rationale: 加密spec遍历不能保证并发一机一集群和全局serviceName；现有UNIQUE(kind,name)阻碍同展示名多套应用。
- Decision: OpenResty仍为Linux host网络80/443，多机完整同版本包，owner为应用。Rationale: 符合用户固定入口拓扑且复用已验证执行器。Alternative: overlay/额外网关组增加概念。
- Decision: 内置受控商店模板与自定义镜像/Compose首版落地；Demo提供源码Dockerfile。Rationale: 覆盖用户程序部署，不把中心变成未经界定的构建服务。
- Decision: 真实Demo在一次性Linux Docker CLI+Node环境执行，浏览器用转发端口与测试域。Rationale: 本机Docker可用，但macOS Node不能验证VM host网络。MySQL配置healthcheck并等待初始化。
- Source: 只读研究Agent审阅store/index/workloads/platform与现有033验证记录；Docker官方卷说明 https://docs.docker.com/engine/storage/volumes/；1Panel安装体验 https://docs.fit2cloud.com/1panel/user_manual/appstore/openresty/。

## 最终跨集群决策
- Decision: serviceName属于全局逻辑应用，发布和实例带cluster维度，分别冻结授权修订，避免一处部署升级其他地域。
- Decision: 网站只允许上游按集群设置，其他配置一份；targets嵌在共享location下，避免复制公共超时/HTTPS。
- Decision: OpenResty host80/443可managed，候选必须满足端口；DNS由网站统一聚合全部集群，防止各集群互删。
