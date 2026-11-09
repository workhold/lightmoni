# Contracts

## Files
沿用/machines/:id、真人cookie及credential_id。结构化create/rename/remove/chmod必须confirmed与expected_version；拒绝根、链接、特殊文件，无覆盖/递归。成功须回读，可能已写失联为unknown，审计无正文。

## Host containers
host_docker签名任务和request_id幂等不变。batch_management_version=1仅由签名管理组件清单声明，中心据此判断批次兼容性；旧组件需升级，单容器权限不变。只读inspect_many一次最多读取50个明确容器ID，仅返回名称、版本、状态和归属摘要，减少逐目标独立任务轮询。有界targets每项完整id/name/revision，默认force=false/remove_volumes=false；先验证全批再逐项核对回读，逐项结果。停止容器清理排除运行对象；镜像排除运行和停止容器引用。

## Catalog and registry
可选homepage/repository/documentation为真实HTTP(S)。预览只读脱敏，不创建凭据/网站/证书/部署。标签次序不变，清单有界并发去重；删除完整依赖扫描及摘要保护不变。

## External Compose
复用operations资源kind=compose和inspect/adopt、plan/approve；明确项目、配置、卷和重建影响，inventory_sha256/expected_generation=0/acknowledge_recreate必需。不支持配置先拒绝，不隐式成为platform workload。

## Schedules
approved_by是真人ID；定时run必须有fire→schedule精确绑定，重验enabled/revision/authorizer/resource revision/input。派发、领取、开始验证；停用/删除/再授权/用户失效阻断未开始运行，手动操作独立授权不受影响。

## Backup and migration
完整Compose、多挂载及manifest流式归档，保留uid/gid/mode/sha256，文件不进入任务JSON。敏感输出目录0700文件0600。S3凭据仅由受保护运行时环境或root私有白名单文件提供，TLS、条件PUT拒绝覆盖、完整回读摘要。离线systemd计划只生成文件、不安装，是独立本机root持续授权；平台计划另按密封来源重验，不能混称。迁移拒绝非空目标、摘要/版本不符及未覆盖外部存储；保留来源，避免双中心调度。
