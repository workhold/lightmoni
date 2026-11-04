# 验收与发行记录

2026-11-03，功能分支 `codex/091-deployment-autoconfiguration`。用户追加授权自行打包、部署、发版并测试；发行结果将在本记录继续补全。

## 功能与兼容

- 受管发布可在已验证的受管任务后顺序入队，实际领取仍串行；普通提权、未完整核对 unknown、生命周期操作仍互斥。没有清空历史执行结果。
- OpenResty 入口在托管区域下稳定生成，后添加区域会补齐；网站仅 CNAME，旧 IP 模式打开编辑器后下次保存转为 CNAME。默认单 CNAME 不再无故申请 DNS 权重能力，供应商回读附加 fqdn。
- 快速安装自动匹配最长托管区域、在线且容量足够的位置和端口；复用有效证书或已有 ACME 账号。应用、入口、网站、证书原子登记，阶段持续调和；相同 request_id 或重试复用资源。过期上传证书、缺少账号、未托管域名等在创建前拒绝，入口 DNS 权限错误可以追踪。
- 系统 Registry 全局仅一个集群/固定机器、一个可写服务、一份存储、容器 5000。拒绝增加系统副本或直接换存储位置，旧多位置配置须先迁移。删除独立 Hub/来源缓存服务，不主动删除旧磁盘目录。额外普通仓库仍可从商店自行安装。保留原 registry 数据挂载。
- 普通应用逐实例注入中心、专用 SDK Key、服务及资产身份；容器和 Compose 自定义环境覆盖默认。Key 加密保存，禁用不自动绕过，删除应用停用 Key；公开响应和日志脱敏。八种后端 SDK 使用同一环境契约，显式配置优先，浏览器配置保持显式。

## 本地验证

- 根 `npm run typecheck` 通过（runtime/AI/web）；TypeScript SDK build 与23项测试通过，Python34项通过，Go全量通过且新增环境回归通过。
- 13份相关 Runtime 回归161项：160通过、0失败、1跳过（真实容器证书同步环境条件）。之后新增过期证书和入口供应商错误断言的 `platform-clusters` 41/41 再通过；Registry认证编译3/3通过。跳过不计通过。
- Java/.NET/PHP/Ruby原生协议验收通过。`scripts/verify-sdk-environment.py` 以实际 HTTP 收到 Node/Python/Ruby/Java/.NET/PHP/Rust 的认证与服务/实例/机器/应用元数据，显式 host 覆盖、无秘密属性均通过；Go以原生 Protobuf 回归验证。Rust crates.io不可达，使用已锁定缓存依赖重新 rustc 编译当前源码后实测，不声称一次新的联网 Cargo 构建通过。
- `scripts/verify-system-registry.py` 从真实模板创建临时 Registry，OCI blob/manifest推送、拉取及重建容器后一份存储的数据保留通过，临时容器与目录已清理。见 [registry-real.json](evidence/registry-real.json)。
- Catalog UI脚本连续3次通过：中英文/明暗主题、1440/390、31应用/6分类、域名主表单、自动位置和高级端口；真实HTTP安装仅记录夹具待执行状态，未伪造生产成功。入口/仓库脚本3轮通过，确认单5000、默认宿主0、自动域名及只选择托管区域。见 [ui.json](evidence/ui.json)、[deployment-ui.json](evidence/deployment-ui.json)。

## 界面与实际画面

沿用现有 React/Ant Design、颜色与排版，主路径收敛为域名及必需业务参数；位置、资源、端口保留高级覆盖。删除手填集群入口、网站IP选项、系统仓库多端口与添加集群副本入口，缩短重复DNS/SSL说明与DBX末尾孤行。独立视觉评审未发现重叠或溢出，提出的重复文案与窄屏换行已修改；窄屏仓库端口名进一步缩为“宿主端口”。

保留抽屉进退、Modal缩放/遮罩、高级折叠三处既有动效，录屏位于忽略目录 `artifacts/screenshots/specs/091-deployment-autoconfiguration/evidence/*.webm`。实际检查桌面、390px窄屏、页尾按钮与200%像素密度局部截图（非原生浏览器缩放），截图同目录：`dbx-zh-CN-390-light.png`、`registry-single-3.png`、`entry-generated-3.png`、`entry-editor-200.png`。旧 SDD 的多仓库 UI 脚本不再代表本次契约，本次以新的 deployment-defaults 脚本为准。

## 架构同步

适用：入口DNS路径、安装编排、仓库存储拓扑、SDK凭据边界。仓库 `docs/system-design.md` 第91章及第62章更新；[Doca系统设计基线](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53) 已保存并最新 seq1714 回读，六段文字与仓库一致，原标题和原生总览10节点/8连线保留，端点有效。见 [doca-readback.json](evidence/doca-readback.json)。

本地 DNS/签名回执夹具不能代替实际公网传播、真实CA签发或生产主机验收；生产测试结果将另列。

## 主干与发行前复核

功能由 [PR #88](https://github.com/workhold/lightmoni/pull/88) 合入 main `9c48c182752e7e3290e7e60ee5256c2e5beb37bd`。发行成品复核前补充：无可用机器时先验证安装参数，保留必填参数及非法端口错误；自动选位置的有状态应用保持固定手动模式，高级托管模式要求自选位置以审阅本地数据限制。相关集群/目录48/48及根类型检查通过。

旧入口兼容复核：已有手填域名但未托管的 OpenResty 在快装事务中补选业务域名区域并生成入口；同一个网关资源继续使用，完成网站发布/CNAME回读。41/41回归及runtime类型检查通过。a69074d候选仅本地构建，未发布，最终制品将包含此修正。

线上复测发现：旧DBX网站的默认权重1残留于DNS所有权日志，普通单CNAME仍触发Aliyun DnsSLB.InvalidType。补充历史verifying权重日志回归，普通单CNAME不启用SLB，并在实际回读成功后移除已不再声明的权重元数据。初次0b45683发行与中心/Agent升级成功，最终发行需包含此兼容修正。

默认权重兼容修正：集群与网站路由57/57通过，根类型检查通过。单目标保留供应商原有权重值（流量仍为100%），仅清理平台已不再声明的权重意图；多目标加权路由回归继续通过。线上最终回读待统一发行后记录。

## 2026-11-04 接续验收

原聊天连接超时后接续用户既有打包、部署、发版和测试授权。#83 与 #91 均已合入，统一发行输入固定为 main `a9588e6a053f5811c1e20e8c563261b23c1ee0c6`；独立工作树从 Git archive 构建，不混入原工作区未提交的 compose 和首次发行证据。

现场确认 ABC Demo 一次 inspect 在 HTTP 502 后留下未知执行，阻塞同主机的应用。已通过现有受保护 SSH 凭据核对：Agent journal 中该作业为 unknown，关联 systemd 执行单元已不存在，无运行中的执行单元，原业务容器仍运行。通过平台人工核对接口记录证据，保留 unknown 原状态与错误码；随后系统仓库、DBX、ABC Demo 已取得运行中状态。未直接修改数据库状态、删除执行历史或改写主机 journal。

发行成品脚本此前仍断言完整管理模式的常驻 Agent 为 root，与已合入 #83 的普通 Agent 加同版 root helper 契约不符。脚本现按该契约核对两种模式均使用普通 Agent、独立 helper 为 root、共享入口包含 helper-run；其余成品检查保持，结果分别记录。此处为验收适配，不是产品源码修复。

本次架构同步不适用：统一发布已经完成设计同步的 #83/#88/#90/#91，保留原 SDD 的仓库章节及 Doca 回读证据；没有新增组件、控制路径、协议、凭据边界、存储或部署拓扑。

统一发行双架构各44项成品检查通过，每架构另有57条部署/DNS、13条签名执行与5条Docker安装器回归通过。固定标签与latest均已推送，独立拉取核对与实测镜像配置/文件层完全一致，index为 `sha256:0c83ef231e5e9cfb7debc31876eaddfac1f2cd2b3a71cfd375468a6f5ce1b082`。详见 `evidence/release-20261104/`。

生产切换前检查发现 Compose 配置仍引用0b45683，实际容器镜像为3309b0b Agent修复版；两者真实image ID及源码标识不同，首次保护检查在备份/切换前中止。重新核对现有Compose环境与实际运行配置一致后，回滚明确固定实际运行的Agent修复镜像，避免异常回滚覆盖既有修复。未放宽任务空闲、镜像摘要、健康和其他容器不变的保护。

### 生产更新与实际验收

- 生产中心已更新为 `20261104-a9588e6`，不可变index与远端发布一致，HTTP健康正常。SQLite在线备份通过完整性检查，主密钥及运行配置备份保留在服务器受保护目录；其他16个容器未被重建，用户、主机、Agent、凭据及运维资源数量与切换前一致。见 [activation.json](evidence/release-20261104/activation.json)。
- 原四个应用恢复运行，未解决未知执行为0，原两条未知历史及人工核对记录保留；没有直接修改生产数据库或主机journal的执行状态。
- 实际快装 `SDD091 快速安装`：仅填写托管子域名 `install-091.heyphp.com` 与DBX必需访问密码，集群/机器/端口保持自动；平台选定位置及20001→4224映射，创建并持久关联网站/证书，阶段达到ready，正式HTTPS返回200。未额外手选DNS账号或ACME账号。
- 旧ABC及仓库网站经正常配置保存/发布迁移为CNAME，原仓库Basic账号密码保留；DBX旧默认权重同步恢复，四个网站的供应商回读均成功，所有权记录均为已应用CNAME、权重NULL。Google Public DNS递归查询同时看到四个子域名指向自动入口；这不代表所有递归缓存均已收敛。见 [public-dns.json](evidence/release-20261104/public-dns.json)。
- 系统仓库只有一个健康实例、一个容器5000端口。匿名/v2/为401，原凭据认证200，原私有ABC镜像manifest仍按原摘要完整读取。
- 实际部署 `SDD091 SDK环境验收`：复用原不可变私有镜像运行验收程序，不内嵌中心地址、Key或部署身份；从平台注入环境获得上述字段，通过真实HTTPS取SDK、校验压缩包并直接初始化客户端。ClickHouse的 `lightmoni.log_sdd091live` 回读到1条本轮日志，服务、实例、host/agent、机器、应用、集群身份齐全，专用Key与应用绑定匹配，显式host属性覆盖生效。初次验收查询漏写数据库名，修正为实际lightmoni命名空间后完整复查通过；没有据此修改产品代码。
- 中心、ABC、原DBX及快装应用HTTPS均为200；全部使用正常DNS和可信TLS，未关闭证书验证或指定固定IP。原始回执只在忽略目录保存，提交证据移除生产执行/主机/Key引用ID，未导出凭据值。见 [online-verification.json](evidence/release-20261104/online-verification.json)。

验收期间Agent曾记录upstream network error，旧入口实例随后由既有调度退出并重新创建，网站短时等待入口。首次35秒间隔的三个稳定性样本前两个捕获到等待入口、最后一个恢复，未把这一轮记为稳定性通过。现场只有一台入口主机，决定采用已有的固定主机模式，避免心跳短断触发原地重建。平台的stop_before_changing_deployment_mode保护要求先完成停止，随后正常保存v4及启动入口；没有调整在线阈值、清空历史或绕过执行互斥。物理入口主机、组件、协议和凭据边界不变，此为现有部署模式的运行配置调整，架构同步不适用。最终回读及切换后连续样本另列。

本轮未把旧root常驻Agent直接覆盖为新权限模型：该主机仍运行先前091构建；新中心已提供含#83修复、同版普通Agent/root helper的发行包。旧root安装需要按受管卸载/重装流程迁移，不声称本次已在该主机启用新helper。

两套具名验收应用及配置保留供复查，SDK验收端口仅绑定目标主机loopback；原业务应用、原镜像与存储保持。

固定入口v4于2026-11-04 08:32:43（Asia/Shanghai）完成签名启动回执，随后08:33:37综合验收再次通过。08:33:36、08:34:11、08:34:46三个35秒间隔样本均通过：Agent心跳年龄分别46.03/21.03/26.03秒、六个应用实例全部running且healthy、四个网站active且synchronized、未解决unknown为0，且入口始终是同一实例。切换前失败样本见 [stability-before.json](evidence/release-20261104/stability-before.json)，切换后结果及本轮签名apply/stop/inspect统计见 [stability-result.json](evidence/release-20261104/stability-result.json)。这是本轮有限现场复查，不作长期可用性保证。

本轮隔离成品测试容器、ClickHouse及运行时测试凭据文件已清理；只清理本轮归档/OCI中间产物，保留小型证据及原有本地服务。
