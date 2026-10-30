# Validation: 网站多集群入口与线路流量管理

Date: 2026-10-30（Asia/Shanghai）
Branch: codex/043-website-cluster-routing
Base: codex/042-cluster-applications / GitHub #18（仍为OPEN，尚未合入main）

## 实现与验收

- 网站主体优先用户网站、域名及实际集群；次要“OpenResty 管理”抽屉承载部署、入口域名、安装与编辑。全局唯一OpenResty，多集群部署增删与入口域名；普通已安装应用可编辑机器/副本/资源，运行中部署不能直接删除。入口域名可外部维护，或选择共享托管zone自动维护健康入口A/AAAA。
- 托管网站一次选择服务与HTTP(S)端口，按服务部署发现集群；新增集群跟随最近发布修订，公共草稿不驱动线上切换。手动模式保留不同集群的代理配置。
- cluster_policies独立即时流量开关、权重1–100、默认与高级线路；网站CNAME到集群稳定域名。南北默认1:1+省份分流、南方失联撤下、北方保留、南方恢复后重加均由真实控制器和有效Agent租约回执验证。
- DNS归属包含线路，权重/TTL/状态读回，外部修改及未知写入保护；已取得RecordId但列表延迟、Aliyun独立权重调用失败均不重复创建。独立云写入间重新校验授权；DNS区仍被入口引用或owner记录待清理时拒绝删除。

## 自动检查

命令（在runtime目录）：

```sh
node --import tsx --test --test-concurrency=1 test/platform-clusters.test.ts test/platform-cloud-certificates.test.ts test/platform-website-routing.test.ts test/platform-api.test.ts test/platform-store.test.ts test/platform-workloads.test.ts test/platform-reconcile.test.ts test/platform-nginx.test.ts
```

83/83通过，0失败，见[evidence/runtime-tests.txt](evidence/runtime-tests.txt)。其中本特性9项覆盖新字段与单例、托管发现、南北CNAME/入口DNS/即时策略、线路所有权/外部修改/撤权、冻结修订自动跟随、DNSPod递归线路权限与权重、索引延迟及部分成功、Aliyun多调用间撤权、草稿切换服务不影响旧发布及旧流量开关。

`npm --prefix runtime run typecheck`、`npm --prefix web run typecheck`与`git diff --check`通过。无新增依赖；未为本次交付运行生产构建、全量无关SDK/AI测试或重新部署真实Agent。

## UI与视觉

使用隔离loopback QA管理员、真实SQLite/加密存储/资源HTTP路由运行：

```sh
LIGHTMONI_OPS_QA_PORT=19943 node --import tsx test/fixtures/cluster-ui-server.ts
LIGHTMONI_DEV_API_URL=http://127.0.0.1:19943 npm --prefix web run dev -- --port 5174
LIGHTMONI_UI_RUN=1 node web/src/app/ops/verify-website-routing-ui.mjs
LIGHTMONI_UI_RUN=2 node web/src/app/ops/verify-website-routing-ui.mjs
LIGHTMONI_UI_RUN=3 node web/src/app/ops/verify-website-routing-ui.mjs
```

按最终“OpenResty 管理”命名及信息层级连续三轮全部通过，每轮6组检查、浏览器pageerror为0。结果：[第1轮](evidence/ui-1/results.json)、[第2轮](evidence/ui-2/results.json)、[第3轮](evidence/ui-3/results.json)。覆盖网站主体不展开基础设施、OpenResty 管理抽屉增部署/域名读回、托管服务发现及厂商线路选择/读回、独立流量开关、保存冲突保留输入与恢复说明、手动不同后端、普通安装配置编辑、390px实际首屏可用及200%等效720×500视口动作可见。线路目录在浏览器用固定fixture，真实后端DNS目录权限和签名/权重协议由上方API回归覆盖。

沿用现有Ant Design、色彩变量与导航。独立视觉评审发现并修正：缩到窄屏时导航遮住业务区（现在自动收起、回桌面恢复偏好）；版本冲突缺恢复说明；重复线路说明；全页截图固定顶栏捕获异常（现在归零滚动后拍摄）。复核已无阻断，见[evidence/visual-review.md](evidence/visual-review.md)。最终稳定桌面图以ui-3/websites-desktop.png为准；当前脚本捕获前重新加载、滚动归零并检查header.top=0；此前全新浏览器还确认visualViewport.pageTop和main.top=0。实际截图保存在本地忽略目录 `artifacts/screenshots/specs/043-website-cluster-routing/evidence/ui-{1,2,3}/`；已打开检查桌面、390px、表单、错误及200%等效截图，非仅检查文件存在。

三处动效复用：网站列表出场、原生Drawer/Modal开合与保存完成反馈；遵守prefers-reduced-motion。信息层级调整后已重新录制网站主表进入及“OpenResty 管理→编辑→保存”全过程，见同一artifacts根下`motion-website-first-entry/`与`motion-website-first-action/`。旧`motion-entry/`、`motion-action/`及`motion-detection/`为调整前证据。记录为深色主题，静态UI验收为浅色；favicon.ico 404为本地原有资源提示。后台页面不适用落地页式滚动叙事。

## 架构同步

影响判断：适用。改变网站DNS控制路径、入口域名的共享owner与DNS归属持久字段；凭据仍在中心，Agent边界不变。仓库更新`docs/system-design.md`42.4、42.5、42.6及42.9；对应[Doca基线](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53)保存成功并用最新seq790按块回读。

原生图`cluster042-baseline-model`节点ID及完整6条连线未改，只更新DNS节点语义（仍8节点）；新增`website043-routing-native`为8节点9连线。正文42.4/42.5/42.6逐字匹配；新增42.9边界与原生图均完整回读，原有其他内容保留。回执摘要：[evidence/doca-readback.json](evidence/doca-readback.json)。窄屏导航响应及错误文案属于原有UI交互修正，不新增架构边界。后续信息层级按用户要求改为网站主体与次要“OpenResty 管理”抽屉，仅同步42.6的界面描述；Doca保存后最新seq796回读逐字一致，只改该段，未改原生图或无关内容，见[evidence/doca-ui-readback.json](evidence/doca-ui-readback.json)。API契约与数据/控制/凭据边界无新增变化。

## 真实环境边界与兼容

云DNS通过协议fixture验证；未使用真实阿里云/DNSPod付费域名套餐，不声称真实省份解析、真实CNAME权重可用、公网缓存传播或真实南北地域切换已验。阿里云产品页与部分SLB接口文档的CNAME限制不一致，实现要求实际API接受且Weight/LbaStatus回读，否则报错/待验证，不静默降级。DNSPod的0权重不等于停用，因此使用独立启停/撤下。DNS有TTL，故障撤下不提供即时缓存切换保证。

旧API未指定dns_record_mode时保持address行为，避免隐式迁移存量；新UI默认CNAME。首次启用CNAME须先为全部启用目标配置集群入口域名。公开配置保存仍是草稿，集群流量策略则即时生效；运行中的部署先停用清理再移除。

## 交付

提交前已fetch origin/main，未发现新主干提交需要合并。当前特性基于#18的跨集群模型，交付PR目标main，标记草稿并明确依赖#18；未获得合并授权，不合并、不推main。交付：[GitHub #19](https://github.com/workhold/lightmoni/pull/19)，草稿，目标main，依赖#18，未合并。
