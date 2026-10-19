# SDK及中心上报与main整合验收（2026-10-20）

整合基线为远端main `01ff6d32b5176db8ae9b856c8a2585cefbc24746`。依照用户取舍，SDK及中心上报采用本地实现，其余采用该主干版本；在功能分支经PR合入。用户本次明确授权合并。

## 最终行为与兼容影响

- Go、Node.js、Python、Rust提供统一record接口，每张业务指标表选择一个聚合周期，默认30秒，支持10秒、30秒、1分钟、5分钟、10分钟、30分钟和1小时。
- SDK密钥仅填写名称，启用后可写业务表；匿名SDK仅能写已启用的豁免表，携带无效密钥不会降级为匿名。主干中的按表授权SDK密钥和连接模式API被本地SDK语义替换，调用方按本次SDK文档配置endpoint。
- 中心保留本地固定字段、统一lightmoni系统表、采样与分布及窗口查询逻辑。Agent采集目标固定为host/probe/files。
- 主干的Agent注册、控制/数据双凭据、主机管理、SSH终端、AI、告警、界面语言和外观保留。Agent专用凭据与SDK密钥分开鉴权，禁用SDK密钥不影响已注册Agent。
- 周期设置加入主干“数据管理 → 聚合周期”；大盘保留主干界面并展示实际对齐的范围与步长。SDK接入保留本地三个页签与四语言示例，主干Agent安装页单独挂载。
- 当前发布及下载校验涵盖四种SDK；Java、.NET、PHP和Ruby历史源码保留，未列为本次record接口及七档周期支持语言。
- 容器SDK打包增加Go源代码包，直接复制锁定的Go依赖清单，无需在Node镜像安装Go工具链。未执行容器镜像构建。

## 验证

| 检查 | 结果 |
| --- | --- |
| 全仓类型检查与构建 | npm run typecheck、npm run build通过 |
| runtime完整测试 | 226项：222通过、0失败、4条件跳过 |
| AI runtime完整测试 | 71/71通过 |
| Node SDK | 18/18通过 |
| Python SDK | 32/32通过 |
| Go SDK | 完整race测试通过；发布包解压后窗口专项通过 |
| Rust SDK | 锁定依赖离线测试3/3通过，隔离Rust 1.85.1 |
| 四SDK发布包 | 发布完成；真实HTTP下载及SHA256核验见report.json |
| Agent与业务域真实集成 | 7/7通过，含持久化队列、真实ClickHouse、日志/链路/大盘和本地告警恢复 |
| 七档周期真实集成 | 七档API、Node SDK→OTLP→ClickHouse及UI保存回显通过，详见../metric-periods/report.json |
| 主干UI集成 | 四语言样例、仅名称创建密钥、固定上报表、Agent安装、主机管理及英文偏好，见report.json |

完整runtime的4项条件跳过包括独立Agent/业务域live、历史Go确定性编码对照、Linux发布包；前两项已在上述真实服务专项另外运行。浏览器及真实集成使用18887独立中心、专用SQLite和18123测试ClickHouse，不访问实际机器或付费模型。最长周期通过仅在隔离SQLite播种过去的生效历史进行验证，未等待整小时。

`scripts/verify-main-telemetry-integration.mjs`与`scripts/verify-metric-periods.mjs`可重跑；本机日志位于忽略目录`.local-dev/metric-main-*.log`，截图位于`artifacts/screenshots/metric-main-integration/`及`artifacts/screenshots/metric-periods/`。页面无未捕获错误及HTTP 5xx。规格范围之外的历史011方案任务仍独立跟踪。
