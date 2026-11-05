# 验收（2026-11-04）

已完成规格、设计、契约和实现。相关回归 227 项：222 通过、0 失败、5 项 Docker-live 因未启用真实 Docker 环境跳过。runtime 类型检查与 web 生产构建通过，浏览器真实表单/API/SQLite 保存回读通过，无页面异常。

核心证据覆盖：4分钟失联保持服务发现及网站/入口DNS；三副本60%保留两成员；集群预算隔离；中心控制器重建后不重新加入已撤成员；替换失败/unknown不切换；显式重试；100%单副本先启动替换；原地更新撤流/排空后才派发；旧实例等网关确认再停止；HTTP状态码、超时及容器fallback；旧Agent能力拒绝。

架构影响适用：实例持久字段、调度/流量路径、健康检查签名配置与Agent能力变化。仓库 `docs/system-design.md` 第93章与 [Doca](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53) 已同步保存，最新seq1738逐块回读标题、5段正文、8节点9连线均匹配；原文前200块和原生图预览保持一致，原有块未被改写/删除。详见 `evidence/doca-readback.json`。

兼容：旧应用缺省5分钟/60%；HTTP缺省成功码从200–399收紧到200，可显式配置其他状态码。配置健康检查的作业要求Agent支持 `operations.platform.readiness.v1`，中心和Agent需配套升级。受保护地址不保证机器实际存活，界面区分确认ready和保留成员。无额外容量时保留旧实例并显示等待；有状态数据不自动跨机迁移。

未执行生产部署或真实云DNS修改；Docker-live运行仍待具备环境的发布验收。完整命令和检查见 `evidence/verification.json`，表单证据见 `evidence/browser.json`。
