# 设计

1. 在平台调度器内增加旧实例核验，复用加密平台执行与有效 Agent lease。新 instance.recovery.inspect 仅按实例标签、Compose project 和网关固定名枚举 Docker，结果只含 instance_id、container_count、absent、observed_at。不依赖已清除的 Agent 状态文件。中心冻结 machine_id/current_agent/old_agent/旧 current_run_id/目标代际与 SSH 目标签名，领取与回执均重验；只读失败按有界间隔重试，unknown 仍可只读重核验，不重放变更。
2. 核验零容器后原子检查旧执行，退休旧行、置 stopped、释放仅该实例的 ops_platform_ports、保存 recovery 审计与 run ID，清空 current_run_id 阻断迟到旧回执。历史实例/端口映射/运行记录保留；有状态或当前/冻结版本带持久挂载的旧实例不自动重建；阻塞按机器隔离，不阻止其他健康机器上的无关应用。手动部署下一次明确部署可建新实例，托管 stateless 继续已有期望。
3. 成功受管卸载仅在原审批凭据归属已证明时写 Agent removed 墓碑与事件。不把程序卸载当作 Docker 容器已停止；旧应用占用等新 Agent 核验。明确 purge 仅清除 Agent 身份/配置/遥测与运行状态，保留 operations 内的业务目录和持久数据。
4. ops_image_sources 单例持久 revision/rules/actor/time；共享规范化解析源 registry、repository、tag/digest。全局 GET/PUT /ops/image-sources 经管理员守卫。空数组关闭；CAS 不丢失其他编辑。
5. apply 作业冻结命中应用镜像的规则与策略 revision，要求 operations.platform.image-sources.v1；领取时重算并拒绝过时规则。Agent 共用 preparePlatformImages，遵循本机→集群缓存→指定代理→明确允许的原源。docker image pull mapped-ref，inspect 平台/ID，服务 image=实际 ID、pull_policy=never。网关预检与启动使用相同 ID，配置摘要仍基于原始镜像与网站配置，状态保存实际 image。
6. 网页通过管理员专用 `/image-sources` 页面和“运维工具 → 镜像源”导航入口展示动态来源规则和回源开关，复用 ImageSourcesPanel；私有镜像页仅保留系统仓库、集群缓存与对外发布，移除代理表单。接口与持久配置保持不变，刷新或切换入口不丢失规则。应用安装记录增加拉取阶段与重装阻塞诊断。
7. 相关单元/集成、类型检查、网页构建与真实 Docker 验证后记录结果，更新本地/Doca 架构并回读，功能分支提交 PR。

架构同步适用，详见 spec.md。Doca 仅追加本特性章节及原生流程图，不重建现有文档。
