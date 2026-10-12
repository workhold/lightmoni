# SDK 双通道与 SQL 工作台移除验收

本地运行实例：`http://localhost:18380`。更新镜像：`lightmoni:sdk-modes-no-sql-20261011`。

SDK 接入页的八种语言均可选择“通过 Agent”或“直连中心”。两种方式分别保留填写的地址；切换语言、进入 Key 管理再返回 SDK 接入时，所选方式与地址保持。示例通过环境变量传入地址和凭证，直连示例不包含本机 Agent 地址。中心默认地址来自实例配置；容器地址说明覆盖 Docker 服务名和 Docker Desktop 宿主机地址。

SQL 工作台页面、侧栏、数据表查询、模板运行 SQL、日志检查器跳转、全页与侧边 AI 助手跳转已移除。图表模板仍可创建大盘；大盘 SQL 编辑、查询预览、日志 SQL 模式和执行 SQL 检查器保持可用。旧 `/query?sql=...` 链接回到概览，后端查询接口保留。

## 真实上报

| 路径 | 语言 | 每个服务核对 |
| --- | --- | --- |
| SDK → 中心 → ClickHouse | Go、Node、Python、Java、.NET、PHP、Ruby、Rust | Counter 20、关联日志/span 20、Histogram 20、Gauge 3 |
| SDK → Agent SQLite → 中心 → ClickHouse | 同上 | 同上 |

Java、.NET、PHP、Rust 使用隔离运行时容器。直连测试中，容器加入实际 Compose 网络，以 `http://lightmoni:8080` 上报；没有启动测试 Agent。Agent 路径使用临时 Agent 和本地访问令牌。结果按本次 Key 与唯一服务名核对，完成后禁用测试 Key。

结果：[直连](direct-e2e.json)、[Agent 转发](agent-e2e.json)。执行脚本：`scripts/sdk-smoke.py --mode direct|agent`，容器参数为 `--container-endpoint`、`--docker-network`。

## 页面与部署

`web/src/app/verify-sdks.mjs` 连续三轮通过：前两轮使用开发页面连接真实服务，第三轮使用已部署页面。每轮核对八种语言 × 两种方式的原始代码、高亮、复制代码、复制环境变量，八种下载、URL 校验、两种主题和 1280 / 750 / 390px 布局，以及旧工作台路由与查询接口。页面无脚本错误。

- [第一轮](run-1/ui-report.json)、[第二轮](run-2/ui-report.json)、[第三轮](run-3/ui-report.json)
- [深色桌面](run-3/sdk-desktop.png)、[浅色桌面](run-3/sdk-light.png)、[390px](run-3/sdk-390.png)
- [保留查询能力的页面检查](preserved-query-ui.json)：在配置的 `localhost:18380` 地址通过真实大盘运行 `SELECT 1`，打开图表 SQL 编辑器并重新查询；在日志检查器核对复制按钮及工作台入口移除。测试大盘结束后删除。
- [部署核对](deployment.json)：HTTP 健康检查通过，21 份前端文件与本次构建逐字节一致，八种 SDK 安装包与本地构建一致，包内说明包含直连中心，校验文件一致。

`npm --prefix web run build`、`go test ./internal/server -run TestSDKCatalogAndDownloadRoutes -count=1`、SDK 示例与 AI 上下文的六项单元检查通过。安装包已重新生成；持久卷继续使用原部署的数据。

容器地址说明依据 Docker 官方文档：[Compose 网络](https://docs.docker.com/compose/how-tos/networking/)、[Docker Desktop 网络](https://docs.docker.com/desktop/features/networking/networking-how-tos/)。
