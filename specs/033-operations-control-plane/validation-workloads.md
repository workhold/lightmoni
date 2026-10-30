# 工作负载与 Agent 执行验收

验收日期：2026-10-29（Asia/Shanghai）。范围：应用、机器池、托管服务、网站网关，以及 Agent 证书目录和更新脚本执行。云平台与 ACME 协议、浏览器界面验收另见对应记录。

## 定向回归

冻结代码后的最终一次执行：

```sh
cd runtime
node --import tsx --test test/platform-workloads.test.ts test/platform-executor.test.ts
npm run typecheck
```

结果：**20 项通过，0 失败，0 跳过**，约 2.27 秒；类型检查通过。包含 12 项中心工作负载测试和 8 项 Agent 测试。

- SQLite 持久端口与资源预留、分散副本、逐实例回执、新鲜健康端点、确认停止后才释放端口。
- unknown 保留端口与本机写锁，跨两轮调度仍逐个更新旧副本，失败不会继续淘汰其他健康副本。
- 保存草稿不会发布网站、更新已部署服务的应用或机器池版本；部署明确保存 `desired_revision`、`application_revision`、`node_pool_revision` 和授权主体。
- 未配置容量的机器池先执行只读 `node.inspect`，收到 CPU、内存、地址和 Docker 能力后再调度。
- 多网站共享网关不会重复派发写入；域名冲突拒绝；已停止网关重新部署时再次预留端口。
- 100 个每项约 50 KiB 的 Agent 观测均能提交有效回执，资源状态仅保存有界摘要，未突破 128 KiB 状态上限。
- 慢 DNS 请求不会阻塞实例探活，DNS 刷新按网站去重、最多 8 个并发，关闭时等待已开始的请求。
- Compose YAML 中已隐藏的环境变量保存时保留原加密值；环境变量中的 `$HOME` 保持字面量。
- 真实文件系统上的证书/私钥匹配、原子目录指针、不可变版本、非托管文件与符号链接拒绝。
- 真实 shell 脚本读取证书文件与显式环境，不继承测试进程秘密，不回传 stdout/stderr；真实超时进入 unknown 并保留写锁。
- 显式 hook 回读可确认已完成版本，但不会删除或自动解除节点 unknown 写锁。
- Docker/Compose 与 OpenResty 配置预检失败发生在活动状态切换前，返回已知失败并释放本次写锁。

另执行：

```sh
node --import tsx --test test/operations-executor.test.ts test/agent-job-runner.test.ts
```

结果：**13 项通过，2 项 Linux 专用文件系统测试在 macOS 跳过，0 失败**。`git diff --check` 通过。重构过程中也运行过仓库根目录 `npm run typecheck`，runtime、ai-runtime、web 三部分均通过。

这些中心测试中的远程回执和云响应使用确定性夹具；文件、脚本与下述 Docker 现场测试单独列出，未把夹具当作真实部署结果。

## Docker 现场：单容器与 Compose

环境：macOS 本机，Docker Desktop Linux Engine **29.4.3**，Node **24.15.0**。使用本地实际镜像 `alpine:3.23`。

```sh
cd runtime
LIGHTMONI_DOCKER_LIVE=1 node --import tsx --test \
  --test-name-pattern 'single-container' test/platform-docker-live.test.ts
```

正式现场次数：**1 次，通过**，约 **31.52 秒**。实际创建并检查了 Docker 容器，而非命令夹具：

1. 单容器部署并从容器内读取托管配置、初始化文件和环境变量。
2. 更新配置 v1→v2；容器实际读取 v2，初始化目录里的用户修改与业务数据仍保留。
3. 切换到 Compose YAML 项目并读取挂载文件，确认 `$HOME` 环境值未被 Agent 环境替换。
4. 实际 `docker inspect`、`docker stats` 观测，以及 stop、remove 后状态确认。

## Docker 现场：host OpenResty

使用真正镜像 `openresty/openresty:1.27.1.2-0-alpine`。镜像通过公开镜像源拉取后保留官方名称本地标签，拉取摘要为：

```text
sha256:acbf6c163eef0312e624dc8c24edc7e2f1d33bca77a9e4793714d8e4affab5c5
```

首次在 macOS Node 进程运行该项：**1 次环境预检失败，未计为通过**。Docker 配置检查与 host 容器启动可以执行，但 macOS 的 localhost 不属于 Linux VM 的 host 网络，外部探针无法访问监听端口；执行器按验证失败恢复并清理首次容器。未修改 Docker Desktop 全局网络设置。

随后在一次性 Linux Node 执行容器中运行同一测试，执行器与 OpenResty 共享 Linux Docker host 网络：**1 次，通过**，约 **1.70 秒**。实际确认：

- `Host` 匹配的网站返回准确静态 HTML，worker 可读取受管静态目录。
- HTTPS 握手与证书指纹匹配。
- 完整网关版本重载后，HTTP 返回更新后的 HTML。
- 服务发现为空时，新配置实际返回 **503**，不保留失效上游。
- Docker 网络模式确认为 `host`，停止后完成现场状态验证。

可在 Docker Desktop 复现上述 Linux 执行环境。以下镜像和 Docker socket 挂载仅属于一次性 QA 执行器，不属于产品 Agent 的安装或凭据设计：

```sh
# 仓库根目录
ops_repo="$(pwd -P)"
ops_qa="$ops_repo/.local-dev/033-workloads-qa"
mkdir -p "$ops_qa/tmp"
cat > "$ops_qa/Dockerfile" <<'EOF'
FROM m.daocloud.io/docker.io/library/docker:27.5.1-cli AS dockercli
FROM node:24.15.0-bookworm-slim
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=dockercli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
EOF
docker build --tag lightmoni-ops-033-qa:local "$ops_qa"
npm --prefix runtime run build

# 在宿主机转译测试，避免将 macOS esbuild 二进制放进 Linux 执行。
OPS_REPO="$ops_repo" node --input-type=module <<'JS'
import {transformSync} from './runtime/node_modules/esbuild/lib/main.js';
import {readFileSync,writeFileSync} from 'node:fs';
const root=process.env.OPS_REPO;
const input=readFileSync('runtime/test/platform-docker-live.test.ts','utf8')
  .replaceAll('../src/',root+'/runtime/dist/');
writeFileSync(root+'/.local-dev/033-workloads-qa/live.mjs',
  transformSync(input,{loader:'ts',format:'esm',target:'es2023'}).code);
JS

ops_socket="$(docker context inspect --format '{{.Endpoints.docker.Host}}')"
ops_socket="${ops_socket#unix://}"
docker run --rm --network host \
  --name lightmoni-ops-033-linux-qa \
  --label io.lightmoni.qa=operations-033 \
  --mount "type=bind,src=$ops_repo,dst=$ops_repo" \
  --mount "type=bind,src=$ops_socket,dst=/var/run/docker.sock" \
  --workdir "$ops_repo" \
  --env LIGHTMONI_DOCKER_LIVE=1 \
  --env "TMPDIR=$ops_qa/tmp" \
  lightmoni-ops-033-qa:local \
  node --test --test-name-pattern 'host OpenResty' "$ops_qa/live.mjs"
```

## 清理与环境限制

- 每个现场测试使用随机 `io.lightmoni.platform.instance` 标签，只清理属于本次实例的容器；测试 `after` 钩子清理临时 Agent 数据和证书/私钥文件。
- Linux QA 容器通过 `--rm` 自动删除。最终查询 `docker ps -a --filter label=io.lightmoni.qa=operations-033` 为空。
- 本轮已删除 `lightmoni-ops-033-qa:local`、临时 Docker CLI 镜像标签和 OpenResty 镜像源别名；保留可供产品开发复用的官方 OpenResty 标签。
- `.local-dev/033-workloads-qa` 的两个生成文件逐一删除，随后使用 `rmdir` 删除空目录。未执行全局 Docker prune，未删除用户现有容器、镜像或数据目录。
- 本轮没有修改用户 Docker Desktop 设置，也没有在用户远程机器部署服务。
- 本轮未提供实际云账号凭据或生产 ACME 域名，未声称云 CDN、DNS 或公网证书服务已完成真实账号验收；对应协议验证由领域测试和单独证据记录覆盖。
- unknown 节点写锁仍须运维人员检查现场后处理。回读已完成脚本或证书不等同于证明全部旧执行进程已终止，因此首版不自动删除全节点写锁。
