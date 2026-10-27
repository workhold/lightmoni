# SDD 024：Agent 安装后的非 root 启动修复

- 日期：2026-10-27
- 分支：`fix/agent-install-runtime-permissions`，基于最新 `origin/main`。
- 问题：安装脚本 `umask 077` 后使用 `cp -R`，新建 runtime 的目录/可执行文件变为 root-only 0700、普通 JS 文件为 0600；后续 `chmod go-w` 不补读/遍历权限。临时 root 配置检查成功不能证明 systemd 专用用户能读取最终发行文件。截图只显示安装回滚，无法单凭截图确定该机器全部失败原因。

## 需求与验收

1. 保留非 root `lightmoni-agent` 服务用户，不用 root 运行或放宽配置/身份/队列目录。安装后的发行目录与普通运行文件应为其他用户可读/可遍历、不可写，保留所需执行位；受限 umask 不得让服务无法启动。
2. 区分 `restart` 失败和启动观察失败。启动观察最多 10 次，间隔 1 秒，要求连续两次 active；不把启动瞬间的 inactive/activating 判为立即失败，也不把一次短暂 active 当持久成功。此观察只证明本机进程，不能代表中心可达、任务已应用或遥测入库。
3. 启动失败时，在 stop/恢复旧 unit 前显示固定失败阶段、systemd LoadState/ActiveState/SubState/Result/ExecMainCode/ExecMainStatus 与本机 journalctl 检查命令，不自动输出 journal、命令行、配置、环境或凭据。诊断不可阻止回滚，缺少 systemctl show 也必须继续恢复。
4. 失败继续恢复先前 launcher/config/unit/current/identity、启用与活跃状态；保留已有队列和游标。不自动重试 enrollment、不操作用户远端主机。

## 镜像交付追加需求（2026-10-27）

用户授权重新制作中心镜像并发布至既有 `docker.heyphp.com/lightmoni/lightmoni`。新增固定标签 `20261027-agent-install` 并更新 `latest`，保留此前固定版本供回退。本次仅发布镜像，不替换线上平台正在运行的容器。

发布必须包含 Linux amd64/arm64，两者分发的安装脚本均与 PR #28 修复源码一致。先核对此前已验收镜像的源码 revision 与当前 main：若运行内容只有 `deploy/agent/install.sh` 改动，可以以此前固定 OCI digest 为基础，增加安装脚本补丁层，保留原运行环境、依赖、双架构 Agent 包和 SDK。若存在其他运行差异，则回到完整源码构建，不用局部覆盖掩盖差异。

发布成功后将 Compose、环境示例与部署文档的默认固定标签更新到此次版本；历史验收记录保留原标签，不改写旧证据。用户已有 `.env` 需自行更新 `LIGHTMONI_IMAGE` 并重新创建容器。

凭据仅通过受保护内存、stdin 或短期 0600 Docker 配置使用，不能进入构建上下文、镜像层、日志、提交或证据。发布后回读远端 manifest/index、平台和安装脚本摘要，至少执行当前可用 amd64 容器运行验证；arm64 若无执行环境，明确记录静态验证与实际执行的边界。

## 架构影响

不适用：本次恢复已有非 root 安装契约所需的运行文件权限，并改进本机启动观察与安全错误提示；不新增组件、控制/数据通路、凭据、存储、协议或部署拓扑。配置与持久状态仍受原权限保护。无需改写 `docs/system-design.md` 或 Doca 原生图块。Linux systemd 双架构验收仍待实机，不以 shell shim 替代。
