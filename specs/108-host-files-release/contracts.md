# 交付契约

代码PR：https://github.com/workhold/lightmoni/pull/145；源提交b9ca3b30200a527758f9c4b7e0e0fff5c8159505。
镜像：docker.heyphp.com/lightmoni/lightmoni:20261108-host-files-v1，Linux amd64/arm64，org.opencontainers.image.revision必须等于源提交；运行用户lightmoni。
不改变HTTP/API、SSH/SFTP协议、数据卷、部署拓扑和权限；文件能力契约引用SDD107。生产写入范围只有中心镜像升级、同一主机的受保护备份及Compose镜像引用，不包含业务容器、Agent、ClickHouse或文件内容修改。
成功必须具有Registry回读、受保护备份核验、运行时revision/health/mounts以及实际线上UI观察证据；构建/发布/排队不等于部署完成。
