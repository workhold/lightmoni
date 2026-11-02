# 本地普通 Agent 生命周期与恢复回归

日期：2026-11-02。

## 环境与边界

- 工作目录：`/tmp/lightmoni-agent-recovery/runtime`。
- 基线提交：`aea817a7dda47c05f80253ea088397c0a35305a4`，使用本轮 SDD082 工作区。
- Node.js `v22.23.1`、npm `10.9.8`，macOS / Darwin arm64；现有 `runtime/node_modules`，通过 `tsx` 运行 TypeScript 测试。
- 一次串行运行六个现有测试文件。数据库、本机 HTTP 服务、下载材料及 SSH 返回均为隔离 fixture；shell 测试把系统路径改写到临时目录，使用临时 `systemctl` / `id` / `stat` 替身，不操作真实 systemd 或用户服务。
- 不访问生产平台、vchive、浏览器或真实 SSH，不安装、升级、卸载用户主机的 Agent。不重复独立执行器维护的 76 项检查，也不把本地 fixture 通过计作线上验收。

## 命令与结果

```sh
cd /tmp/lightmoni-agent-recovery/runtime
node --import tsx --test --test-concurrency=1 \
  test/machine-agent-updates.test.ts \
  test/machine-agent-lifecycle.test.ts \
  test/machine-installation-recovery.test.ts \
  test/machine-installation-recovery-races.test.ts \
  test/agent-uninstall-script.test.ts \
  test/agent-uninstaller-download.test.ts \
  > /tmp/lightmoni-sdd082-local-lifecycle.tap 2>&1
```

退出码 **0**，**93 项通过，0 失败，0 跳过，0 取消**，耗时约 51.1 秒。

```text
1..93
# tests 93
# suites 0
# pass 93
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 51079.607208
```

原始本地 TAP：`/tmp/lightmoni-sdd082-local-lifecycle.tap`。
SHA256：`c9d9077e131cb5b8b730564748ddee8be09adcc00ccf7aa57a4394779eecd388`。

## 覆盖内容

- 同版本不同构建的固定发行、包与维护脚本摘要；目标架构、身份、审批到期、重放及远端变化门禁。
- 升级需要新进程、精确构建身份、同步后的控制配置和无错误心跳；自动回退、显式回退、原先停止的服务及丢失回执后的只读核对。
- 下载票据绑定主机、操作与固定文件；共享凭据使用记录及撤销；维护期间隔离冲突任务、终端、删除和主机编辑；批次串行、暂停、恢复和取消。
- 标准与恢复卸载的固定路径、主机身份、部分残留、systemd 查询失败、任务锁、损坏或不确定标记及停止服务期间的竞争变化。
- `--purge` 清除 Agent 身份、配置和缓存，保留 `operations` 业务持久数据；默认保留、重复执行和缺失服务的离线清理行为。
- 管理员下载固定离线脚本及 SHA256，非管理员/未登录拒绝，缺失、符号链接、目录或超限文件拒绝。
- 安装中断后按原预约恢复；未派发安装的预约撤销；过期、未来、旧心跳、错误构建或绑定拒绝；人工结束保留 unknown 历史，迟到的预检/回执不覆盖新状态或重发安装。

`git diff --check` 通过。本轮未为纯提示调整新增测试；`AgentUninstallManual.tsx` 的中英文 purge 提示现与上述已有业务目录保留测试相符。未提交或推送。
