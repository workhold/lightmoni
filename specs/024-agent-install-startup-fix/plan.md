# SDD 024：实施设计

1. 在当前脚本的 runtime 复制后显式设置 `u=rwX,go=rX`，使目录可遍历、代码可读、原可执行文件可执行，group/other 不可写；显式创建/修正 `/opt/lightmoni-agent` 和 `releases` 为 0755，避免已有 root-only 父目录阻断访问。不修改 `/etc/lightmoni-agent` 与 `/var/lib/lightmoni-agent` 的 0700/0600 权限。
2. 用固定阶段标识区分 systemd reload/enable/restart/startup-check。启动观察函数最多 10 次（1 秒间隔），连续两次 active 才通过，失败仍进入原事务回滚。轮询不发网络请求。
3. finish 在回滚前采集仅固定 systemd 字段，诊断失败不更改原退出状态或回滚逻辑；给出本机 journalctl 命令，不自动读取日志。
4. 扩展真实 `/bin/sh` 安装器 fixture，构造 nested runtime JS 与可执行文件；模拟服务用户按权限读取最终安装路径，在旧实现上复现失败，在新实现上通过。覆盖延迟启动、短暂 active、持续 inactive、restart 失败、show 失败以及既有升级回滚。
5. 运行定向测试、shell 语法与类型检查，再运行 runtime 回归。更新部署说明与验收证据，通过独立 PR 交付，不合并或发布到用户服务。

## 镜像发布设计

1. 在用户追加授权后同步 main，记录旧固定标签/index digest 与源码 revision，排除文档、测试和独立示例后核对运行文件差异。
2. 仅安装脚本变化时使用固定旧镜像 digest + 只复制修复脚本的 Dockerfile，更新 OCI revision；不执行用户源码构建脚本，不改基础运行配置。对两个目标平台分别构建 OCI，再合成双架构 index。
3. 核对两个镜像的安装脚本 SHA256、原始平台、Entrypoint/User/Env 和下载制品摘要；在现有 amd64 Docker 上隔离验证 Node 启动、非 root 读取脚本及管理员命令入口。当前发布主机只有 2 GiB 内存、无 swap，不新建 ClickHouse；本次不重复健康/网页/入库全链路验收，沿用旧固定镜像已有的双架构完整验收与本次运行差异审查。arm64 无执行环境，只进行镜像静态检查并明确边界。
4. 推送新固定标签与 latest。若注册表重现普通大层上传 413，沿用受保护凭据的 OCI 小块上传，复用已存在层；回读索引、子 manifest、config 和补丁层，记录内容摘要。
5. 清理本次短期凭据和构建暂存，保留既有镜像/主机 Agent/线上平台。提交发布证据 PR，不自动合并。此次发布不改变组件、协议、凭据边界、存储或部署拓扑，架构同步仍不适用。
