# 发行计划

1. 检查两 PR 头提交/合并状态，通过 GitHub 依次合入并固定源码 revision。
2. git archive 构建上下文；复用 SDD118 已验证的双平台构建与缓存，不携带工作区未提交文件或凭据。按变更运行编译成品回归/查询与前端资产检查，验证健康/登录/下载。
3. 系统凭据助手运行时读取 Registry 凭据，发布固定标签并回读两平台索引和 blob；保持 latest。
4. 沿现有生产管理会话核对当前中心，root 私有目录备份 Compose/.env/inspect/master.key 与固定读事务 SQLite 快照；quick_check=ok。
5. 拉取核对摘要/revision，在无 queued/running 签名任务的边界仅更新中心服务，保留卷、环境、端口、网络和其他容器；失败恢复原 Compose 引用。
6. 公网健康/已登录管理员页面验证容器与 SDK 查询无窗口报错，单机图显示总内存；脱敏证据通过本分支 PR 提交并合入。
