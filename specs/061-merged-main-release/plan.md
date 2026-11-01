# 发行计划

使用已安装依赖的059工作树集成最新main与#37/#39/#40，保留原PR提交；先运行runtime全量测试、runtime/web类型与构建，并验证发生冲突的功能。依次合入原PR，059分支吸收main并完成最后集成，所有main写入通过GitHub PR。

源码固定后，用既有deploy/server/Dockerfile、本机Docker Desktop和上一版已验证的发布/验收脚本构建双平台。保持npm integrity、Node SHA256和Debian签名验证。隔离ClickHouse/中心容器、网络和卷完成启动、登录、下载、功能API和打包Agent能力检查；凭据仅在运行时受保护文件或Docker credential helper内提供。

远端固定标签不覆盖不同内容，更新latest前检查并发变化。独立Docker客户端回读索引/平台摘要并按平台重新拉取，与已验收image ID和源码revision核对。GitHub Release绑定镜像源码，随后配置/证据PR仅更新默认引用及发行记录。验证结束清理自己的测试资源，保留历史镜像标签。
