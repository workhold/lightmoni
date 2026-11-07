# 验收

88项平台回归通过，0失败、0跳过；新增覆盖多资源引用、保存与发布去重、托管及手动后端旧发布版本、已撤下旧版本、字段投影、环境脚本文件内容排除、管理员及版本围栏。Runtime/Web类型检查和发行构建通过。

主Agent执行隔离HTTP409夹具的UI脚本，最终连续三轮通过，每轮6组检查。覆盖具体资源及来源版本、正确详情跳转、390px多资源长域名、键盘关闭、旧响应回退、中英文；每轮无pageerror，15次删除请求仅发往隔离夹具、始终返回409，其他写请求为0。已实际查看桌面和窄屏截图。截图等待确认框退出和新弹窗入场动画完成后取证，避免只截到遮罩。

视觉沿用现有Modal与主题，不新增动效；局部低风险改动由主Agent自检，未独立评审。删除无具体定位价值的泛化提示，保留资源名称、域名、版本及主操作。文字报告在evidence，图片按仓库规则保存在本地artifacts/screenshots/specs/104-deletion-reference-details/evidence。

架构不适用：已有管理员删除端点的兼容错误摘要和现有资源详情入口，不改变认证、删除保护、Agent协议、存储、部署拓扑或组件职责。

发行与线上验收已完成，结果与遗留问题如下；本次未新建删除请求或改绑生产网站及应用。

## 续接任务：同步主干

同步 origin/main 8f8b8e2（包含 PR137），唯一冲突是 Compose 镜像标签，保留本次 reference-details-v1 标签；OperationsPage 自动合并后已人工核对保留两组改动。合并后重新运行 88 项平台回归、Runtime/Web 类型检查、Web 发行构建及连续三轮引用详情 UI 检查，全部通过；三轮每轮 6 组检查，15 次隔离 409 请求，其他写请求 0，pageerror 0。

## Docker 发行与指定终端部署

PR138 已合入 main，固定源码 13e78831cd7a4a6484bd5f9f47bce30327173acc，同时包含 PR137 界面改动。镜像 docker.heyphp.com/lightmoni/lightmoni:20261107-reference-details-v1，双平台索引 sha256:96b94e25ea70b253d8c948a76326a06670d776ba0ca5baedf55afa40a2dccf1b。amd64/arm64 各 45 项成品检查通过，各自生产编译文件的 88 项平台回归通过。OCI 校验关联已测试的 rootfs/config，远端 blob、manifest/config 与索引回读通过；latest 发布前后摘要相同。隔离容器、数据卷、网络和测试运行时凭据已清理。

在 https://panel.heyphp.com/terminal 完成 SQLite 在线备份、quick_check=ok 和副本 SHA256 一致性检查，备份目录0700、文件0600，密钥与环境仅保存在原服务器受保护目录。服务器拉取镜像后源码标签及索引摘要匹配，保留原Compose与数据卷，只替换中心固定镜像标签。中心2026-11-07 19:40:42（Asia/Shanghai）启动，中心与ClickHouse均healthy，公网healthz=ok。原状态卷和遥测卷继续使用；Compose关于另一个旧卷标签不匹配的警告保留，没有按警告删除旧卷。

## 真实引用和界面核验

线上成品 resourceReferences 函数通过 SQLite readOnly=true 只读回读：ABC Demo 应用被网站 ABC Demo（abc.heyphp.com）的已保存配置v4引用；该网站当前发布已停用，因此摘要没有已启用发布版本。定位URL能打开正确网站详情，关闭后清除resource参数。没有对生产发送DELETE来触发提示；真实HTTP409和弹窗链路由双架构编译回归及三轮隔离UI覆盖，线上仅只读核对真实引用与跳转，不将隔离弹窗截图称为生产截图。

网站监控入口可点击，大盘仅两张图，访问日志独立页签；刷新后URL和日志页签保持，12条真实日志可见，采集正常、最近成功19:56:32。中心大盘列表5项，系统中心13面板，无可见查询错误，QPS0.13、最近一分钟接收352、在线中心1、上报失败0。Gitea与DBX公网HTTP200，仓库未鉴权HTTP401。

## 未解决的既有清理问题

最终审计不支持“所有平台执行成功”的结论：重启后一份快照有52次成功及48次remove失败，没有unknown；失败均来自既有ABC Demo网站删除清理，错误gateway_directory_ownership_required。发布前备份已经存在206次同码remove失败、删除任务创建于16:54:39（Asia/Shanghai）；20:34只读核对时总失败已329次，仍在自动重试。四个运行应用的卡片在核验快照中显示pending，公网可用不代表清理或卡片状态已修复。

这是发布前已存在的目录归属保护阻断，本次没有接管旧目录、清理宿主机数据、改写数据库状态或绕过归属校验。新引用提示解释当前保存配置仍阻断应用登记删除，不声称网站清理已完成。详情见evidence/existing-cleanup-blocker.json。运行时清理逻辑本次未改动，遗留清理与重试行为仍需单独修复和验收。

架构同步不适用：本次交付保留既有权限、协议、存储、控制职责与部署拓扑；docs/system-design.md 与 Doca（https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53）无需改写，没有声称进行了在线同步。文字发行报告及脱敏线上摘要随本SDD提交；新截图保存在仓库忽略的artifacts/screenshots/specs/104-deletion-reference-details/evidence。
