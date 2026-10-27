# 网站与证书验收

日期：2026-10-27。范围：SDD 026 网站、证书领域执行器与执行边界。中心 API、UI 和 Doca 的验收在总记录中单独跟踪。

## 自动化边界

在 `runtime` 目录执行：

```sh
node --import tsx --test test/operations-websites.test.ts test/operations-certificates.test.ts
npm run typecheck
```

定向测试 13 项通过。覆盖域名/配置注入、上游协议和嵌入凭据、静态路径越界、符号链接、预检失败不替换活动配置、真实本地 HTTP 配置证明探测、版本恢复、日志 JSON 字节限额（多字节与转义）、伪造 PID、公共资产和私有目录隔离、512 KiB 静态文本/900 KiB 序列化上限、证书公私钥和域名匹配、0600 私钥、有效期、过期拒绝安装但仍可检查、ACME HTTP 前置条件与邮件、绑定站点 SAN 缺失拒绝换证、真实本地 TLS 握手验证证书恢复以及网站停用补偿失败边界。

Nginx 缺失、配置检查失败、端口/域名不受管等状态返回固定错误；命令 stderr 不进入运行结果或模型上下文。只读版本列表和日志受 JSON 字节上限约束。

## Linux 实际验证

在受用户授权的测试主机上创建一次性 Docker 容器，未安装宿主依赖、未映射宿主端口、未修改生产容器或现有 Nginx/1Panel。以已存在的 Node.js 24 Debian bookworm 镜像作为基础，仅在临时镜像安装 Nginx 1.22.1、procps、OpenSSL。网站监听端口、Node 测试上游、证书、私有 dataDir、公共静态目录全部在临时容器内部。

第一次独立驱动完成 **65 次实际参数化系统命令**，验证以下闭环：

1. 无受管配置时启动恢复无操作，不创建或接管网关。
2. root Nginx master 将 worker 降权为 nobody/其真实主组；静态文件可读，私有目录保持 0700。
3. HTTP 静态页面与 HTML MIME 正确。
4. 更新页面并显式恢复到前一版本；应用不可用上游导致 502 时恢复原站点，并实际验证恢复后的页面。
5. 反向代理到真实 Node HTTP 上游。
6. 上传 X.509 证书，验证私钥匹配/有效期，私钥权限 0600。
7. HTTPS 网站绑定；从真实握手核对 peer fingerprint，并核对该配置的 HTTP 证明摘要。
8. 轮换证书并确认网关实际开始使用新的 fingerprint。
9. 读取真实、有界的 Nginx access log。
10. 显式 disable 仅关闭受管站点。

真实 Nginx 验收发现 `nginx -t` 首次运行会创建空 PID 文件：执行器已修正为空 PID 视为未运行；仍拒绝非数字 PID 或指向其他进程的 PID，不能据此对用户进程发信号。

已将同等流程保留为仓库测试，在有依赖的隔离 Linux 环境、`runtime` 目录执行：

```sh
LIGHTMONI_NGINX_LIVE=1 node --import tsx --test test/operations-websites-live.test.ts
```

该测试使用随机临时目录、动态容器内端口、系统 Nginx/OpenSSL；未启用环境变量时明确跳过。已在上述 Linux 容器以编译后的同一仓库测试运行 **1/1 通过**，包含故障后恢复验证的一次约 4.4 秒。该测试不用于生产主机，不能把 fixture 命令输出替代真实验证。

## 隔离资源清理

实际验证容器使用 `--rm`，按专用 `lightmoni.qa=ops026-web` 标签确认没有遗留容器；已删除本轮专属临时镜像和远程临时目录。未对宿主全部容器、镜像、卷或 build cache 执行 prune，不影响其他测试或业务资源。

## 明确边界

- ACME `issue`/`renew` 实现为真实 Certbot webroot 调用，要求同域名、80 端口的已受管网关能读回临时 HTTP challenge；不停止或改写用户已有服务。**没有获授权的公网测试域名，因此本轮未向公网 CA 发证或实测续期，不宣称这部分公网验收完成。**
- 不支持 DNS challenge、通配符证书、自动接管已有 Nginx/1Panel、任意文件目录或上传站点归档。
- 小型静态站最多 200 个文本文件、512 KiB UTF-8 文本，并要求序列化配置不超过 900 KiB；大静态资产构建与二进制制品另行设计。
- Linux root Agent 使用独立 `/var/lib/lightmoni-web/<dataDir 标识>` 公共资产目录；配置、日志、状态和私钥仍在私有 Agent dataDir。root master 不使用 root worker。普通用户运行时使用 dataDir 同级的持久公共资产目录，只能绑定自己有权限的端口。
- HTTPS 反代默认验证上游系统 CA；内部自签证书需管理员显式选择关闭上游校验，预览保留该设置。自有上传证书可为内部 CA/自签证书，输出标明 `self_signed`；实际对外可信链仍由运营者负责。
