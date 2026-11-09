# 容器、镜像与商店验收

2026-11-09，独立工作树 `codex/117-deployment-followups`。无生产写入、合并或发布。

## 最终行为

- 主机容器清单保留最近观察及时间，后台刷新不遮住已有表格；浏览器仅保留最近20个主机缓存，过期缓存不冒充新观察。Compose能力探测缓存5分钟，容器状态仍每次真实读取。
- 勾选容器或“清理停止容器”先经单个只读 `inspect_many` 获取最多50个精确ID的名称、版本、状态和归属摘要，再审阅 `remove_many`。整批先核对，逐项再次核对及删除后回读；标签归属变化也使版本失效。默认保留卷、目录和镜像，运行对象默认拒绝，强制中断须主动选中。停止清理不能强制删除运行对象。已有命名卷/镜像清理继续沿用SDD109。
- 每项结果区分已删除并核验、确定失败、结果未知、未开始。丢失响应仅通过原请求回查，不重新提交；未知进度是证据，不赋予healthy或释放写入围栏。恢复按钮位于当前审阅弹窗内，可直接操作。
- 新管理组件在签名清单中声明 `batch_management_version=1`。中心只由有效受管执行器观察派生批次兼容状态；旧组件保留单容器功能，批次入口提示升级，HTTP拒绝向其派发新动作。授权仍使用既有 `docker.host` / `operations.managed.v1`。
- 私有镜像版本沿用原生Registry v2接口。清单读取最多4并发，保持标签原顺序，相同在途子摘要只请求一次；摘要校验、分页、深度和数量上限、多架构引用保护及删除前完整扫描继续有效。
- 35个商店模板区分官方网站、源码和部署文档。`catalog/:id/preview` 使用配方preview上下文纯计算，不创建资源、目录、网站、凭据、部署或随机秘密。预览随表单更新，秘密隐藏，持久化挂载目标可见；运行时数据目录、项目卷名及自动端口以占位说明。使用本地Monaco，无CDN。
- 主机容器页可进入已有Compose管理。公开观察仅增加Compose项目名，不上传原始labels/env。管理员输入完整原YAML，登记后生成只读检查计划，明确批准检查后再审阅接管；检查给出支持判断和阻断原因。接管绑定项目、资源版本、`inventory_sha256`、`expected_generation=0`、重建确认，经原operations计划/批准协议执行。保留原项目名和准确命名卷，明确会重建服务。配置不匹配可人工确认替换完整登记配置后重新检查，保存失败保留输入；旧审阅失效。未把外部项目转换成第二个platform workload。

## 自动化与真实资源证据

相关Runtime回归59项：57通过、0失败，2个既有Docker环境开关用例按默认跳过。命令在`runtime/`：

```sh
node --import tsx --test test/host-docker.test.ts test/host-container-contract.test.ts test/docker-controls.test.ts test/platform-registry-images.test.ts test/application-catalog.test.ts test/operations-containers.test.ts test/catalog-preview.test.ts
```

包含100标签并发峰值精确为4、共享index子摘要仅一次、稳定标签顺序；整个批次前检、归属变化、精确删除、部分确定拒绝、丢失DELETE后已确认/未知进度和持久围栏；配方参数更新、秘密脱敏、无随机秘密、已知Compose能力缓存、公开项目名与兼容版本。Runtime/Web类型检查通过。

真实本机Docker Engine 29.4.3 / Compose 5.1.3 使用已有 `alpine:3.23` 及随机QA名称，以下两项均通过：

```sh
LIGHTMONI_DOCKER_LIVE=1 node --import tsx --test --test-concurrency=1 test/host-docker-live.test.ts test/compose-adoption-live.test.ts
```

- Engine适配器创建、改名、修改资源限制/策略、启停、清理精确未引用镜像、`inspect_many`及`remove_many`；未选容器、停止容器引用镜像和命名卷保留。新增批次读取后再次单独重跑该真实Engine用例通过。
- 外部项目先启动原服务并写入命名卷sentinel；检查、接管重建后仍只有原项目中的一个服务，容器ID发生变化，原卷名和sentinel内容不变；再检查为管理代次1。测试结束删除了本次创建的容器、镜像和卷，未操作生产节点。

上述真实适配器验收与现有签名协议回归分开进行，不宣称在本机macOS完成Linux systemd root-worker全链部署。

## 浏览器与视觉

`node scripts/verify-deployment-followups-ui.mjs` 使用真实源组件、Vite临时页面、Chrome和隔离HTTP/SQLite容器任务夹具；Compose端点使用明确API夹具，实际接管另由上述真实Docker验收。每次覆盖：停止容器审阅/删除3轮、未知提交回查且无重复删除、英文390px批次审阅、旧组件HTTP拒绝与单对象保留、中英文/明暗/390px商店纯预览、已有Compose登记/检查/接管3轮（含批准响应丢失后仅GET恢复，窄屏登记配置保存失败保留输入及新版本复查）。最终连续运行结果见 `deployment-ui-runs.json` 和3份对应报告；每份均不得有pageerror。

前置测试发现并修正：测试代理Origin/Host不一致（保留生产CSRF规则）、AntD两字按钮和Select虚拟选项定位、Monaco原生EditContext的键入方式；还发现产品中原未知请求恢复按钮位于被遮挡的下层弹窗，现已移入当前弹窗。故障注入的单次socket hang up是预期证据。

界面沿用现有Modal/Form/Table/按钮和明暗主题；单个主动作按阶段出现。增加了登记配置可读预览、短状态文案和创建计划后的审阅定位；保留项目、主机、卷名与中断影响，不使用原始JSON当产品审阅内容。静态截图已实际看图，中文/英文及390px无页面横向溢出；表格自身可横向滚动。截图保存在忽略目录 `artifacts/screenshots/specs/117-deployment-followups/evidence/`，包括容器批次、未知回执、商店YAML、接管计划。复用Modal进入、按钮按下和详情区域进入的现有反馈；静态截图不证明动效质量。本次无独立视觉评审、无虚构评分，也未宣称专门200%缩放和动效录屏验收。

## 链接核对

`catalog-links.json`保存35个模板链接；`catalog-link-checks.json`记录105个HTTPS链接HEAD核对，96个返回200，9个为403、308或暂时网络错误，未将其伪记为访问成功。Gitea官网、源码及Jenkins源码另用官方网页回查确认；不把Simple Icons图标仓库冒充应用源码。MySQL/Nacos的站点防护和文档重定向保留原真实官方地址。

## 剩余边界

已有Compose仅支持原有限定集合：固定镜像版本、项目命名卷和bridge网络；绑定目录、build/env_file、特殊驱动/权限及外部卷明确拒绝。接管成功仅表示容器状态回读，应用健康和数据内容不能由UI夹具替代；真实用例仅核对测试sentinel。旧节点须升级新管理组件后才提供批次兼容状态和接管支持判断。不执行任何生产删除、重建或升级。

## 主代理最终复跑

主代理在集成后连续执行完整脚本3次，每次12组检查通过、pageerror=0，见 `deployment-ui-parent-summary.json`、`deployment-ui-final.txt`、`deployment-ui-parent-2/3.json`。文件管理脚本亦由主代理完整运行3轮通过。曾并发运行的两个夹具共用Vite缓存导致动态模块加载失败，已给验证脚本增加独立临时缓存、关闭HMR/监听并清理；这只调整测试环境，没有修改生产Vite配置。
