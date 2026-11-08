# 发行计划

1. 经PR合入142和147，保留SDD109未完成浏览器验收记录；同步main后运行类型检查及相关回归。
2. 从固定main提交git archive构建amd64/arm64，使用已有镜像源缓存但保留TLS、integrity和签名校验。
3. 使用隔离SQLite、ClickHouse、随机管理员凭据验收两架构；核对编译后的新动作、签名桥和Agent包。
4. 从系统凭据助手运行时读取Registry凭据，发布固定标签并回读索引、manifest、blob；不更改latest。
5. 经已登录的1Panel生产终端备份Compose、环境、主密钥、完整inspect及一致SQLite快照，目录0700/文件0600；只输出脱敏验收结果。
6. 拉取固定标签并核对digest/revision，原子更新现有Compose单个中心镜像引用；失败恢复原引用，只重建中心服务。
7. 核对健康、线上入口、版本和兼容字段，记录Agent实际能力范围，提交发行PR并按授权合入main。
