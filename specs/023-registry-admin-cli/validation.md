# SDD 023：验收记录

## 设计同步

仓库 `docs/system-design.md` §20.1/20.4 已更新默认 Compose 部署和本机管理员运维边界。

[Doca 系统设计基线](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53) 保存返回 `saved: true`，seq 从 309 升至 310；随后从最新版本完整回读 §20.1 的命令/正文和新增 §20.4 的标题/两段正文，均与写入一致。

5 个既有原生流程图逐块完整读取前后内容（均无分页剩余），JSON 内容逐字一致；节点/连线数量分别为 10/8、10/9、8/7、10/11、10/10。没有重建原图或修改无关内容，没有声称浏览器视觉验收。

## 已验证

- 两种 Compose 均包含中心/ClickHouse、固定注册表镜像、共享账号密码变量、健康依赖和原有两个命名卷，ClickHouse 没有宿主映射端口；缺少数据库密码拒绝配置。
- runtime TypeScript 检查与编译通过；管理员 CLI/现有账户/旧 Go 数据兼容与核心认证的定向测试通过。
- CLI 子进程覆盖空库初始化、拒绝重复初始化、bcrypt 网页登录、旧密码拒绝、目标会话撤销/其他会话保留、目标 ID/角色/启用状态/主密钥保留、非法输入/UTF-8/72 字节边界、未知用户/成员拒绝和并发初始化唯一性。
- 强制 session 删除失败验证密码/会话事务整体回滚；真实 PTY 验证两次密码输入不回显并成功创建管理员。
- 修复首次 WAL 转换锁竞争后，连续 20 轮双进程初始化仅创建一个管理员。
- 完整 runtime 测试：321 项，304 通过、17 跳过、0 失败（跳过项依赖显式外部验收环境）。

## 双架构容器验收

在 Docker Desktop Linux arm64 宿主执行；arm64 原生运行，amd64 通过模拟执行，随附 ClickHouse 使用宿主架构。构建从干净 Git archive 取源，强制解析官方多架构基础镜像索引，最终镜像的 OCI revision 均为 `7b55205f0b573ed0f289e088d4a8a8fe7dfea999`。后续提交仅补充验收文档与证据。

两种架构使用独立 Compose 项目和新建的两个数据卷，均验证：

- 中心启动前以标准输入初始化管理员，不启动 ClickHouse/HTTP；中心与数据库随后达到健康状态。
- 容器 Node 实际 `process.arch` 分别为 `arm64`/`x64`，运行 UID 均为 10001；网页首页及其引用静态资源可读，管理员登录及重复网页初始化保护正常。
- 4 种 SDK 与 2 个 Agent 包下载后逐一核对 SHA256。
- 通过有效 SDK Key 将真实 OTLP 日志写入 ClickHouse，再由只读 Query API 查询确认。
- 在线重置密码后旧密码/旧登录 cookie 被拒绝，新密码成功登录。
- 强制重新创建中心容器后，管理员 ID、新密码、主密钥摘要及 ClickHouse 日志均保留。

跨架构验收 override 显式设置 `platform` 并清除 `build`，验证已打包镜像；这避免宿主 Compose 在本地平台检查时意外进入源码构建。验收完成后只清理本次隔离项目及新建卷，既有 `lightmoni-acceptance` 的服务、管理员和数据卷未修改。

机器记录：[container-report.json](../../docs/evidence/registry-admin-cli/container-report.json)、[Doca 回读记录](../../docs/evidence/registry-admin-cli/doca-sync.json)。

## 注册表发布

发布仓库为 `docker.heyphp.com/lightmoni/lightmoni`。普通 Docker push 遇到 HTTP 413 请求体限制，改为 OCI Distribution API 的 512 KiB 分块上传，复用受保护的 Docker 运行时凭据；凭据与上传会话 URL 不进入仓库或证据。

固定标签 `20261026-admin` 和 `latest` 已发布并分别回读，index digest 均为 `sha256:51ebf2093ec5e604dc0a6e0f5b6a231caed9e85a2476edb05d37adb00cd72826`。两个标签都包含 Linux amd64/arm64 及相应构建证明，远端原始 manifest SHA256 与本地已验收镜像一致。详细记录：[registry-report.json](../../docs/evidence/registry-admin-cli/registry-report.json)。

独立使用 Docker CLI `buildx imagetools inspect` 核对两个标签的 digest 与平台，再分别执行 `docker pull --platform linux/amd64` 和 `docker pull --platform linux/arm64`，均成功。
