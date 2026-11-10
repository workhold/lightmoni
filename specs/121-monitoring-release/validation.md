# 监控修复发行验收

日期：2026-11-10。

## 合入与源码

PR #163、#164 已通过 GitHub 合入 main。固定源码 `9d86ca2d987dee64fa2867a58f0450d2514ed807`，两平台构建上下文均为该提交的 git archive；未包含本地未提交内容。架构影响不适用，理由见 spec.md。

## 成品与发布

linux/amd64 与 linux/arm64 构建均通过；每平台 9 项成品检查和 6 项直接加载编译模块的相关回归通过。检查包含非 root、revision、隔离 ClickHouse 与健康、管理员初始化/登录、内存标题/SDK 对齐资产、完整 SDK/Agent 校验和及下载。实际使用镜像内 SDK 上报，经过 HTTP Ingest/ClickHouse/成品 Executor 返回已知 histogram 均值 20，并确认普通 SQL 保持严格对齐；未以源码替换编译模块。AMD64 为本地 Docker 仿真，ARM64 原生。

固定镜像 `docker.heyphp.com/lightmoni/lightmoni:20261110-monitoring-fixes-v1`，索引 `sha256:e0a475496cf00a093b4a16abc4c52336eeeb96054581a7a8ffa7e3ada160c2e1`。本地 blob SHA、与已测镜像一致的 config/rootfs、远端 blob HEAD、平台 manifest/config GET、索引 GET 及独立 imagetools 均核对通过。latest 仍为 `sha256:1435938eacd969554e581b1cce0b996ff36ac6e1b886c9fc42e5b21e231a5a51`。

Registry 凭据仅由系统 helper 运行时读取；隔离验收服务、卷、网络及临时凭据已清理。报告见 evidence/。

## 生产部署与线上验收

2026-11-10 10:23（Asia/Shanghai），生产中心已更新为上述固定镜像，revision `9d86ca2`、amd64、容器 health=healthy。沿现有已登录 1Panel 会话完成部署；仅替换生产原 Compose 中的中心镜像。卷、环境、端口、网络、主密钥及其他容器 ID 均与原值一致；Agent 无需升级。本轮未执行 Agent 或业务容器部署。

生产主机受保护目录保留原 Compose、环境、inspect、32 字节主密钥及 SQLite 一致快照，目录 0700/文件 0600。快照 2,426,781,696 字节、592,476 页 × 4096，固定读事务在线备份耗时 453.1 秒，`quick_check=ok`。备份未离开生产主机，仓库仅收录白名单回执。

切换时公网曾返回 502/采样超时；首个记录的公网健康成功时间为 10:24:12，之后三次最终健康请求均 HTTP 200 / `{"status":"ok"}`。未连续计量精确中断时长。原镜像与生产备份保留以便回退。

使用实际已登录生产页面验收：

- 小猪绘本 / ebookn 的容器负载最近 1 小时六图均有数据；手动刷新成功；切换最近 15 分钟成功，均未出现原来的窗口边界报错。
- SDK 标签的 `metric_ebookn_histogram / http.request.count` 图及均值/样本数表格正常显示。使用生产真实采集数据，未替换响应。
- zsw-bj-1 单机内存图标题显示“内存 · 总内存 15.2 GiB”，与当前容量摘要一致；原三条内存曲线保留。
- 重新打开容器监控最近 15 分钟仍有数据，采集状态正常。

脱敏回执见 evidence/production-{backup,deployment,health,ui}.json。截图/完整 AX 留在本地忽略目录 `artifacts/screenshots/specs/121-monitoring-release/evidence/`，不将生产日志正文、配置、数据库或密钥提交仓库。浏览器扩展接口本轮不可用，改用 CUA 原生 Chrome 完成页面操作与截图。

发行证据通过 GitHub PR #165 合入；该 PR 只记录发行结果，不改变已部署运行源码，无需重建镜像。架构影响不适用：部署拓扑、协议、凭据边界与存储未变化。
