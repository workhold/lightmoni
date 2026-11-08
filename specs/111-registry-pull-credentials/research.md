# Research

- Decision: 复用中心 encrypt/decrypt，新增独立凭据表而不扩展 SSH 连接凭据或 generic credential。Rationale: 用途边界明确，现有通用资源/AI不会获取秘密。Alternatives: 复用SSH结构会混淆账号语义；应用内明文密码重复且难撤销。
- Decision: 任务只冻结凭据ID/修订与授权镜像，秘密通过独立已签名执行器接口在拉取前临时领取。Rationale: 撤销、轮换和范围调整使待执行任务失效。Alternatives: 直接把密码冻结到历史任务会延长旧秘密生命周期。
- Decision: 认证镜像跳过来源代理及匿名共享缓存，直接按镜像拉取创建独立临时DOCKER_CONFIG。Rationale: 单文件多仓库认证可能在Compose或代理路径误用；每次只有一个仓库秘密，完成即删除，预拉后固定ID。
- Decision: 不直接依赖root用户docker login。Rationale: 受管任务HOME隔离；使用永久登录隐式扩大授权范围。
- Decision: 新能力 operations.platform.registry-auth.v1。Rationale: 旧节点明确拒绝，发行包包含更新后的执行模块。

- Security refinement: 现有执行器journal与managed-jobs快照会持久化载荷，因此秘密完全不进入签名任务载荷；新增签名租约端点只在拉取前返回当前镜像秘密。临时目录显式使用systemd任务HOME。失效授权继续阻止启动/续租，但允许既有已启动任务提交终态回执，避免撤销导致无法对账。
