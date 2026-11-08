# 发行验收

2026-11-08，用户授权合并主分支、发布Docker、部署。功能PR [145](https://github.com/workhold/lightmoni/pull/145) 已合并，发行源码为 b9ca3b30200a527758f9c4b7e0e0fff5c8159505。

## 镜像

- 固定标签：`docker.heyphp.com/lightmoni/lightmoni:20261108-host-files-v1`。
- Linux amd64/arm64各48项发行检查通过，包含生产健康、登录、下载、回归、编译后的文件管理资源/路由和权限入口，运行用户均为lightmoni。详细项目见evidence中的两个smoke报告。
- OCI索引：`sha256:4ca13adf713b9986cdd9225f743c41faf67319755b5906079ebaa5d712cc2393`。平台manifest与全部blob已通过Registry HEAD/GET回读，源revision与测试镜像相符。
- latest前后均为`sha256:1435938eacd969554e581b1cce0b996ff36ac6e1b886c9fc42e5b21e231a5a51`，未改变。Docker凭据仅通过系统凭据助手在运行时读取。

## 备份与部署

通过既有已登录1Panel终端操作。备份目录`/opt/lightmoni/backups/sdd108-host-files-20261108`权限0700，配置、环境、主密钥、数据库及回执权限0600；完整内容留在生产主机。首次100页分批SQLite备份在持续写入下反复重启，终止该备份进程后改为大于总页数的单批备份。首次不完整文件标记为`unverified-interrupted.db`，README明确禁止用其恢复；它不构成验收依据。此重启行为符合[Node SQLite backup文档](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html)。

第二次`lightmoni-verified.db`快照已完成并通过quick_check；447892页×4096字节=1834565632字节，主机副本大小一致。更新前重新核对当前容器、备份Compose和环境未发生漂移，目标镜像为amd64、revision和Registry索引摘要一致。

只原子替换现有服务器Compose中的单个中心镜像引用；没有覆盖服务器Compose或拉取仓库配置。执行`docker compose -p lightmoni -f /opt/lightmoni/lightmoni/compose.yaml up -d --no-deps --no-build --pull never --wait --wait-timeout 180 lightmoni`。中心启动时间09:19:49 UTC，09:20:15 UTC回读healthy、revision b9ca3b3，审计表machine_file_events存在。升级过程中单实例重建曾出现一次公网502，启动后公网及主机内healthz均返回`{"status":"ok"}`。

前后逐项比对Mounts、Env、User、Entrypoint、Cmd、WorkingDir、端口绑定、网络集合、重启策略和安全选项；均一致。/data沿用`lightmoni_lightmoni-state-v2-20261103`，主密钥内容摘要一致。其他所有现有容器ID前后一致，Agent和ClickHouse没有重建。无需回滚；原Compose和环境受保护保留在备份目录。

## 生产只读UI

在独立浏览器页以现有管理员会话打开[主机页](https://moni.heyphp.com/machines)，实际点击全部容器和文件管理：容器共8个，含运行中、已停止、平台应用和外部容器；SSH/SFTP读取根目录成功，进入/etc成功，筛选并打开23字节/etc/issue成功，编辑区显示UTF-8内容及禁用的未修改保存按钮。没有保存或上传生产文件。修改、覆盖冲突和上传行为的真实SFTP/浏览器验收沿用SDD107证据。

原生界面截图保存在本工作区忽略目录`.local-dev/image-release-108/production-*.png`，避免将生产资源清单和浏览器界面信息提交仓库；脱敏结果见evidence/deployment-report.json。浏览器桥接初始化报错后改用原生Chrome操作，没有读取浏览器认证数据。

## 架构影响

本轮不适用：仅发行SDD107已同步的实现，不改变既有部署拓扑或权限。仓库架构章节和Doca在线设计的同步证据均在PR145的SDD107中；Doca链接为[LightMoni系统设计基线](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53)，该次最新版本回读seq1764，原生图块、节点与连线保留验证通过。本轮未改写在线设计。

交付记录检查：git diff --check、使用非生产占位值的docker compose config --quiet、全部证据JSON解析、双架构报告48项且零错误、备份页数与字节数一致，均通过。提交前已同步origin/main，无冲突。
