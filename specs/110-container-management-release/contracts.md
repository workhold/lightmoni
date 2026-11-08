# 发行契约

- 仓库源revision固定`70a0060fc47581078a3a0a5ac7b921c01d58d0aa`，固定标签`docker.heyphp.com/lightmoni/lightmoni:20261108-container-management-v1`。
- OCI索引仅Linux amd64/arm64，manifest/config源码revision与测试镜像相同；Agent包元数据与源码一致。
- 新容器任务HTTP和签名回执契约沿用SDD109，不扩大本轮操作集。
- 生产只替换当前Compose中心镜像引用，更新失败恢复原配置并验证旧版健康；不删除卷、不覆盖环境或密钥。
- 凭据、完整inspect、数据库和生产清单只留受保护运行时或主机备份，不进入仓库、PR、URL和普通日志。
