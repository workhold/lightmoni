# 全局应用与跨集群网站 Demo

一套 `demo-web` 自定义应用和一套 `demo-openresty` 商店应用，分别部署到两个集群。Web 和 OpenResty 都使用托管模式，入口固定占用 80/443；`demo-mysql` 使用手动模式留在集群 A 的指定主机。

| 集群 | QA 节点 | Web 命名端口 | 入口 |
|---|---|---|---|
| A | 原 Docker 主机、独立 DinD 备用节点 | http:8080 / admin:9090，映射 24000 段 | 托管 OpenResty，80/443 |
| B | 第二个独立 DinD 节点 | 相同端口，映射 25000 段 | 同一全局 OpenResty 应用的另一部署 |

这是**同一物理 Docker 主机上的三个逻辑节点**。两个 DinD 节点各有独立 daemon、网络命名空间、存储卷和内部网段，80/443 互不占用，不能据此宣称已验收多物理机或云网络故障。两个集群的 Web 显式连接同一演示 MySQL，不代表数据库复制或自动跨集群服务发现。

## 启动与访问

要求本地 Unix Docker socket、Docker Compose v2、Node.js ≥22.19 和已安装的仓库依赖。DinD QA 节点使用独立特权容器，不修改 Docker Desktop 全局设置。首次下载镜像可能需要数分钟。

```sh
# 仓库根目录，先准备节点和演示镜像，再启动控制面与真实工作负载。
./examples/cluster-demo/run.sh nodes-up
./examples/cluster-demo/run.sh up
./examples/cluster-demo/run.sh status
```

等待 `ready: true` 后打开：

- [留言网站](http://127.0.0.1:18080)：表单实际写入并读回 MySQL。
- [第二命名端口](http://127.0.0.1:18081)：实际实例、版本和留言数量。
- [QA 工作台](http://127.0.0.1:19043/qa/workbench)：正式生产 bundle 与同一真实控制面。

单节点运行可以省略 `nodes-up`。转发器跟随当前就绪入口，换机后本机网址保持不变。

```text
localhost:18080 → Host demo.example.test  → 集群 A 当前 OpenResty → Web http → MySQL
localhost:18081 → Host admin.example.test → 集群 A 当前 OpenResty → Web admin → MySQL
localhost:18443 → 原样 TCP 转发         → OpenResty TLS :443
```

TLS 握手和终止由 OpenResty 完成，转发器不解密 HTTPS：

```sh
curl --resolve demo.example.test:18443:127.0.0.1 --insecure https://demo.example.test:18443/api/messages
curl --resolve admin.example.test:18443:127.0.0.1 --insecure https://admin.example.test:18443/
```

测试使用保留域 `example.test`、自签证书和显式 DNS provider mock，不调用真实公网 DNS 或 ACME。生产 DNS 归属、聚合、更新和删除逻辑实际运行，模拟公网地址使用文档地址段 `192.0.2.0/24`。

## 验收

```sh
./examples/cluster-demo/run.sh verify
./examples/cluster-demo/run.sh rebuild
./examples/cluster-demo/run.sh failover
node examples/cluster-demo/scripts/verify-workbench.mjs
```

`verify` 检查真实写入/读回、两个命名端口、端点集群隔离、第二集群 HTTPS 和数据内容。`rebuild` 重建实际 Web 容器并确认 MySQL 记录保留。`failover` 暂停当前入口节点或其专属网关与 QA Agent 循环，等待实际心跳过期（约两分钟），验证另一个节点恢复固定 80/443、TLS 与 DNS 聚合，最后恢复故障节点；期间主网站短暂不可用。

浏览器脚本从无会话状态确认 401，再建立正式 Auth 会话、访问全局应用/网站，并通过真实留言表单写入数据库。现场报告位于 `.local-dev/042-cluster-demo/report.json`，浏览器报告/截图在其 `browser/` 子目录。已完成的范围与结果见 [VALIDATION.md](VALIDATION.md)。报告不包含密码、token 或私钥。

## 执行与凭据边界

集群、商店安装、应用、证书和网站均经生产 HTTP CRUD/actions 创建。Agent 通过真实 enrollment/activate 建立控制凭据，再经受鉴权的 claim、私有 payload、events、result 以及有效 lease 执行生产 `executeOperation`。长任务持续续租，实际 Docker 回执驱动状态，没有成功回执夹具。

原 Docker 节点的中心与 Agent 循环共用一个 Node 进程；两个 DinD 节点各运行独立 Agent。主机资产预登记在隔离 SQLite，不经过 SSH 安装。工作台读取构建出的 `runtime/public`，loopback 入口使用受保护凭据建立 `Demo administrator` 的生产 Auth 会话；后续请求使用 HttpOnly cookie，正式会话和管理员检查、Agent 凭据检查始终开启。仅注册演示所需接口，不是完整监控中心。

## 启停与数据

```sh
./examples/cluster-demo/run.sh stop   # 平台停止应用，保留数据
./examples/cluster-demo/run.sh start  # 恢复部署和网站，重新验证
./examples/cluster-demo/run.sh down   # 停止应用、QA/转发器和独立节点，保留数据库与节点卷
```

再次 `up` 使用原应用 ID、加密配置和 MySQL 数据。旧单集群数据由运行时原位规范化；故障替换保留原实例历史，数据库不随托管 Web 迁移。

隔离状态在 `.local-dev/042-cluster-demo/`。密码随机生成且加密保存，凭据文件权限 `0600`，目录已被版本控制忽略。18080/18081/18443/19043 仅发布到 `127.0.0.1`。QA 执行器挂载本机 Docker socket 与同绝对路径仓库；嵌套节点使用自身 socket 和卷。脚本只操作本轮标记容器、卷和平台实例，不执行全局 prune，不删除业务资源。

## 自定义程序

`web/server.mjs` 使用参数化 SQL、双 HTTP 端口和真实数据库健康检查；锁文件固定依赖。

```sh
docker build -t lightmoni-cluster-demo-web:1.0.0 examples/cluster-demo/web
```

生产中将镜像发布到 Agent 可拉取的仓库，再创建自定义应用。首版平台不包含自动源码构建流水线，Demo 使用独立 Dockerfile 构建。
