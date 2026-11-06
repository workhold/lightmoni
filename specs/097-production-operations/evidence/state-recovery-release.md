# 状态修正版固定发行

- 功能 PR：[#107](https://github.com/workhold/lightmoni/pull/107)，合入源码 `81f3c473a4b5ca69817053b531fb4d6e4d5eed9a`。
- GitHub 测试发行：[20261106-agent-recovery-81f3c47](https://github.com/workhold/lightmoni/releases/tag/20261106-agent-recovery-81f3c47)。
- Docker：`docker.heyphp.com/lightmoni/lightmoni:20261106-agent-recovery-81f3c47`。
- OCI 多架构摘要：`sha256:355548f753e42a200022c60d93a891bc694f7fe8c9c616d7e573c2c9db0b2c3a`。
- amd64：`sha256:3a6794e761dc77cf3c32d493df3a29301cc687bd8dac3f3e98d1b58725f696f2`。
- arm64：`sha256:5c9aef69f1522563816443b84cb1170ca35d0889550ce8a278888c4557c515c9`。
- 稳定 latest 保持不变。配套 Agent/SDK 包在镜像和中心下载路径内，GitHub 附件为小型验收报告，避免重复上传历史已超时的大包。

## 成品检查

双架构均从固定 Git 归档构建，各通过 48 项检查。包含 rootless 中心、实际 ClickHouse、编译后恢复及对账测试、Agent 双架构包摘要、四语言 SDK 下载、真实 TypeScript SDK 入库、25 条内置大盘经正式 HTTP SQL 路径查询和会话重启。

每架构编译后目标状态回归 165 项：164 通过，1 项既有可选 Docker 证书 QA 跳过。另有本地接口及维护相关回归 298 项全部通过，最终新增恢复接口 6 项全部通过。没有把夹具回执当成远端执行。

首次 amd64 隔离检查复用了 arm64 ClickHouse 用户，因两个临时中心的随机主密钥不同而出现只读用户凭据冲突。销毁本轮临时测试库、重新建立隔离库后完整重跑 48 项全部通过；未改生产凭据或用户。

发布前校验所有 OCI blob SHA256、平台修订、与实测成品的 Config/RootFS；发布后读取固定索引及配置，并将两架构按摘要回拉，Config/RootFS 完全一致。详情见本目录 state-recovery-* JSON。

## 架构影响

本次发行锁定版本及补充证据，不增加架构变化；状态修正的控制路径已随功能 PR 更新 docs/system-design.md 第 97 节。设计仅维护仓库本地文档，不要求在线同步。

## 线上更新

通过既有 1Panel 容器编辑流程指定固定镜像，保留 `lightmoni_lightmoni-state-v2-2:/data` 和端口/网络。最终镜像、健康与恢复回执继续记录于 live-matrix.md。
