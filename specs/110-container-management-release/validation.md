# 发行验收

2026-11-08，按用户明确授权合并、发布Docker并部署。功能PR142与PR147已通过GitHub合入main，源码固定`70a0060fc47581078a3a0a5ac7b921c01d58d0aa`。合入前Runtime/AI-runtime/Web类型检查及44项相关回归通过。

## 镜像发行

- 固定标签`docker.heyphp.com/lightmoni/lightmoni:20261108-container-management-v1`。
- Linux amd64/arm64各52项发行检查通过，涵盖非root运行、真实隔离ClickHouse/SQLite、健康、管理员登录、SDK/Agent包校验、容器任务接口权限、编译后的签名执行桥和严格Docker管理适配器。匹配架构Agent包包含host_docker契约、执行器与management_version标记。
- 首轮发行检查沿用旧测试装载器，未复制新增加的host-docker-fixture而报模块缺失。补齐测试夹具装载后重新运行，两架构全部通过；没有为修复测试装载器修改产品镜像。
- OCI索引`sha256:acf3c4bdbc6cd6ece7ffc82ed24aeab2d97a3f899c99a4dd5946ceca16ba01c9`。本地blob SHA256、测试镜像rootfs/config与发行manifest一致，Registry平台manifest/config、全部blob HEAD及固定索引GET回读通过。
- latest前后均为`sha256:1435938eacd969554e581b1cce0b996ff36ac6e1b886c9fc42e5b21e231a5a51`。Registry凭据只在运行时通过系统凭据助手读取。隔离发行服务、数据卷和随机运行时凭据已清理。

## 受保护备份与生产更新

经既有已登录1Panel终端执行，备份目录`/opt/lightmoni/backups/sdd110-container-management-20261108`权限0700，配置、环境、完整inspect、主密钥、快照和报告0600，仅保留在生产主机。SQLite一致快照完成，quick_check为ok，459003页×4096字节=1880076288字节；主机副本大小已核对。备份使用[Node SQLite backup](https://nodejs.org/download/release/v24.15.0/docs/api/sqlite.html#sqlitebackupsourceDb-path-options)，单批页数大于源总页数。

终端自动化曾出现浏览器桥接错误及原生连接超时，未切换服务；恢复原生终端后回读确认备份完成。生产拉取固定标签已完成。首轮升级前旧容器健康检查一度异常，脚本在变更前拒绝执行，中心镜像和配置均未替换；同期公网请求超时。后续只读检查时已自行恢复healthy，无OOM、重启次数0，未手动重启，未断言具体根因。恢复后重新执行完整前置检查再升级。

中心于2026-11-08 20:08:19（Asia/Shanghai）启动，20:08:45回读新标签、revision与Registry索引一致，状态healthy。只原子替换现有服务器Compose中的单个中心镜像引用，执行`up -d --no-deps --no-build --pull never --wait --wait-timeout 180 lightmoni`。/data继续使用原卷；Mounts、Env、User、Entrypoint、Cmd、WorkingDir、端口、网络集合、重启/安全选项及主密钥逐项一致，其他容器ID不变。未恢复或替换数据库。公网healthz随后独立多次返回HTTP 200与`{"status":"ok"}`。脱敏回执见evidence/deployment-report.json和public-health.json；原生截图留在本工作区忽略目录。

## 受管主机组件升级

完整管理节点原Agent仍为旧版，升级被一条既有OpenResty只读inspect未知任务阻塞。已通过现有SSH终端在目标主机只读核对精确任务：root journal记录succeeded，关联systemd瞬时服务not-found/inactive/dead且MainPID=0，/proc无匹配执行进程。未读取或输出payload配置、凭据及敏感执行输出。首次检查命令使用了主机Python 3.6不支持的capture_output，已改用兼容PIPE/universal_newlines后完成；无主机配置变更。

2026-11-08 20:17:51通过既有管理员界面的原执行记录提交现场核对原因，回读状态为“结果未知，已人工核对”。没有重试该操作、停止业务容器或把中心未知结果改成成功；审计保留。解除已结束检查的围栏后，通过统一维护入口审阅并执行固定70a0060源码的amd64 Agent包，目标构建`0.1.0-70a0060fc475-9324bc0e9a8e`，包SHA256`17551ea168538a3b30a61f5bc7d3a6ef5dcac3d0e48cf6b5aade931bb3281f58`，与经过发行验收的生产amd64中心镜像内目录一致。

原记录回读“更新成功”；主机列表显示Agent在线、完整管理、当前发行提交70a0060fc475。进入全部容器面板，只读观察到运行/停止、平台/外部容器和可用的创建、镜像清理、任务记录及逐项管理入口，未执行生产容器变更。未新增授权或改变运行模式；另一仅监控且未配置SSH凭据的节点保持原样。该只读生产确认不能替代SDD109的浏览器全流程T006。

最终交付检查包括Compose占位环境配置解析、证据JSON解析、双架构52项零错误、源revision/digest/Agent目标包一致与diff检查。生产备份和运行时秘密均未进入仓库。

发行记录通过[PR148](https://github.com/workhold/lightmoni/pull/148)提交至main，最终合并状态见链接；按本轮用户授权通过GitHub PR合入，没有直接推送主干。

## 验收范围

SDD109的浏览器全流程T006仍未完成；本次用户合并授权不代表该验收通过。发行检查中的前端文字/资源与契约断言不构成页面交互验收，不在生产删除业务容器或镜像以补测试。

架构同步不适用：本次只发行SDD109的既有实现，不改动拓扑、协议、存储及权限边界。SDD109中仓库章节和[Doca系统设计基线](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53)已同步，seq1765回读及53个原生图块节点、连线保留证据见对应目录。本次未改写在线设计。
