# 私有镜像管理首版实施基线

2026-11-01。用户已授权实现首版。本文件与当前tasks.md定义实施范围；此前完整生命周期设计的后续发布版本/自动更新/预热策略路线保留在roadmap-tasks.md，不能把未实现路线标为完成。

## 产品模型

- 新增独立“私有镜像”管理页，对齐网站入口的空状态：未安装提示安装仓库；确认选择集群、明确机器、内网监听IP、资源与数据位置后创建部署。
- 系统仓库是一份全局普通application，固定service_name=sys-docker-registry，可在多个集群各配置一台机器。系统只使用此模块经宿主受控创建并登记的应用；业务可在每集群安装任意数量普通Registry，不按镜像名或用户提供标记自动接管。
- 网站全局OpenResty固定sys-openresty；sys-前缀由后端保留。已有OpenResty按稳定应用ID迁移展示服务名，保留实例、卷、发布和历史版本，记录旧别名，既有引用通过稳定应用ID继续有效；普通应用不能伪造系统角色/标记。
- cluster.spec.image_cache.enabled是唯一缓存开关来源。集群编辑与私有镜像部署行调用同一业务函数，未部署系统仓库时开启返回安装引导。修改后更新/发布对应系统仓库的冻结部署配置；普通应用下次拉取才使用缓存，不隐式重启现有业务。
- 系统仓库每集群有私库服务；缓存开启时另启Docker Hub缓存和必要的主私库缓存，分别使用端口和持久目录。多仓库实例不共享可写存储。
- 对外载体选择系统仓库的一个集群部署。模块自动创建/关联一个普通website，域名固定绑定该集群；填写域名、证书、账号密码，必要时确认安装/扩展本集群sys-openresty。其他集群从所选源直拉或缓存同一镜像，独立私库不自动复制。首版禁止已配置写入源静默换集群/机器，避免空库替换；迁移作为后续能力。

## 控制与安全

宿主内部createSystemApplication能力及ops_system_applications登记表证明系统身份；HTTP普通资源接口不接受此授权上下文。固定名称与角色在创建/修改/恢复时校验。只允许管理员变更，全部保存revision/actor；异常、部分已保存或排队都不冒称部署成功。

仓库默认manual单机、持久数据；监听明确私网/ULA/loopback地址，拒绝通配与公网地址。用户确认该内网仅可信机器可达；来源隔离依赖实际网络/防火墙，不能把私网地址直接宣称为完整隔离证明。内部免登录不提供同网用户隔离。公网通过HTTPS+网站Basic，受管网站不能关闭鉴权或转到其他集群；不默认发布裸后端公网端口。不隐式修改安全组或全局insecure-registry配置。

Agent为已登记系统端点执行受限Registry V2读取，校验manifest/index和blob摘要，生成受限Docker导入归档并导入本机，再核对平台、rootfs及Docker image ID（兼容经典/containerd存储）。只接受当前集群登记的私有字面IP与端口，不跟随重定向；字节/时间/磁盘有界，取消/失败清理临时文件。镜像层由Docker加载和执行，平台不实现层运行引擎。Docker Hub及指定系统源按明确映射选择缓存；未知业务仓库保持原路径，系统仓库/网关引导镜像不依赖自身。缓存失效默认按策略回源并记录；禁止Agent回源时失败而不偷走公网；pull-through服务自身仍可访问其上游，不等于集群完全断网策略。

网站Basic采用现有bcryptjs，在中心生成并加密保存口令hash，密码只写，空密码仅保留同名用户已有hash。网站全站auth与路径inherit/off/basic，结构化编译生成受管htpasswd文件，与配置一起校验切换；路径、头、CORS/return、缓存及自定义片段不能覆盖鉴权，不支持组合拒绝。公网只TLS；Basic验证后的Authorization不发上游，匿名401不作为网站不健康。旧网站默认关闭；旧Agent无法识别的新鉴权载荷拒绝而非忽略。

## 接口

镜像使用规则：源集群引用自身发布域名时，通过登记私库直拉，关闭缓存也可使用；其他集群开启缓存并安装本模块的系统仓库后，由本集群源缓存读取。只对实际命中映射的应用下发新Agent能力要求；无关镜像继续原路径。固定源地址不自动迁移，业务Docker登录凭据不自动传播到其他机器。

GET /api/v1/ops/private-registry：系统应用、明确登记部署、逐集群缓存开关/运行状态、关联网站和对外载体，凭据脱敏。
POST /api/v1/ops/private-registry/deployments：confirmed、revision、cluster_id、machine_id、address、CPU/内存、cache_enabled；幂等更新原应用并派发指定集群。
PUT /api/v1/ops/private-registry/clusters/:id/cache：cluster revision、enabled；与普通cluster保存共用校验/同步，重试不重复创建应用。
PUT /api/v1/ops/private-registry/external：settings revision、carrier_cluster_id、domain、certificate_id、username、write-only password、确认安装OpenResty；DNS沿用网站设置或外部维护；关联网站与发布逐项返回。
已有website保存/发布接口支持Basic及路径覆盖；已有普通application接口禁止占用sys-或伪造registry系统角色。

## 首版验收

真实HTTP/SQLite覆盖管理员、revision、系统角色/名称伪造、legacy OpenResty迁移、普通多仓库共存、缓存双入口一致、源与网站关联、账号保持与脱敏、删除引用/未知结果保护。真实Docker覆盖私库push/pull、代理缓存及Agent校验导入、缓存断源命中、失败/摘要错误/清理；真实OpenResty覆盖Basic/路径/TLS及无旁路。浏览器从真实导航执行空状态、安装、刷新读回、缓存开关、公网表单、网站密码设置、失败保留输入，三轮验证并看图。若实测环境为单宿主多个daemon，明确边界，不声称生产多地域验收。

## 已知首版边界

Registry代理进程初始化依赖其上游可达，当前不提供缓存容器断网重启保障。平台限制导入格式为Docker schema2/OCI、gzip或未压缩层；zstd及其他格式按明确回源策略处理。全局daemon代理、商店升级、不可变Release/预热仍在roadmap；本次不声称完成。系统与普通私库内部匿名均可读写，适用于明确可信网络。
