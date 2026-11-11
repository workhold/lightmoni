# 调查结论

上一版解决了固定 systemd 覆盖目录残留；本次新安装的远端服务已经启动并持续心跳，属于不同问题。安装 apply 源码的单次即时检查存在异步就绪竞态，且 post-dispatch catch 丢失非 remoteFailure 原因。历史记录没有保存原始异常，不能把该竞态写成已证明的当次唯一根因。

其他节点分开记录：zsw-bj-1、vchive 在只读 SSH 核对时缺少 /opt/lightmoni-agent 和服务单元，配置与身份保留；vchive 平台维护记录 unknown 且旧回执 waiting_confirmation。现有证据不能判断程序由何操作移除，不将它们描述为同一次首装竞态。
