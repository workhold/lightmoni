# 合入本账号PR并发布镜像与Git

2026-11-01，用户明确授权合入本账号推送的全部待合并PR并发布Docker/Git。范围为workhold/lightmoni的#37、#39、#40、#41及完成本次发行所需的发布记录PR；其他作者分支不在本次合入范围。

先集成四项功能，解决重叠并运行相关检查，分别通过GitHub PR合入main。镜像从合入后固定源码提交的git archive构建，发布到既有docker.heyphp.com/lightmoni/lightmoni，含linux/amd64及linux/arm64、固定日期/SHA标签和latest；GitHub Release绑定相同源码提交。默认Compose及部署文档更新，证据经发布PR交付，最后本地main快进同步。不得直接推送main，不自动更新既有生产容器。

架构同步：功能架构分别随原SDD/PR同步Doca并回读；本次只集成既有实现及打包发布，不增加控制路径、凭据边界、协议或拓扑，发行本身不适用新增架构改写。冲突处理必须保留Docker任务路径、安装事件投影、网站同机路由、系统仓库及鉴权能力。
