# 网页 SSH 终端

管理员打开“主机管理”，在已登记主机的操作栏点击“登录终端”，即可在小窗中输入命令和查看实时输出。支持 Ctrl+C、交互程序、颜色、终端尺寸同步、全屏、断开和重新连接；关闭窗口或离开主机页会结束连接。

主机使用直接 SSH，填写中心能够访问的地址、SSH 端口、登录用户名，并通过可信渠道确认 `SHA256:...` 主机公钥指纹。有效登录密码或无口令 SSH 私钥可用于终端；只有一个有效凭据时自动使用，多个时需手动选择。指纹用于核验远端主机身份，不能替代登录密码或私钥；指纹与主机 ID/名称作为资产元数据保留，不随登录凭据过期。秘密加密保存在后端，仅建立连接时短暂解密，不返回网页。带口令的私钥、跳板机和 SSM 暂不支持交互终端。

“登记主机”和“添加凭据”使用同一套登录方式及保存时长字段，默认密码登录、有限保存 6 小时；明确选择并确认永久保存时，没有固定过期时间，直到撤销。有限期凭据到期或撤销后清除；managed/permanent 均不因 Agent 激活提前清除。原有一次性密码在终端结束后清除，原临时策略仍按其到期与激活清理规则执行，不是当前默认。建议只在安装或排查期间保留 SSH 凭据，优先短期保存、用后撤销；日常监控优先使用 LightMoni Agent。详见 [SDD 039](../specs/039-host-registration-credential-retention/spec.md)。

终端以登记的 SSH 用户权限直接执行用户输入。AI 助手仍使用固定安装预检和需用户确认的 Agent 部署计划；本功能不增加 AI 任意执行 shell 的工具。不要通过对话发送私钥或把机器密码写进 URL。

每台主机最多一个终端，与安装检查、部署互斥。连接期间不能修改或删除主机；撤销正在使用的凭据会立即关闭终端。登录失效、权限变化或有限期凭据到期在最多 5 秒内关闭，输入前也会重新检查；永久凭据仍受登录、权限、撤销和会话时限约束。每个管理员最多 3 个未结束会话，全平台最多 20 个；连接入口 60 秒失效，SSH 建连最长 20 秒。10 分钟无输入或满 30 分钟后自动断开，可重新连接。

平台不保存或记录终端命令、输出，仅在 SQLite `machine_terminal_events` 保留操作者 ID、主机 ID、凭据 ID、连接时间和结束原因。目标主机自身的 shell history 和系统审计按该主机设置工作。网页关闭后不能恢复原 PTY；重新连接会创建新 shell。平台重启也会断开所有会话。

## 反向代理

终端使用同域 WebSocket，并校验当前登录 cookie、管理员身份和请求 Origin。生产环境使用 HTTPS/WSS，并将 `LIGHTMONI_EXTERNAL_URL` 设为浏览器实际访问的地址。代理需要透传 Cookie、Origin 和 WebSocket Upgrade；不要把 Origin 改成后端地址。开发环境支持同协议 loopback 地址及 Vite 5173 端口，Vite `/api` 代理已启用 WebSocket。

Nginx 示例（替换域名和证书位置）：

```nginx
# 放在 http 块中
map $http_upgrade $connection_upgrade {
    default upgrade;
    '' close;
}

# 放在已有 HTTPS server 块中
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_read_timeout 60s;
    proxy_send_timeout 60s;
}
```

平台通过心跳保持连接并检测断网。当前会话保存在平台进程内，创建会话和 WebSocket 必须到达同一实例；多实例入口需要会话粘滞，不支持终端跨实例恢复。输出有确认窗口和缓冲上限，浏览器处理变慢时暂停远端输出；异常过量输入或缓冲超限会结束会话。

## 验证

```sh
npm --prefix runtime run typecheck
npm --prefix runtime run build
npm --prefix web run build
(cd runtime && node --import tsx --test test/machine-terminal.test.ts test/managed-machines.test.ts)
node web/src/app/verify-machine-terminal.mjs
```

真实 SSH 测试要求本机有 `/usr/sbin/sshd` 和 `ssh-keygen`，会创建临时密钥、独立配置和 loopback 高位端口。浏览器验收使用同一隔离服务，不读取平台的生产凭据或修改已登记主机。无 sshd 的环境跳过真实 SSH 测试，仍执行权限和待连接会话测试。
