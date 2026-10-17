# Quickstart

1. 管理员打开 /agents，查看执行节点、任务管理、任务标签。
2. 建立两个任务标签，分别创建指标采集与目录日志任务，关联对应标签。
3. 为一个执行节点选择两个标签，确认节点取得两种任务；另一个节点只取得其匹配任务。
4. 停用或移除标签关联，确认配置版本变化且对应任务撤除。
5. 创建table或采集间隔冲突，确认返回明确冲突且原配置保持。
6. 使用成员账号只能查看；旧安装链接可选一个初始任务标签，接入后管理多标签。

实际浏览器验收使用隔离API，不对当前真实节点、Key或任务发起写入。

## Executable checks

在项目根目录执行（需已安装 web 依赖及本地 Go）：

```sh
.local-dev/go/bin/go test -race ./internal/server ./internal/agent ./internal/dashboards
node --experimental-strip-types --test web/src/app/agentInstallCommand.test.mjs web/src/app/sdkExamples.test.mjs
npm --prefix web run build
.local-dev/go/bin/go build -o .local-dev/bin/lightmoni ./cmd/lightmoni
```

备份现有 SQLite 后启动构建的服务；使用隔离浏览器脚本验证实际静态页面，设置 `LIGHTMONI_TEST_BASE_URL` 指向本地服务。脚本内部模拟 API，不创建真实任务。结果与截图位置记在 [validation.md](validation.md)。

```sh
LIGHTMONI_TEST_BASE_URL=http://127.0.0.1:8080 node web/src/app/verify-execution-nodes.mjs
```
