# Validation

日期：2026-10-19。基于 `origin/main` 的 `d2130b3`，功能分支 `feat/data-access-management`。

## 服务与接口

- `npm --prefix runtime run typecheck`、`npm --prefix runtime run build` 通过。
- `npm --prefix runtime test`：193 项，190 通过，0 失败，3 跳过。跳过项为 opt-in 真实 Agent/ClickHouse、真实 ClickHouse 生命周期和 Linux 发布包检查，本次没有把这些跳过项当作已验收。
- 新增 `runtime/test/access-credentials.test.ts` 8 项，覆盖管理员/成员/匿名权限、目录白名单与最近 200 条、GET 无写入的有效过期状态、撤销幂等/404/409、撤销后拒绝兑换与激活、pending 的双重期限及按节点/用途撤销全部凭据。相关既有凭据及托管主机测试同时通过。
- 本地使用原 `.lightmoni` 数据目录重启平台，健康检查通过；`/api/v1/setup` 仍为 `required:false`，未重置用户或配置。`/data`、`/data-management`、`/admin?tab=credentials&section=sdk` 返回 200；匿名访问两个 Agent 凭据目录均为 401。此处仅做只读检查，没有撤销真实节点或更改真实密钥。

## 前端

- `npm --prefix web run build` 通过（包含 TypeScript 构建检查）。保留 Vite/Ant Design 原有打包警告，无新增构建失败。
- `node --experimental-strip-types web/src/app/verify-sdk-reporting-choice.mjs` 通过：当前三种发布语言 × 两种上报方式 × 1280/390 宽度，验证地址保持、代码/环境变量复制、非法地址、容器提示，以及跳转接入凭据再返回仍保留 SDK 草稿。证据：`sdk-ui-report.json`。
- `node web/src/app/verify-access-management.mjs` 通过：13 组交互、120 个隔离 API 请求，0 页面错误/意外请求。覆盖三类凭据状态与管理操作、确认撤销、SDK 密钥明文关闭后 DOM 清除、后台页签卸载重载、旧深链、表级时长保存与日志设置入口、加载失败重试及成员权限。六个页面在 1280/390 宽度均无页面横向溢出，另验成员窄屏；已人工检查桌面 SDK 密钥页与窄屏数据管理截图。结果见 `ui-report.json`，截图保存在本地忽略目录 `artifacts/screenshots/specs/015-data-access-management/`。全部 API 使用隔离状态化 fixture，不接触真实平台；此测试不代表浏览器到真实数据库的写入端到端验收。
- 页面验证发现新建密钥弹窗关闭后 Ant Design 缓存隐藏内容；已加 `destroyOnHidden`，验收包含关闭后 DOM 不再保留明文。
- 两个既有集成脚本 `verify-self-monitoring.mjs`、`verify-retention-context.mjs` 已更新旧深链/新页面标题及 AI 上下文断言，并通过 `node --check`。未运行完整脚本：它们所需隔离后端、ClickHouse 及专属 fixture 未启动，且含写操作，不指向用户运行中的平台执行。

## 兼容范围

- 原 SDK 密钥 API、逻辑表权限和旧版 Agent Key 路径保持兼容；新节点仍使用独立 control/data 凭据。
- 接入令牌与节点目录只返回元数据，明文和哈希不会进入列表；各类凭据不能互换。
- 旧 keys/tables/templates 深链分别转到统一凭据、数据管理和监控大盘。成员只能查看数据目录，不能进入管理员凭据页面或执行管理操作。
- 未改 SDK/Agent 上报协议、数据库结构或大盘模板 API；未运行 SDK 原生工具链或额外供应商模型调用。
