# 联合发行验收

## 发行输入与合入

本轮用户授权检查全部未合并PR、合入、发布Docker并上线。开始时开放PR只有[#155](https://github.com/workhold/lightmoni/pull/155)与[#160](https://github.com/workhold/lightmoni/pull/160)，已依次通过GitHub合入。联合源码相关Runtime测试77项、根类型检查均通过。

构建期间第三方npm镜像500，官方源下载也较慢。通过[#161](https://github.com/workhold/lightmoni/pull/161)修复唯一YAML tarball的同版本/同integrity官方地址，并使用不进入成品层的BuildKit缓存。只预热锁文件中摘要匹配的公开tarball与固定Node归档；无凭据或Registry元数据进入缓存导入。Dockerfile检查无警告，SDK离线缓存安装通过。

最终运行源码固定为`8580eb95974e14bec1ef7db4aaee57a9ce5eb6a6`；构建上下文是该提交的`git archive`，没有纳入原工作目录的未提交内容。发行证据PR仅补充文档，不改变此源码身份。

架构影响：不适用。发行SDD114/117的既有设计及构建缓存维护，不改变运行协议、权限、存储或部署拓扑。系统设计第117章与Doca同步见SDD117已保存并回读的证据，本次不重复改写原生图块。

## 成品验证

两个平台均使用同一源码，Node为固定24.15.0并校验官方SHASUMS。arm64原生执行；amd64在本地Docker仿真执行，ClickHouse为隔离26.8。测试使用临时数据库/网络/随机凭据，成品编译模块配合当前源码测试夹具，不替换为工作目录模块。

验收包含备份下载字节/SHA/管理员边界与no-store、原生系统监控和空自定义仪表盘、PostgreSQL显式身份字段与密码脱敏、主机容量校验、会话和计划任务授权、容器批量契约，以及SDK/Agent下载、统一维护解析器、普通账户和root边界、Registry凭据、DNS/CNAME与容器管理既有回归。

两个平台各63项成品检查均通过，编译产物回归每平台285项全过；详见`evidence/smoke-summary.json`及各平台报告。验收结束后已删除专用容器、数据卷、网络和临时环境凭据。外部DNS/Agent回执使用合成测试数据，不声称实改第三方业务或生产应用。

测试驱动初次使用错误的单数`schedules`文件名，随后补齐`domain-jobs`夹具路径；修正的是隔离加载器，产品镜像未改变。

## 生产备份

通过原有1Panel已登录终端在主机root私有目录保存原Compose、环境、容器inspect、32字节主密钥和一致SQLite快照。目录0700、文件0600，未将配置或密钥复制到仓库/本机。

首个Node在线拷贝360秒超时，未视为完成。随后从同一Docker卷用Python SQLite固定读事务执行在线备份，复制553308页约16.2秒；独立`quick_check=ok`，页面4096字节，总2266349568字节。完整结果由生产`backup-report.json`只读显示核对，见`evidence/production-backup.json`。

## Docker发布

固定镜像`docker.heyphp.com/lightmoni/lightmoni:20261109-deployment-followups-v1`，OCI索引摘要`sha256:039cc6c7aa440cce047fb960000a367a08fa156efb7fde8ed9554f80a7f935ea`。包含linux/amd64与linux/arm64；本地所有blob摘要、成品测试image的config/rootfs、远端blob HEAD、平台manifest/config GET及固定索引GET全部核对。独立`docker buildx imagetools inspect`确认索引平台。

`latest`发布前后均为`sha256:1435938eacd969554e581b1cce0b996ff36ac6e1b886c9fc42e5b21e231a5a51`。Registry认证仅由已有系统凭据助手在运行时读取，不进入脚本或日志。

## 生产中心验收

生产主机预拉取固定标签后回读索引摘要一致，确认amd64及源码revision。独立维护脚本在无queued/running签名任务时仅更新中心服务，`--no-deps --no-build --pull never --wait`。2026-11-09 16:01:11 UTC回执为deployed/healthy，启动16:00:40 UTC；保留原数据卷、全部环境值、端口/网络、安全配置和主密钥，其他容器ID未变，新增模块和备份工具SHA均匹配。

单中心重建期间公网短暂HTTP错误，随后健康接口200/ok；未宣称零停机。管理员原会话仍有效，实际浏览器核对`/system/backups`工具SHA与成品一致，`/system/monitoring`的中心指标、收件记录和日志正常展示。见`evidence/production-deployment.json`、公网采样及忽略目录中的生产截图。

## Agent维护与限制

沿实际管理员维护入口为`zsw-bj-1`生成并审阅固定计划：原版本40916db5a49c，目标8580eb95974e，amd64包SHA256 `68a7fc8125757d2aa1e74b76d7b7371f8d459b53b1dcb3bda6506df5c2284f56`，与已发布中心内Agent目录一致。操作`2e4b6145833d1ec64bbe90953412694c`于16:56:39 UTC成功，保留Agent身份、root管理模式和权限代次1，普通进程仍为uid999。实际心跳已上报8 CPU/15614.234375 MiB；通过当前受信签名观测校验器确认helper同源码、management_version=1、batch_management_version=1、policy_generation=1。

`zz-bj-1`生成计划时被现有特权排队任务阻止，之后刷新入口仍被待派发/运行中/未知任务锁定；未生成或执行其升级计划，未取消、重放或修改业务任务，保留40916db5a49c。`vchive`是无可复用SSH凭据的仅监控节点，保留790cca58456a；未新增凭据或扩大权限。两台暂不具备新版容量/批量能力，不声称全节点升级。

生产核对脚本只读SQLite；签名观测解密仅在现有中心容器内读取原受保护主密钥，输出限定版本、代次和能力标记。首次核对辅助SQL误用Agent队列表的payload列名，修正为平台运行记录的关联字段后读取成功；没有改变生产Schema或任务数据。

## 发行记录

脱敏验收记录通过[PR162](https://github.com/workhold/lightmoni/pull/162)提交main；GitHub的合入回执是该文档PR最终状态的权威记录。此PR仅补充证据，已发布镜像源码保持8580eb9。最后核对全部JSON与源码/摘要/平台一致、差异无空白错误、公网healthz=200/ok；未为文档变更重跑产品测试。
