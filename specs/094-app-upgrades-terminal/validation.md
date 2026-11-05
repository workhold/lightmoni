# 验收与交付记录

## 本轮功能

- 商店默认版本比较、逐服务镜像审阅、管理员确认升级、自定义单容器/Compose镜像更新与同标签重拉已实现。升级复用加密修订及部署回执，不把排队或保存当成功。环境/秘密/命令/挂载/端口/身份/部署位置保持。
- 显式升级绕过可变本地标签，遵循现有私有仓库/镜像代理政策，解析后固定镜像ID；后续部署的image_pull_policy为always。旧执行器缺少operations.platform.image-refresh.v1时明确拒绝，需先升级Agent/helper，不能静默复用旧标签。
- 应用容器终端选择实际部署机器和完整容器ID，保留SSH账户选择、主机密钥/租约/会话鉴权、限时和撤销。中心及远端再次验证归属；失败不回落主机交互shell。审计只存目标和状态，无交互I/O。

## 验证证据

- runtime与web类型检查通过，runtime和生产Web构建通过。Web构建保留既有第三方use-client提示，无构建错误。
- 71项终端、应用/集群、镜像代理、缓存和固定命令回归全部通过，无跳过。覆盖旧商店版本、配置/秘密保留、过时/重复审阅（包括同商店版本下镜像映射发生变化）、服务拓扑变化、旧执行器、同标签、代理禁止回源、跨机/外部/退役/过期容器、SSH exec+PTY、撤销和命令注入。见evidence/runtime-tests.txt；另有签名部署、执行器权限、安装与观测协议47项集成回归通过，合计118项，无跳过。
- 完整实际浏览器6项通过：商店更新提示/审阅/确认/安装记录、自定义逐服务升级、两机器及多容器选择、明确SSH账户步骤、真实SSH+PTY进入实际Docker容器、断开释放。终端返回hostname与所选容器ID前12位逐字一致，无浏览器异常。fixture模拟Agent调度回执和库存；SSH协议、PTY、Docker容器及页面均真实，测试未自动对生产业务执行升级。见evidence/ui-report.json、web/src/app/ops/verify-app-upgrades-terminal.mjs。
- 使用四个临时Docker容器和两个本地SSH服务；测试结束自动清理，不更改用户机器/凭据/生产数据库。截图仅保存在artifacts/screenshots/specs/094-app-upgrades-terminal/evidence/。

## 架构同步

适用：新增升级控制路径、镜像刷新能力契约及SSH进入容器的权限/审计路径。仓库docs/system-design.md“应用升级与容器终端（SDD094-app-upgrades-terminal）”与[Doca系统设计基线](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53)完成保存和最新区域回读。6段文字一致，原生图10节点/9连线匹配；既有部署图完整对象未变。最新成功回读seq1739，见evidence/doca-readback.json。本功能在分支待合入/发行，文档明确状态。

## PR94 续接与生产状态

上轮afd06a6切换回执已找回，但当前生产被后续主机UI发行20261104-host-ui-790cca58456a覆盖；实际运行模块不含restoreObservationRows。四个HTTPS入口与SDK三轮持续信号正常，六应用容器及四网站访问采集三轮均未恢复，中心仍4批旧积压。详见evidence/production-readback.json；同一诊断已补回PR94的SDD092。队列、游标和未知审计均保留，没有为验收删数据。

在统一生产发行基线、保留当前主机UI改动之前，不以旧发行覆盖中心。已向用户提出协调其他相关聊天的授权请求，尚未取得回复；没有跨聊天发送消息。新升级功能与容器终端尚未部署到生产。PR94仍保持草稿，本功能PR面向main并注明依赖PR94，未获合并授权，不合并。

交付：[PR #98](https://github.com/workhold/lightmoni/pull/98)，面向main、保持草稿，依赖PR94。提交前已同步origin/main并确认其为当前分支祖先；118项相关回归、真实Docker浏览器验收与构建全部通过。T005生产恢复验收仍未完成，没有将版本冲突计为通过。
