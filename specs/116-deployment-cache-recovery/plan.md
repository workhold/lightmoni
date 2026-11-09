# 设计

1. preparePlatformImages 的认证分支先校验冻结镜像授权，再使用已有 prepareCachedImages；缓存命中保留 cluster-registry/cluster-cache 来源及验证后的 ID，且不领取账号密码。缓存不可用时遵循 allow_upstream，回退原仓库认证；匿名来源代理不处理认证镜像。
2. PrivilegedExecutorStore.reconcile 在原 executor/install_generation/lease 匹配后，检查冻结 managed 平台载荷及摘要、单一 operations 动作、operation=inspect 与明确只读 task 白名单。仅对未人工解决的 unknown 原记录设置自动核对时间、执行器身份和固定原因，沿用 task_runs/agent-job-fence 的既有已核对释放语义，保留 unknown 与失败历史。
3. 旧执行器本身已有签名 reconcile 与本机锁释放逻辑，不新增可执行许可；真正未知变更仍不能释放。通过旧执行器同形请求验证中心端兼容，并测试新观察/多应用健康恢复、不重放历史任务。
4. 为缓存命中、回源、禁回源、损坏内容、刷新、多镜像与秘密隔离，以及中心/执行器重建、错误身份/租约、伪造类型、未知写入门禁增加回归。记录类型检查和相关测试，不用伪造线上部署结果代替验收。
5. 同步两份架构设计，保存最新版本回读的目标文本、原生图节点与连线核对结果，提交面向 main 的 PR。
6. 按追加授权合并本会话的端口修复与部署恢复修复；从合并主干构建双架构成品并通过隔离启动/下载/产品模块验收，固定标签发布。生产保留环境、主密钥、数据卷及其他容器，先备份再只更新中心镜像；原身份维护升级目标 Agent/helper 后重跑真实 Web 应用，记录健康和镜像来源。
