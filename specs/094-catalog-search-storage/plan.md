# 设计

复用 runtime/src/ops/catalog 的 define/parameters/compose 构建器，在 search-storage.ts 注册三个单服务配方，在 firecrawl.ts 构建完整多服务配方。复用现有加密、端口覆盖、Agent 渲染和就绪机制，不新增依赖。分类追加 search / storage，分别提供中英文名称，数量由目录计算。

SearXNG 使用镜像原生入口，受控启动脚本写入不含秘密的固定设置，SEARXNG_SECRET 通过环境覆盖；持久配置和缓存隔离。Firecrawl 镜像须经 registry 清单验证，依赖使用同源固定摘要；数据库使用 postgres 默认库以匹配 pg_cron。内部依赖不发布宿主端口，缓存/队列/数据库卷按项目隔离；使用内部随机十六进制凭据避免 URL 编码歧义。RustFS 原生非 root 镜像目录拥有者由镜像保留，不用宿主 bind mount。

Logo 从官方或已有可信图集的固定修订获取，随前端打包，记录哈希和许可，不引入运行时图片请求。更新当前通用验收脚本中的数量/分类，历史 SDD 证据不回写。

验证顺序：参数/秘密/依赖/端口单元与实际 HTTP 安装回归 → Agent manifest 的 Compose config → 官方镜像启动和最小业务冒烟 → 中英文/深浅/窄屏商城与表单 → 类型与构建检查 → Doca 最新版回读 → 同步 origin/main 并提交功能 PR。
