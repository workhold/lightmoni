# 私有镜像管理首版验收

2026-11-01，分支codex/059-service-image-lifecycle。没有部署生产资源或修改宿主Docker daemon设置。

- Runtime相关领域/HTTP/Agent/编译回归：107项，106通过，0失败，1项既有证书双Agent Docker验收默认跳过；该跳过项不是本次私库验收。覆盖系统身份/旧OpenResty迁移、普通仓库共存、集群开关及忙碌/派发失败重试、单一发布源、只写密码、能力守卫、载荷领取时策略变化、摘要/重定向/取消/清理故障注入。
- Runtime与web TypeScript检查通过，SDK及runtime构建通过。测试命令：在runtime执行`node --import tsx --test --test-concurrency=1 test/platform-store.test.ts test/platform-clusters.test.ts test/platform-image-cache.test.ts test/platform-registry-auth.test.ts test/platform-nginx.test.ts test/platform-executor.test.ts test/platform-reconcile.test.ts test/platform-workloads.test.ts test/platform-website-routing.test.ts test/platform-api.test.ts test/platform-default-tasks.test.ts`。
- [Docker 27隔离daemon验收](docker-live-isolated.json)：8项真实协议检查通过，包含Docker TLS login/push、私库直拉、代理断源命中、摘要校验后Docker导入及Compose启动、OpenResty全站/路径鉴权、HTTP跳转HTTPS、Authorization不传上游、临时目录清理。隔离daemon只信任QA证书，不连接生产socket；嵌套daemon仍在同一物理宿主，不代表多地域故障恢复。
- [Docker 29 containerd兼容验收](docker-live.json)：真实镜像导入、启动及OpenResty验证通过；不把Docker image ID等同于config digest。摘要错误/重定向故障来自HTTP协议注入测试，未破坏真实仓库存储。
- [浏览器三轮报告](ui/report.json)：真实SQLite/HTTP控制器；安装/刷新/两个缓存入口、真实revision冲突保留输入、HTTPS网站及账号关联、全站/路径表单、200%/390窄屏/reduced-motion均通过，无页面错误。QA无在线Agent，图中的“等待应用”不等于已运行。截图及录屏遵循仓库规则保存在artifacts/screenshots/，不提交媒体。
- [Doca保存与最新回读](doca-readback-implementation.json)：系统设计第59.7—59.9与首版一致；15处目标文字、原生仓库图10节点/10连线核对通过，597处无关块及其他29个原生图完整保留。完整路线原生图保留为后续设计。

已知边界：可信内网匿名端点包含push权限；没有repository级RBAC。缓存容器初始化仍依赖上游可达；只验证进程持续运行时的断源命中，不承诺断网重启。新Agent镜像桥支持Docker schema2/OCI及gzip/未压缩层，其他格式按回源策略处理。源集群/机器/IP固定；数据迁移、跨库复制、发布版本/预热/自动更新及daemon代理配置仍在roadmap-tasks.md。
