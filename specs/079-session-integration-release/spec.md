# 全会话改动合入与双架构发行

日期：2026-11-02。用户授权整合所有 LightMoni 会话、通过 PR 合入 GitHub main 并推送 Docker；发现 #64 后又明确要求补齐迁移和验收后一起发布。

范围包含 #62（网站上游校验、发布/DNS与内外网服务地址）、#63（Agent 重装收尾、按来源镜像代理）、#64（独立 root 身份、统一维护/repair和普通通道收口）及后续 #65（受管业务运维、观测与旧数据接管）。历史057等价补丁已由 #42/#43 合入，不重复引入；不写 Gitea。

以最终功能 main 完整 SHA 的 git archive 构建 docker.heyphp.com/lightmoni/lightmoni 日期-SHA 固定标签和 latest，包含网页、双架构共享 Agent/执行器包与四种 SDK，支持 linux/amd64、linux/arm64。真实隔离 ClickHouse/中心验证、制品摘要、来源规则 CAS、主机服务地址、默认关闭的三类执行器能力以及两架构相同网页资源均需通过；正式包普通 Agent 无 Docker/低端口权限，root profile 与统一维护齐备。

发布须核验 OCI config/rootfs 与实际验收镜像一致，远端 index/config/manifest 回读、两架构独立拉取和历史标签原摘要保留。更新默认版本和部署文档，经发行 PR 合入并创建 GitHub Release。

授权范围为合入与发布；不自动部署用户生产中心、升级远端 Agent、授予 root 能力或迁移生产数据。旧业务按 SDD080 runbook 停机审阅接管，程序维护保留业务数据和已撤销策略。凭据只用系统存储与保护的运行文件，不进仓库、上下文或日志。

架构同步不适用：此发行仅打包既有功能；功能职责、协议、凭据、存储与拓扑已在功能 PR 的 docs/system-design.md 与 Doca 同步，最新 SDD080 读回930含原生图验证。发行记录不重复改写架构。

固定功能与打包修复源码：`ccbb85d3156f428c297422dc679cab3cc215b5dd`；发行标签：`20261102-ccbb85d`。#66 修复共享打包器的过时文件引用；失败的0437669构建没有发布。
