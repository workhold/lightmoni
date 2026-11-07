# 统一发行验收

2026-11-07。功能 PR129、PR130 的全部提交通过集成 PR131 合入 main，源码 `94bcbbcdede2ee9084345438080d64bae6cc1ca5`。冲突处理同时保留 storage.v2 与 registry.v1 能力、派发要求、两组平台测试及架构章节。

## 源码检查

- Runtime、AI、Web 类型检查与完整构建通过。
- 255项相关回归：250通过、0失败、5项环境条件跳过，未将跳过算作成功。
- 存储 UI 夹具通过，覆盖中英文、桌面/390px、真实格式目录、无回执、失败重试与202离线删除进度；镜像版本 UI 连续三轮通过。上述夹具不冒充线上宿主验收。
- 实际双架构 Agent 包完整性、ELF架构、便携依赖、版本及配置检查通过。旧 release-live 测试仍写入已废弃 key 字段，改为现行 control_credential/data_credential 测试值后2项全部通过；不改变运行时凭据行为。

## Docker 成品

固定版本：`docker.heyphp.com/lightmoni/lightmoni:20261107-storage-registry-94bcbbc`，Linux amd64/arm64。依赖及生产源码来自 main；后续测试夹具修正不改变生产代码。源码 revision 标签与内置 Agent 发布元数据核对。

默认源大文件下载超时后，使用仓库现有 build args 切换 npm/Node镜像及清华Debian镜像。保留npm integrity、官方Node校验和、Debian签名与TLS证书检查。slim基础镜像尚无CA时，Debian使用其既有HTTP签名引导方式；没有关闭证书验证。

每个架构45项成品检查通过，使用独立真实ClickHouse、中心HTTP与管理员会话，覆盖SDK数据写入查询、下载与校验和、Agent本机架构执行、维护解包器、能力、重启会话保留。各架构额外在成品编译代码上运行84项平台回归和7项镜像扫描/清理协议回归；其他原有受管作业、Docker安装与SDK校验亦通过。临时中心、数据库、数据卷和运行时测试凭据已清理。

直接推送的大层被现有OpenResty限制返回413；使用既有分块发布器对OCI内容逐块校验并以512KiB PATCH上传，完成前不切换线上镜像。远端固定索引、双平台manifest/config与所有blob需核验，latest保持原值。摘要与回拉证明记录在evidence中。

## 架构

整合与发行自身不适用，无额外架构变化。保留仓库第99/100节及两个功能SDD的Doca最新回读证据；第100节新原生图接口失败的限制仍如实保留。Doca链接：https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53。

## 线上

目标为用户指定1Panel终端与moni.heyphp.com。现有Compose目录`/opt/lightmoni/lightmoni`是部署配置目录，不是Git检出；仅替换对应固定镜像，保留现有环境、项目、端口与数据卷。部署配置、主密钥及SQLite复制到`/opt/lightmoni/backups/sdd101-20261107`并限制权限，备份完整性、最终部署和浏览器结果继续记录，未核实项不标成功。
