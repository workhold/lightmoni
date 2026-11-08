# CNAME 厂商回读等价比较

## 现场与目标

网站已发布，DNSPod 已创建 `docker.doc-a.cn` 的默认线路 CNAME。线上托管域名记录抽屉显示值为 `edge-49b2209ee4168ec9.doc-a.cn.`、TTL 600、已启用；网站期望入口为 `edge-49b2209ee4168ec9.doc-a.cn`。现有归属身份逐字比较 value，将末尾根标签点误判为 `dns_owned_record_modified_externally`。

## 验收要求

- CNAME 目标比较统一为 ASCII 小写且末尾带点的形式，兼容厂商有时返回点、有时不返回点，覆盖归属保护、外部记录识别、更新、最终验证及人工 DNS CRUD 的回读。
- 已有 verifying/applied 归属记录直接恢复，保持 Record ID，不删除、重建或接管外部记录。
- 真正修改目标、线路、TTL 或已声明权重时继续保护；未知写入保护不变。
- TXT 内容保持逐字比较，不能因 CNAME 的规则改变大小写或末尾点含义。
- 厂商原始记录值继续原样展示，不需要数据库迁移或修改线上归属日志。

## 架构影响

不适用：修正既有 CNAME 身份比较的 DNS 等价语义，组件职责、控制路径、厂商协议、存储格式、凭据边界、部署拓扑不变；仓库系统设计及 Doca 在线设计无需修改。

## 合并、发版与部署追加

用户授权“合并部署发版”：通过 GitHub PR 合入 main，以固定合并提交构建并验收 Linux amd64/arm64 镜像，发布固定 Docker 标签与 GitHub Release。备份生产 Compose、环境、主密钥和 SQLite，保留原权限后仅更新中心镜像，核对健康、运行配置和其他容器，回读网站 DNS 状态与厂商记录。DNS 修复在中心执行，已有 Agent 无需为本次修复重启。

发行范围收敛：本次是中心 DNS 补丁。固定镜像内的 Agent/SDK 捆绑制品仍完成验收；GitHub 附件仅发布已完整上传并验证 SHA256 的 4 个 SDK 包及 SDK_SHA256SUMS，不提供新的独立 Agent/安装器附件，不切换 GitHub 既有 latest Agent 发行入口。大包上传未完成时不得发布其 starter 条目或声称发布成功。
