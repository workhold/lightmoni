# 本地主机与连接凭据回归

日期：2026-11-02。

## 环境与范围

- 工作目录：`/tmp/lightmoni-agent-recovery/runtime`。
- 基线提交：`aea817a7dda47c05f80253ea088397c0a35305a4`，同时包含本轮工作区修复。
- Node.js `v22.23.1`，macOS arm64。
- 一次运行以下 7 个现有测试文件，使用隔离数据库、本机 HTTP / WebSocket 服务及 loopback SSH 协议 fixture。终端用临时目录中的独立 sshd、即时生成测试密钥和随机端口，不读取用户 SSH 凭据、不连接 vchive 或生产平台、不修改主机服务或业务数据。

## 命令与结果

```sh
cd /tmp/lightmoni-agent-recovery/runtime
node --import tsx --test --test-concurrency=1 \
  test/connection-credentials.test.ts \
  test/managed-machines.test.ts \
  test/machine-host-identity.test.ts \
  test/host-observed-identity.test.ts \
  test/machine-password-ssh.test.ts \
  test/machine-terminal.test.ts \
  test/machine-service-addresses.test.ts \
  > /tmp/lightmoni-sdd082-host-credential-regression.tap 2>&1
```

实际结果：退出码 **0**，**98 项通过、0 失败、0 跳过、0 取消**，耗时约 9.8 秒。

```text
1..98
# tests 98
# suites 0
# pass 98
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 9803.788667
```

原始本地 TAP：`/tmp/lightmoni-sdd082-host-credential-regression.tap`。
SHA256：`bbc34021c1d5dcae01ea4bd0b4dfab944ed71c3b6a704248f91bf8f664f898c6`。

## 验证内容

- 集中凭据去重、密码空白保留、6 小时/永久期限、共享绑定、默认项失效、全局撤销、过期清除、一次性密码、秘密不可读及旧数据隔离。
- 主机 ID 不可修改，用户名称与发现主机名分离；旧 Agent 迟到心跳不能恢复旧主机名；地址、身份及计划绑定。
- 主机标签联合校验、Agent 安装/卸载审批及取消、恢复卸载、未知结果只读核对、受管凭据使用记录、删除保护。
- 首次 SSH 身份记录、主机公钥变化拒绝、并发首次身份竞争、撤销/取消/目标变更期间拒绝执行。
- loopback 密码认证、主机公钥核验、标准输入隔离、超时和取消；私钥/密码终端的 PTY、UTF-8、Ctrl+C、resize、流控、失效、同源与用户隔离、会话期限。
- IPv4/IPv6 内外网服务地址、NAT 与 SSH 目标/平台来源区分、虚拟网卡过滤、手动覆盖、陈旧 revision 拒绝及目标改变重新确认。

另已执行的 Agent 移除执行器门禁及独立执行器维护 **76 项通过**，详情见 [`evidence-node-remove.md`](evidence-node-remove.md)。本记录仅反映本次本地回归，不替代线上 vchive 验收。

`git diff --check` 通过。未提交或推送代码。
