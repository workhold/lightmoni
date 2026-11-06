# 降权兼容修复版发行

[PR #110](https://github.com/workhold/lightmoni/pull/110) 已合入，固定源码 `fa049fd26e4193349113e2f07a340aa9ee6dfae8`。发行：[20261106-capability-fa049fd](https://github.com/workhold/lightmoni/releases/tag/20261106-capability-fa049fd)。Docker：`docker.heyphp.com/lightmoni/lightmoni:20261106-capability-fa049fd`。

多架构索引 `sha256:82233af11b33fdf2036e5d7e375c4f2f76724a68a66ccff17a050add27b147a4`；amd64 `sha256:a56f0bb4156a3d2d6ecccef44aba1f2af2807378e7155a4fa9f0fbc52c8302ce`；arm64 `sha256:4fe96a9cf66b8df8b75b30dbdd2d684a40e44c6b4011062e6d8f515d4da73a5d`。稳定 latest 保持不变。每种架构都已按摘要回拉，Config/RootFS 与检查成品完全一致。

## 检查

双架构各 49 项通过，0 错误。包含同版 Agent 和 SDK 包下载/摘要、实际 TypeScript SDK 入库、25 条内置大盘正式 HTTP/ClickHouse 查询、重启会话，以及新增的 Linux 真实普通任务执行：专用非 root UID/GID、空附加组、NNP=1、五种能力集合全零，1 项通过、0 跳过。编译后对账/维护/恢复/能力参数等 169 项：168 通过，1 项既有可选 Docker 证书 QA 跳过。两架构使用独立的临时 ClickHouse，所有随机运行凭据只存受保护的临时文件。

## 线上恢复与大盘

新独立状态修正已再处理一次已回滚首装：即使部署、升级、卸载及 SSH 恢复卸载均因首装 unknown 禁用，仍可只读核对、审阅并执行恢复。该次只处理安装 abb0c9e13054c6275af223a002eef33c 一条记录，页面成功回执显示数据保留，主机恢复“已移除/上次操作已人工结束”和部署入口。原 unknown 保留，不改成成功。身份文件缺失的回滚场景使用精确 SSH 目标和中心绑定核查；业务数据与三个容器保持。

自定义大盘 [SDD097 - Center verification](https://moni.heyphp.com/dashboards/c4e18a54-0438-47a3-88d9-9f761b82c970) 已从上报中心内置大盘另存为独立副本，保存并刷新页面回读同一 ID、标题及 13 个面板。日志面板显示实际启动日志 2026-11-06T00:06:59.588Z。近一小时中心运行/堆指标仍为空，未将此描述为持续采集通过，继续并入 T007/T013 核查。

## 更新与架构

2026-11-06 08:32:57 CST，通过 1Panel 发起更新，保留原 `lightmoni_lightmoni-state-v2-20261103:/data`、端口和网络。实际更新及重新安装结果继续记录 live-matrix.md。

架构影响不适用：本次只固定已合入的发行版本和补充证据；执行参数及诊断设计已在 PR #110 更新 docs/system-design.md 第 97 节。设计只维护仓库本地版本。更新中心不会自动更新机器 Agent。

1Panel 于 08:35:13 CST 报告更新成功。随后实查固定镜像标签、源码 fa049fd26e4193349113e2f07a340aa9ee6dfae8、索引摘要 82233af1…、healthy 和原 /data 数据卷均一致。
