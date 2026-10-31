# Quickstart validation

1. npm --prefix runtime run typecheck；npm --prefix web run typecheck。
2. 新增集群/应用契约测试：真实SQLite、HTTP和Agent lease，验证一机一集群、重复名、端口原子性、同集群引用、两种部署模式。
3. 按examples/cluster-demo/README.md运行专属Linux Docker QA环境，通过平台创建集群、MySQL、自定义Web和OpenResty、网站；域名本地模拟，证书自签。
4. 网站POST写入、GET读回；分别访问应用两个命名端口；重建Web再次读取，数据保留。查看应用实例、端口和配置版本。
5. 构建后生产bundle打开实际集群/应用/网站/证书/域名入口；验证创建保存、刷新读回、失败保持输入、快捷创建回填；桌面与390px、200%取证。
6. 相关Runtime回归、全仓类型与构建、git diff --check；Doca保存/回读结果写validation.md。
