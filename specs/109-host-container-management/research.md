# 依据与取舍

- [1Panel容器](https://1panel-dev.github.io/docs/v2/user_manual/containers/container/)以列表、创建及名称进入详情组织管理，镜像由镜像页面单独准备。本轮使用本机已有精确镜像，不顺带引入仓库凭据路径。
- [1Panel磁盘占用](https://1panel-dev.github.io/docs/v2/user_manual/containers/overview/)区分镜像、容器、卷、缓存清理。用户明确要无用镜像，本轮只提供镜像候选，不扩大到卷或缓存。
- [Docker API版本历史](https://docs.docker.com/reference/api/engine/version-history/)支持images/json shared-size；沿用项目既有固定v1.43 Unix socket接口，需本地真实Docker核验。
- 普通Agent已拒绝写任务；既有docker-jobs走operations.managed.v1签名桥。新增host_docker适配器沿用该授权，不将外部容器操作混入受限container.managed.v1的资源清单。
- 现有仓库设计维护指令为repository-only；本对话用户AGENTS明确要求Doca同PR同步，遵循用户指令执行。
