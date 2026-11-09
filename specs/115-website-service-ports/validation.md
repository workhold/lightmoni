# 验收记录

日期：2026-11-09。基线：GitHub `origin/main`（`c5ef07a`）；使用独立工作区，未修改原工作区的 Compose 或发行证据。

## 最终行为与兼容

手动部署不限制网站绑定，网站仍只接受 TCP 上明确声明为 HTTP/HTTPS 的命名端口。其他端口展示但禁选，未选服务、未声明端口和没有兼容协议分别给出操作提示。已有 HTTP/HTTPS 标签及网站保存契约不变，不把数据库或未知 TCP 推断成 HTTP。

单容器及 Compose 高级 YAML 显式 app_protocol 不再被已有空白/TCP/旧协议覆盖；省略字段仍沿用旧值。单容器生成 YAML 及转换回表单保留协议与命名端口身份，手动宿主映射保持不变。已有 YAML 显式声明与旧值不一致时，今后按文档内显式值保存；服务器仍校验协议允许值及网站引用。

## 验证结果

- `node --import tsx --test test/platform-website-routing.test.ts test/platform-clusters.test.ts`：115/115 通过，见 [runtime-tests.txt](evidence/runtime-tests.txt)。新增真实 HTTP/SQLite 回归覆盖手动单容器/Compose 从空协议、TCP 修正到 HTTP/HTTPS，命名端口/宿主映射保持，两种网站服务绑定保存回读，省略协议保留旧值，无效协议拒绝且不增加修订。
- `node --test src/app/ops/application-yaml.test.mjs`：3/3 通过，见 [yaml-form-tests.txt](evidence/yaml-form-tests.txt)。涵盖 YAML 生成/表单往返、外部显式协议、旧协议覆盖、显式清空及缺省保留。
- Web 与 Runtime 类型检查通过，见 [web-typecheck.txt](evidence/web-typecheck.txt)、[runtime-typecheck.txt](evidence/runtime-typecheck.txt)；`git diff --check` 通过。
- `node web/src/app/ops/verify-website-service-ports-ui.mjs`：五组真实网页/隔离 API 检查通过，pageerror 为 0，见 [browser.json](evidence/browser.json)。从真实应用 YAML 编辑补充 HTTP 标记，再分别保存逐集群服务后端和自动服务发现；确认非 HTTP 端口禁选、空声明提示、英文和 390px 窄屏。
- 主 Agent 查看禁用端口下拉、HTTP 选择后和英文窄屏三张实际截图，确认文字换行、禁用选项、保存按钮和页面宽度。截图按仓库约定仅保存于本地 `artifacts/screenshots/specs/115-website-service-ports/evidence/`。

## 影响判断与交付边界

架构同步不适用：既有字段在原配置转换及选项展示内修正，HTTP/HTTPS 服务端边界、资源契约、存储、服务发现、发布路径、凭据与部署拓扑均不变。`docs/system-design.md` 无受影响章节；Doca [LightMoni 系统设计基线](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53) 无需同步，没有执行或声称在线写入/回读。

验收使用临时 SQLite、真实 HTTP 路由与当前网页，远程 Agent、SSH 和外部云调用关闭。不包含生产更新、实际容器部署或真实网站连通性验收；修复仍需经 PR 合入和后续发行才能在线生效。当前未声明协议的已有 Web 服务仍需明确配置实际 HTTP/HTTPS 协议。

已创建面向 main 的 [GitHub PR #157](https://github.com/workhold/lightmoni/pull/157)，未合入。浏览器执行期间开发控制台存在 React flushSync 生命周期提示；没有 pageerror，相关表单保存、回读及视口断言均通过，此次未扩展处理该提示。
