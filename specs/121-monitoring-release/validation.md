# 监控修复发行验收

日期：2026-11-10。

## 合入与源码

PR #163、#164 已通过 GitHub 合入 main。固定源码 `9d86ca2d987dee64fa2867a58f0450d2514ed807`，两平台构建上下文均为该提交的 git archive；未包含本地未提交内容。架构影响不适用，理由见 spec.md。

## 成品与发布

linux/amd64 与 linux/arm64 构建均通过；每平台 9 项成品检查和 6 项直接加载编译模块的相关回归通过。检查包含非 root、revision、隔离 ClickHouse 与健康、管理员初始化/登录、内存标题/SDK 对齐资产、完整 SDK/Agent 校验和及下载。实际使用镜像内 SDK 上报，经过 HTTP Ingest/ClickHouse/成品 Executor 返回已知 histogram 均值 20，并确认普通 SQL 保持严格对齐；未以源码替换编译模块。AMD64 为本地 Docker 仿真，ARM64 原生。

固定镜像 `docker.heyphp.com/lightmoni/lightmoni:20261110-monitoring-fixes-v1`，索引 `sha256:e0a475496cf00a093b4a16abc4c52336eeeb96054581a7a8ffa7e3ada160c2e1`。本地 blob SHA、与已测镜像一致的 config/rootfs、远端 blob HEAD、平台 manifest/config GET、索引 GET 及独立 imagetools 均核对通过。latest 仍为 `sha256:1435938eacd969554e581b1cce0b996ff36ac6e1b886c9fc42e5b21e231a5a51`。

Registry 凭据仅由系统 helper 运行时读取；隔离验收服务、卷、网络及临时凭据已清理。报告见 evidence/。

## 生产状态

原有已登录 1Panel 终端已只读核对原中心健康、版本 8580eb9、数据卷与空间。配置/主密钥备份和 SQLite 固定事务快照已创建，正在完成一致性校验；此阶段尚未切换生产中心镜像。部署与线上验收结果将在成功回读后补充。
