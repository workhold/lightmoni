# Validation

2026-11-04，分支 `codex/fix-duplicate-install`，基于同步后的 `origin/main` (`a9588e6`)。

## Root cause and result

真实浏览器 + HTTP/SQLite 夹具复现了截图错误：唯一集群中添加第二个部署行后，overview 刷新使默认值补全把两行都设成同一集群和机器，安装返回 400 / `duplicate_application_deployment`。

默认补全现在排除已选集群，新增行受集群数量约束，表单先检查重复集群，后端错误显示中英文操作指引。验收还发现高级资源字段原来在 Form.List 外按数组索引注册，移除部署后可能补回空部署。资源字段和新增按钮现统一使用原列表的 fields/add 和稳定 field.key，并通过 portal 保持原高级面板位置；移除后其余部署的自定义内存仍保留。

不修改后端约束、请求协议、存储或生产数据；同一 request_id 重试和真实未知结果边界保持。

## Checks

- `cd runtime && node --import tsx --test test/platform-clusters.test.ts`：42/42 通过，包括新增 Gitea 重复请求原子拒绝、修正为双集群安装、幂等重试和自动选址。
- `cd runtime && node --import tsx --test test/application-catalog.test.ts test/application-install.test.ts`：10/10 通过。
- runtime / web 的 `npm run typecheck` 均通过；`cd web && npm run build` 通过。构建输出依赖包的 module-level `use client` directive 警告，无构建错误。
- `cd web && node src/app/ops/verify-catalog-deployments-ui.mjs`：7组场景通过，pageerror 为空。单集群禁止多加、刷新不重复、自动选址、多集群增删与剩余行内存1792保留、旧重复草稿阻止提交并可修正、中英文错误保留输入与 request_id、OpenResty 区域/资源字段在折叠面板后完整提交。见 [ui.json](evidence/ui.json)。
- 截图人工检查：1440px 中文和390px英文错误说明换行正常，输入保留。媒体保存于忽略目录 `artifacts/screenshots/specs/092-catalog-deployment-duplicates/evidence/`。
- `git diff --check` 通过；提交前重新 fetch，基线与 `origin/main` 无偏离。

## Repeat browser verification

仅在临时 loopback 夹具中运行，要求初始资源为空。三个独立终端分别执行：

```sh
cd runtime
LIGHTMONI_OPS_QA_PORT=19961 node --import tsx test/fixtures/cluster-ui-server.ts
```

```sh
cd web
LIGHTMONI_DEV_API_URL=http://127.0.0.1:19961 npm run dev -- --port 5197 --strictPort
```

```sh
cd web
node src/app/ops/verify-catalog-deployments-ui.mjs
```

该脚本使用真实安装 HTTP、领域控制器和 SQLite；后端错误翻译使用定向400夹具，旧草稿验证临时挂载真实字段组件，并在结束时删除临时页面。未执行远端 Docker、公共 DNS、生产安装或发版。201 证明资源已创建和请求已处理，不表示远端应用已运行。

## Architecture parity

不适用：修复既有安装表单的默认值、动态字段生命周期和错误展示；API、组件职责、数据/控制路径、凭据边界、存储和部署拓扑均保持。仓库 `docs/system-design.md` 与 [Doca 基线](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53) 无需改写，未声称进行在线同步。
