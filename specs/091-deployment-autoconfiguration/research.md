# Research

## 执行互斥
Decision: 新受管作业可排到同主机活动受管作业之后，领取仍串行；手动提权、生命周期和未核对unknown继续栅栏，复用SDD089完整核对谓词。
Rationale: agent-jobs.enqueue 无条件 assertNoPrivilegedExecution 导致后台inspect期间发布在入队前409。不能靠删除所有栅栏解决。

## 稳定入口
Decision: edge-<集群ID稳定散列>.<托管scope>，优先已有选定区域，否则确定性选区域。入口地址只用机器管理公网服务地址与健康回执；网站仅CNAME。普通默认线路无加权需求时不要求付费DNS权重能力。
Rationale: 业务域名与入口IP解耦；不从SSH或来源观测猜公网IP。不引入第三方动态域名服务，缺少区域明确提示。

## 安装编排
Decision: 服务端自动选择在线且资源足够的位置；status.quick_install保存网站/证书/入口引用与阶段；最长域名后缀匹配区域，复用有效证书或已同意条款ACME账号，缺少账号给出先决条件。
Rationale: HTTP请求不等待证书；失败不重复创建应用，不自动同意CA条款。数据应用保持固定机器。

## 单端口仓库
Decision: 以用户最新澄清为准，只保留一个可写Distribution仓库、5000端口和一份持久数据，全局仅一个固定机器部署；旧多位置配置先迁移，删除hub_cache/origin_cache。已有镜像通过仓库端点与Docker本地镜像复用；不再提供独立pull-through缓存实例。用户需要额外仓库自行在应用商店部署。
Rationale: 不引入Nginx路由、来源协议和额外服务，不用分离仓库模拟一个仓库。

## SDK环境
Decision: LIGHTMONI_ENDPOINT、LIGHTMONI_KEY、LIGHTMONI_SERVICE、LIGHTMONI_MACHINE_NAME、LIGHTMONI_MACHINE_ID、LIGHTMONI_HOST_ID、LIGHTMONI_AGENT_ID、LIGHTMONI_APPLICATION_ID、LIGHTMONI_CLUSTER_ID、LIGHTMONI_INSTANCE_ID、LIGHTMONI_DEPLOYMENT_ID。程序显式配置与应用自定义环境优先。
Rationale: 复用SDK Key与中心地址，不把Agent控制凭据交给业务应用；秘密仅存加密配置和批准载荷。
