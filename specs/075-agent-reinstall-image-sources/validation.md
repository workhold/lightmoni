# 验收记录

日期：2026-11-01。功能分支 `codex/075-agent-reinstall-image-sources`，[PR #63](https://github.com/workhold/lightmoni/pull/63) 目标 main，尚未合并、未发布到生产。

## 已验证

- 中心/执行器相关测试116项全部通过：平台集群、镜像代理、既有集群缓存、平台执行器/安装进度、主机管理。覆盖手动/托管重装收尾、停止容器保留、旧 Agent unknown 作业、有状态及持久挂载保护、健康机器不被无关核验阻塞、SSH 绑定变化、数据库故障事务回滚、来源 CAS/旧 Agent 升级提示与领取重验。
- `machine-agent-lifecycle` 与离线卸载脚本47项全部通过，合计163项；新增真实固定 shell 执行验证 operations 内业务数据保留、身份/队列清除后 fresh 可接入。
- runtime 类型检查及构建、web 类型检查及生产构建通过。网页构建保留既有第三方 use-client 提示，不影响产出。`git diff --check` 通过。
- 独立 Docker-in-Docker 引擎6项验收，见 [docker.json](evidence/docker.json)：实际通过 m.daocloud.io 指定代理拉取官方 OpenResty index digest，检查平台/实际 ID；nginx 预检与启动使用同一 ID 且禁止隐式拉取；只读核验能发现运行和停止的网关；明确删除测试网关后才核验为空；复用代理本机镜像不再次拉取。引擎和测试网络已清理，未连接生产 Docker。
- Chrome 操作生产网页构建 + 真实内存 SQLite/平台 API：未安装私库也可添加 Docker Hub 规则；回源默认关闭；保存成功；版本冲突提示且保留回源开关编辑；重新载入恢复最新设置；切换英文后规则、说明及操作均可见，再切回中文保存。截图位于工作区 `artifacts/screenshots/agent-reinstall-image-sources-075/configured.png`。验证服务仅监听 loopback，不访问生产主机。
- 架构影响适用。仓库 `docs/system-design.md` 第75章与 [Doca 基线](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53) 同步，回读版本920的12段完整文字、12节点/11连线，与写入内容逐项相同；原有200个顶层块保留，原生图的 outline 未变化。见 [doca-readback.json](evidence/doca-readback.json)。这是原生结构与正文回读，未声称图的像素渲染验收。

## 兼容与边界

中心与 Agent 都需要升级；没有代理规则的部署保持旧行为。旧 Agent 会明确提示升级，不会静默绕过代理。规则保存只影响后续部署/重试，不自动重启现有应用或 Docker。可变 tag 以受信代理内容为准，固定内容使用 digest；首版不实现 daemon HTTP/SOCKS 代理、分层继承、新增私库认证或 CA 管理。

旧实例仍有容器、执行结果未决、目标变化、有状态或持久挂载时保留人工核对边界。只读零容器回执证明当前稳定机器绑定范围，不宣称已迁移的旧物理主机被清空。历史、业务容器、卷和 operations 数据不自动删除。手动部署需要在核验完成后明确重部署。
