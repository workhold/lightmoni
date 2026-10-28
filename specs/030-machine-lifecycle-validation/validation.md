# 验收记录

日期：2026-10-28

## 自动化证据

- `runtime/test/managed-machines.test.ts` 与 `runtime/test/machine-terminal.test.ts`：31/31 通过，覆盖主机删除、有效凭据/忙状态保护、待审批计划取消、密码凭据自动撤销、网页终端租约释放、过期和撤销路径。
- runtime 全量测试：400 项中 383 项通过、17 项按环境条件跳过、0 失败。
- `runtime/test/machine-password-ssh.test.ts`：使用内存随机 host key 和真实 `ssh2` loopback 服务，覆盖密码成功、错误密码、指纹不匹配、超时、预检取消和连接中止；不创建操作系统用户，不修改本机 sshd。
- `web/src/app/verify-machine-password-terminal.mjs`：密码终端浏览器回归 4/4 通过；断开后不能本地复用，重新打开会读到已撤销状态。
- 原私钥网页终端回归 9/9 通过，主机删除与凭据切换 UI 回归 18/18 通过。
- runtime/web TypeScript 检查、Web 生产构建和 `git diff --check` 通过。

## vchive 受控验证

- 已使用用户授权的 vchive 私钥完成主机指纹确认、Linux/amd64、curl/tar/gzip/sha256sum、systemd、root 权限和 HTTPS 可达性预检；固定只读命令通过。
- 已打开网页终端，只读执行 hostname、`id -un` 和 `systemctl is-active ssh`，输出未持久化；测试私钥随后已撤销。
- vchive 的 SSH 密码未提供，因此没有声称完成真实密码登录验收；密码路径由隔离的真实 `ssh2` fixture 覆盖。不能把平台网页登录密码或其他服务密码当作 SSH 密码。
- 本轮未执行 Agent 安装。安装计划必须先在主机管理中生成并供管理员审阅；实际 apply 会创建远端 systemd 服务和 Agent 身份，需在具体计划展示后再确认。

## 在线设计文档

- 仓库设计基线：`docs/system-design.md` 第 13 节。
- Doca 在线副本：<https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53>。
- 已回读 Doca 第 13 节，确认主机删除级联边界、密码仅用于一次预检/管理员终端、自动撤销、私钥-only 部署计划和 Agent 通道说明均已保存；原有流程图未修改。
