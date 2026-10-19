# 设计

使用 ssh2 建立带 PTY 的 shell，用 ws 提供同源且需要登录的 WebSocket 通道，xterm.js 和 fit addon 渲染终端。避免依赖本机 PTY 原生扩展，不把 SSH 私钥写入网页或连接 URL。

1. HTTP 创建短时待连接会话，绑定管理员身份和当前登录 cookie 摘要；WebSocket 升级再次校验身份、严格 Origin、会话归属及单次使用。连接前从主机模块取得私钥租约，复用其校验、互斥和解密逻辑。
2. SSH hostVerifier 精确核对已确认 SHA256 指纹；仅请求 PTY shell。后端记录连接审计，不记录任何输入输出。定期和每次输入复核登录状态、角色、目标和凭据。
3. WebSocket JSON 传入 input/resize/ack；SSH 输出二进制传输。客户端渲染完成后 ACK 字节量，服务端按输出窗口暂停/恢复流，限制输入和 WebSocket 缓冲。
4. 主机页弹窗提供私钥选择、自动连接、实时状态、断开/重连和全屏；关闭卸载同步清理连接。后端模块在平台退出时关闭全部通道。
5. 类型检查、单测、隔离 HTTP/WebSocket/SSH 联调及生产浏览器验收后，通过新 PR 合入 main。
