# 测试夹具

`forbidden-privileged-agent.service` 是刻意带有 Docker 组和额外能力的无效普通 Agent unit。它仅用于隔离的拒绝测试，从不安装到宿主 systemd。

其余 TypeScript 夹具使用当前领域存储和协议，写入临时目录或隔离 Docker 实例。
