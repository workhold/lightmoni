# SDD 024：安装契约

- CLI 参数、发行版本、包名、路径及 HTTP API 均保持现状。
- `/opt/lightmoni-agent`、`releases` 及 `<release>` 的安装 runtime：目录 0755；普通非可执行文件 0644；已有执行位的文件 0755。文件继续由安装 root 持有，非 root 服务只读。
- `/etc/lightmoni-agent`、`/var/lib/lightmoni-agent` 与配置/identity 权限不放宽，凭据不进入 runtime。
- `systemctl restart` 非零直接失败；成功后观察最多10次，每次间隔1秒，需要连续两次 active。超时原样回滚；不声明中心 readiness。
- 失败输出含固定阶段码与固定属性名；不自动输出原始日志或供应商/中心错误。`systemctl show` 失败不能掩盖主错误或阻止恢复。
- first-install 失败后新 unit/launcher/current 移除，旧安装失败后原启用/运行状态恢复。enrollment 已激活后的服务器凭据状态不在文件回滚保证内，重新安装需平台新建 token。

## 镜像交付

- 仓库 `docker.heyphp.com/lightmoni/lightmoni`，固定标签 `20261027-agent-install`，同时更新 `latest`；旧固定标签 `20261026-admin` 保留。
- OCI index 包含 `linux/amd64`、`linux/arm64`。本次使用已验收基础 index `sha256:51ebf2093ec5e604dc0a6e0f5b6a231caed9e85a2476edb05d37adb00cd72826`，仅覆盖 `/opt/lightmoni/runtime/downloads/install.sh`，root:root 0644。
- 安装脚本 SHA256 为 `ee69fe1241f07495cf153fec9f1f9a0c5d477b6d29d5e2d0b2b60ec37eb0e4ff`；继承原平台、运行配置和下载包。OCI revision 标识运行源码基线 `c3c01fae989bf3885756e4aab3b6cda78ce8ae04`，不宣称原基础镜像中的非运行测试源码也已刷新。
- 发布镜像不替换在线容器；已有部署须更新 `.env` 中的 `LIGHTMONI_IMAGE`，使用原项目名与数据卷执行 `pull`、`up -d --no-build --wait`。
