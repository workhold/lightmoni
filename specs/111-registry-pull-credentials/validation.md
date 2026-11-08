# 验收与发行记录

2026-11-08（Asia/Shanghai）。功能分支 codex/111-registry-pull-credentials，独立工作树基于 origin/main 80cd4e6，原工作目录的 compose 与上一轮发行证据未改动。

## 最终行为

镜像源页面管理独立加密仓库凭据，应用表单显式多选。支持容器、Compose、多仓库、升级刷新、重试和换机共用的受管发布。默认HTTPS、仓库/路径/集群范围、有效期、空密码保留、轮换/撤销、CAS和当前/已发布引用删除保护。公开接口只返回元数据。已发布快照不受未发布编辑影响。

密码由独立签名执行器以当前租约、精确镜像在拉取前临时取得；载荷、journal、managed-jobs快照和重放历史均不保存密码。Docker临时配置在当前任务/run目录，单次仅一仓库，0600文件/0700目录；正常完成、失败和取消清理，硬中断依赖既有systemd RuntimeDirectory清理。没有新增持久docker login或daemon修改。认证镜像跳过匿名代理/共享缓存，核对镜像ID后启动；旧节点明确要求升级。中心需要更新，目标主机Agent也需要本发行管理组件。

## 检查证据

- 初始临时认证契约测试在实现前因模块缺失失败；实现后通过。
- 根类型检查通过（runtime、AI-runtime、web），SDK/runtime/Web构建通过。Web沿用既有Ant Design use-client构建警告，没有新增构建依赖。
- 9份相关Runtime回归164/164通过、0跳过；之后输入校验和独立取密重放修订相关28/28通过。涵盖加密、脱敏、空密码、换账号需密码、精确仓库/路径/默认端口、Docker Hub别名、集群范围、过期、撤销、轮换、歧义、旧组件、已发布快照、签名租约、重放取密及终态回执。
- 真实隔离Docker引擎与HTTPS Registry六项检查通过：bcrypt认证推送、匿名拉取拒绝、产品preparePlatformImages认证并固定本机image ID、真实启动容器、强制刷新/Compose准备、错误账号拒绝及临时文件清空。见evidence/registry-live.json。随机测试凭据、TLS私钥、认证文件和隔离引擎/网络均清理；没有生产变更。
- 页面使用真实本地HTTP管理API及SQLite：连续三轮通过创建/刷新、无效地址失败保留输入、空密码编辑、应用表单绑定、引用读回、撤销读回，另验英文。1440明/暗、390窄屏及200%设备像素截图/录屏位于忽略目录artifacts/screenshots/specs/111-registry-pull-credentials/evidence。见evidence/ui.json。
- 独立安全研究发现并修正：密码不进入已有执行器持久载荷；取密响应重放只存非秘密标记；Docker认证键保留镜像实际domain/显式443端口。独立视觉评审发现并修正窄屏弹层宽度/定位，自动断言弹层≥280px且左右边界在视口内；失败后保存解除loading并可重试。实际查看中英文、桌面/窄屏截图。复用Modal、Select及按钮反馈动效，不另造设计系统；删去有效期ISO技术说明，改为本地时间控件。

## 架构同步

适用：新增凭据存储、应用授权引用、中心到root管理组件临时取密端点与认证镜像获取路径。仓库docs/system-design.md第111章与Doca同节六段文字一致；最新seq1768回读，新增8节点/8连线原生流程图端点有效。原972块及53幅原生图完整保留。见evidence/doca-readback.json。

包含新图块的初次批量请求返回500，回读确认未持久化；独立文字写入后改用s111唯一节点ID与基础原生形状保存，最终完整回读证明没有丢失或改写无关内容。

## 联合发行

用户追加指定“排查解析失败”的修复：已读取原chat并核对GitHub PR149，修正DNSPod Create/ModifyRecord的默认线路别名为“默认”，保留显式线路ID和非默认线路。按用户授权通过PR合入main，合并提交700ffd322242a77e2e971a6eebcfcd8eddf98585。该修复的SDD112和146项验收见对应目录。合并PR149后的11份联合回归217/217通过、0跳过，包含其DNSPod严格请求/回读验收。联合发行镜像、成品检查和远端摘要见下。

## 交付边界

发行阶段授权为合并和推送Docker发行；该阶段未切换生产中心或生产Agent，也未执行生产DNS写入或验证公网传播。后续追加生产发布授权与实际结果见末节。固定标签发行保留现有latest。真实隔离拉取验收与本地管理API验证不冒充生产验收。

主功能通过[PR150](https://github.com/workhold/lightmoni/pull/150)合入main，合并提交`9d22fd55dc94a47f7469e567eecaf0d30ed129af`，其历史包含PR149的`fc93fdda43a21e862fada3c9e69e8007ffb392c2`。Docker构建上下文由该合并提交git archive生成，SHA256为`b59a865316f09baae50f5100b4a404c61ca0319ec094438e0cffea003b13a391`；构建标签`20261108-registry-credentials-v1`。

## 双架构成品与远端发布

固定镜像 `docker.heyphp.com/lightmoni/lightmoni:20261108-registry-credentials-v1`，OCI索引摘要 `sha256:bae80e1bb452b955d4528773f3a2672cfe6e9e7b470edce7da625c7c7242a5d3`；支持Linux amd64/arm64。仓库根Compose已指向此标签；本次没有操作线上Compose或容器。

两架构分别运行非root成品中心、独立真实ClickHouse和SQLite，初始化管理员并验证持久会话、SDK/Agent下载及校验、任务/应用/网站/镜像源等既有行为，各57项检查通过、errors为空。直接对成品编译模块运行的仓库凭据/临时认证/DNSPod路由回归各32/32通过、0跳过；真实成品HTTP验证凭据创建、脱敏列表、空密码编辑、撤销、删除及未登录401。匹配架构内置Agent确认声明支持 `operations.platform.registry-auth.v1`。AMD64在本地Docker仿真、ARM64原生，ClickHouse为隔离ARM64服务；这不等同于生产主机部署验收。

发布只用两份已测试镜像，37份唯一blob在本地逐一SHA256验证，核对成品rootfs/config与镜像ID一致；远端逐一blob HEAD、平台manifest/config GET、固定索引GET成功。现有latest发布前后均为`sha256:1435938eacd969554e581b1cce0b996ff36ac6e1b886c9fc42e5b21e231a5a51`。保护的运行时凭据仅由系统Docker credential helper提供，未写入记录。隔离中心、ClickHouse、网络、卷与临时环境凭据均已清理。

独立执行`docker buildx imagetools inspect`回读固定标签，摘要与两平台manifest均一致。`docker compose config --quiet`在仅运行时生成的测试环境值下通过；不启动服务。发行证据JSON解析及凭据字段检查、`git diff --check`通过。

证据为evidence/release.json、build-inputs.json、两架构build/smoke.json、release-index.json及registry-report.json。中心和需要认证拉取的目标主机Agent须一并更新；未更改正在运行的应用或DNS记录。


## 生产发布追加验收（2026-11-08）

用户在发行完成后明确要求“帮我把线上的发布下”。通过既有已登录1Panel终端核对生产中心运行上一固定标签、healthy、同一状态卷且有157.4 GiB可用空间。没有更改本地原工作目录的未提交Compose或历史证据。

受保护备份位于`/opt/lightmoni/backups/sdd111-registry-credentials-20261108`：目录0700，原Compose、环境、完整inspect、主密钥和SQLite快照0600，只留在生产主机。Node SQLite backup单批完成463035页×4096字节=1896591360字节，quick_check为ok；副本大小与主密钥长度核对通过，容器内临时数据库已清理。线上固定镜像拉取成功，revision与OCI索引摘要均匹配发行记录。

首轮切换在配置保留断言中触发自动程序回退，旧版恢复healthy且公网healthz为200。诊断回读发现Env数组顺序变化、全部键值相同，其他配置一致；比较器改为先拒绝重复环境键，再比较全部键值集合，同时保留挂载、启动参数、端口、网络、安全选项等原有校验。原始和重试inspect分别保留，不覆盖备份。未修改产品镜像，也未恢复或替换数据库。

重试在签名作业空闲边界只原子替换现有Compose的中心镜像，执行既有`up -d --no-deps --no-build --pull never --wait`。新中心于21:49:02（Asia/Shanghai）启动，21:49:08回读healthy，源码`9d22fd55dc94a47f7469e567eecaf0d30ed129af`；数据卷、主密钥、环境键值、端口/网络和另外16个容器ID一致。此项“其他容器不变”是中心切换时的比对结果。新凭据表和认证能力模块存在；公网可信HTTPS的healthz与页面为200，未登录凭据接口为401。

通过既有管理员维护入口审阅并执行完整管理主机zz-bj-1的固定amd64包，操作`55250f00b710f028eff4510ab9d0eece`，构建`0.1.0-9d22fd55dc94-cb3c1e2e5e43`，包SHA256`2194a65476f5595dbbf8cb3db993fd668668fb63d4d6f66d8ff2c73ff3eb8f97`，与已验收的amd64中心镜像内目录一致。原维护记录回读“更新成功”，主机列表回读在线、完整管理、当前发行提交9d22fd55dc94。身份、配置和既有权限保留；仅监控且无SSH凭据的另一节点未更新、未新增权限。

生产镜像源页面实际显示“镜像仓库凭据”“新增仓库凭据”和空列表，未创建测试用生产账号、绑定应用或触发认证拉取。生产私有拉取的凭据设置与执行仍由用户实际配置；隔离真实拉取验收见前文。

DNSPod修复已随中心上线；网站docker.doc-a.cn当前仍提示“自动管理的记录已被外部修改，请核对后处理。”本次记录此状态，没有绕过保护、强制覆盖DNS或声称解析已经恢复。无需为本次原有拓扑下的程序发布再次修改系统架构：不新增服务、协议、存储或凭据边界，架构同步不适用；功能设计已经在PR150完成仓库第111章与Doca seq1768同步。

脱敏证据为evidence/production-backup.json、production-deployment.json、production-agent-update.json、production-http.json和production-ui.json。原生截图位于忽略目录`.local-dev/image-release-111/production-registry-credentials.png`和`production-agent-update.png`。代码与镜像未再变更；本次交付检查限定为证据JSON解析、目标版本/摘要一致性和git diff检查。
