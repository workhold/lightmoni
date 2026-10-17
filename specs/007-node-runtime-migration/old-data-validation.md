# 真实旧数据与浏览器验收

验收时间：2026-10-17 22:50–22:52（Asia/Shanghai）。本次全部通过。

## 旧 SQLite 与 master.key

运行 `runtime/test/helpers/old-data-live.ts`，使用 Node SQLite backup API 从当前 `.lightmoni/lightmoni.db` 取得一致性副本。源数据库以 `readOnly: true` 打开；只在隔离副本上注册 Auth、Settings、Ingest、Core、Templates、Install、Nodes、Assistant、Dashboards、Logs、Alerts。没有调用模块 `start()`、没有启动 HTTP 或监控后台、没有连接 ClickHouse 或供应商。网络调用计数为 0，注册了 141 条真实 Node 路由。

数据库和 `master.key` 副本权限均为 `0600`，证据目录权限为 `0700`。报告只包含表计数、布尔断言与路由数，不输出账户内容、会话、密钥、密文或解密结果。

| 表 | 迁移前 | 迁移后 | 结果 |
| --- | ---: | ---: | --- |
| users | 1 | 1 | 所有原行逐字节保留 |
| sessions | 3 | 3 | 所有原行逐字节保留 |
| ingest_keys | 0 | 0 | 表与权限迁移完成，无真实 Key 样本 |
| instance_settings | 0 | 0 | 表保留，无真实配置样本 |
| catalog | 8 | 8 | 所有原行逐字节保留 |
| dashboards | 3 | 3 | 仅内置中心运行时面板执行预期迁移，旧正文留在历史版本 |
| dashboard_versions | 3 | 4 | 原版本不变，增加 Node 运行时迁移版本 |
| system_dashboard_seeds | 3 | 4 | 原标记不变，增加幂等迁移标记 |
| assistant_records | 4 | 4 | 所有原 BLOB 逐字节保留 |
| assistant_usage | 7 | 7 | 所有原 BLOB 逐字节保留 |
| agent_groups / agent_tasks / agent_task_labels / agent_task_targets | 1 / 3 / 1 / 3 | 1 / 3 / 1 / 3 | 所有原行逐字节保留 |

完整证据覆盖 **45 张原表、43 条原记录**。迁移后共有 45 条记录，新增的是中心内置大盘历史版本与迁移标记。非破坏性断言全部通过。真实 Assistant 配置中的 **1 个加密 API Key 可由原 master.key 成功解密**，报告仅输出 `all_decryptable: true`。OAuth、通知渠道与目录来源各有 0 个真实密钥，因此不把空表当作真实凭据兼容证据；这些类型另有固定 Go 生成密文回归测试。

预期的大盘变更单独断言：原 `system-center` 正文与时间戳在 `dashboard_versions` 中精确保留；原版本号不覆盖；其它大盘及其它旧面板不变；运行协程面板改为 Node 活跃资源，并新增事件循环延迟面板。报告保留 `all_original_rows_preserved: false` 表达当前大盘行确实发生更新，同时记录 `all_old_data_retained: true`，不将预期迁移描述为零变更。

本次脱敏证据：`.local-dev/node-old-data-2026-10-17T14-50-22-050Z/evidence.json`。副本只保存在被忽略的本地证据目录，不提交数据库或 master.key。

复跑：

```sh
cd runtime
node --import tsx test/helpers/old-data-live.ts
```

可用 `LIGHTMONI_OLD_DATA_DIR` 指定旧数据目录；`LIGHTMONI_OLD_DATA_EVIDENCE_DIR` 必须是独立的 `.local-dev/` 子目录。每次默认生成新的副本。

## 真实浏览器与 Node API

运行 `runtime/test/helpers/browser-live.mjs`，复用仓库已有 Playwright 和本机 Chrome，以隔离 QA 管理员在 `http://127.0.0.1:18885` 的实际登录表单登录。没有 route 拦截、假响应、HAR 回放或真实供应商请求。原 Go 服务 8080 未修改；脚本会拒绝将 8080 作为目标。

| 页面 | 路径 | 已验证内容 |
| --- | --- | --- |
| 监控概览 | `/` | 实际 `/api/v1/overview` 返回成功，统计和数据列表渲染 |
| 监控大盘 | `/dashboards` | 实际大盘接口成功，大盘列表与模板区域渲染 |
| 日志探索 | `/logs` | 实际目录接口成功，探索工作台渲染 |
| 告警中心 | `/alerts` | 实际告警组及其它告警接口成功，“告警与通知”工作台渲染 |
| 节点助手 | `/agents` | 实际节点接口成功，节点表格及任务管理标签渲染 |
| 模型管理 | `/admin?tab=models` | 实际模型配置、计价与用量接口成功，管理标签和配置内容渲染 |
| AI 助手 | `/assistant` | 实际会话及配置接口成功，问题输入区渲染 |

本次 **7/7 页面通过，40 次实际 API 响应，pageerror=0，HTTP 5xx=0，请求失败=0，外部请求=0**。七张截图与脱敏请求状态日志位于 `.local-dev/node-browser-live-2026-10-17T14-52-07-938Z/`，日志为 `evidence.json`。截图人工检查了节点助手、模型管理和 AI 助手页面。隔离实例未配置供应商，模型页显示未配置、助手显示配置入口属于预期状态；没有发送生成、测试连接、模型发现或通知请求。

复跑（从仓库根目录）：

```sh
node runtime/test/helpers/browser-live.mjs
```

默认使用隔离 QA 账号。可通过 `LIGHTMONI_NODE_QA_URL`、`LIGHTMONI_NODE_QA_USER`、`LIGHTMONI_NODE_QA_PASSWORD` 和 `LIGHTMONI_BROWSER_EVIDENCE_DIR` 覆盖目标与证据位置。脚本只接受本机地址，复用 `web/node_modules/@playwright/test`，不会安装浏览器或其它工具。
