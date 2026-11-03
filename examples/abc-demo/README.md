# ABC 演示应用

无外部依赖的 Node.js 服务，用于验收私有镜像 → 应用 → 网站 → DNS/TLS → 公网请求的完整链路。页面数据来自运行进程。

```sh
node server.mjs
node --test server.test.mjs
docker build -t abc-demo .
```

容器使用 UID/GID 65532、端口 8080，不需要数据卷或外部服务。健康检查 GET /healthz；实时状态 GET /api/status；交互测试 POST /api/ping。应用只记录方法、路径、状态码和耗时，不记录请求正文、请求头或 URL 查询参数。

正式部署使用私有仓库固定 digest，在 LightMoni 创建应用/网站并关联 heyphp.com 域名与证书。实际资源与公网验收证据见 specs/086-production-integration/validation.md。

## Registry 后端访问边界

云主机的公网 NAT 可能把内网绑定端口直接暴露到外网。私有 Registry 发布前，需要限制后端端口只接受受信内网连接，外网仅通过 HTTPS 与认证入口访问。

本次 Demo 使用 `lightmoni-registry-firewall.service` 和 `/usr/local/sbin/lightmoni-registry-firewall` 持久加载专用 DOCKER-USER 规则，范围为 `172.21.0.16:20000` 与受信网段 `172.21.0.0/20`。Docker 依赖该单元；调整网络或端口时应同步脚本并直接重新运行，停止此依赖单元会影响 Docker。验收需同时检查内网 HTTP 200、外网后端拒绝、HTTPS 未登录 401 和登录后 200。
