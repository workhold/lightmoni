# SDD 024：验证记录

日期：2026-10-27。环境：macOS，Node v22.23.1。

## 根因复现与定向验证

- 使用真实 `/bin/sh`、`umask 077` 和 `cp -R`，源 runtime 目录/Node 为 0755、JS 为 0644，安装后得到 0700/0700/0600；旧 `chmod go-w` 不补足读取和遍历权限。
- 定向 `node --import tsx --test test/install-release.test.ts`：12 项通过、0 失败。覆盖 root-only 父目录修复、递归运行文件权限、配置/identity/queue 仍私有、正常安装/升级、延迟启动、孤立 active 不计成功、最多 10 次观察/9 次间隔、首装失败清理、旧 Node/Go 文件及启用/运行状态恢复。
- 安全诊断先于 stop，查询只含固定属性，无测试密钥。`systemctl show` 失败仍回滚，restart 退出码 7 在诊断失败和成功恢复后仍为 7。
- 负向验证：临时测试副本加载 `origin/main` 的旧安装器，新增首装权限用例失败（安装器退出码 3，触发回滚）；修复版通过。未替换工作区安装脚本，临时测试已删除。
- `sh -n deploy/agent/install.sh`、`npm --prefix runtime run typecheck`、`git diff --check` 通过。
- runtime 完整 `npm test`：311 项通过、16 项环境相关跳过、0 失败（共 327 项，约 60 秒）。
- 独立只读审查安装脚本、POSIX 条件退出语义、安全诊断和回滚，未发现阻塞问题。

## 环境与交付边界

安装测试执行真实 shell，但 root/Linux/systemctl/install 等是命令 shim；通过文件 mode 模拟服务用户读取，未执行真实 setuid/chown 或 Linux systemd。双架构 Linux 实机安装、端到端 enrollment 和中心心跳仍待验证，不能把本机测试描述为这些验收已完成。

本次只修改分发安装脚本及检查/文档，不更改打包 Node 或应用内容。源码合并后仍需更新平台镜像/分发目录中的 `install.sh`；本次未发布线上平台，也未登录或修改用户远端主机。若旧安装在激活后回滚，需在平台撤销该节点凭据并创建新的 enrollment token 重装。

架构同步不适用，理由见 [规格](spec.md)。

交付：[PR #28](https://gitea.heyphp.com/lightmoni/lightmoni/pulls/28)，目标 `main`，待审核；未合并、未发布。提交前已 fetch 确认基于最新主干 `5fea503`。
