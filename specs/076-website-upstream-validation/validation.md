# 验收记录

日期：2026-11-01。基于 GitHub `origin/main` 的 `fe99013`，使用独立工作树和功能分支，不包含原工作区的 Agent 维护开发。

## 结果

- `npm --prefix web run typecheck`：通过。
- `npm --prefix runtime run typecheck`：通过。
- `npm --prefix web run build`：通过；现有依赖的 `use client` bundler 警告不影响产物。
- `cd runtime && node --import tsx --test --test-concurrency=1 test/platform-website-routing.test.ts test/platform-nginx.test.ts`：22/22 通过。
- `cd web && node src/app/ops/verify-website-upstream-ui.mjs`：9 组浏览器验收通过，无 pageerror。使用生产网页构建、隔离 SQLite 与真实 HTTP API。详细结果见 [evidence/results.json](evidence/results.json)。
- `git diff --check`：通过。提交前重新 fetch `origin/main`，与当前基线无差异，无需处理冲突。

## 关键行为

1. 原始输入 `127.0.0.1:5000` 在所属集群的“后端 URL”输入框下显示“请以 http:// 或 https:// 开头，例如 http://127.0.0.1:5000。”；输入框标红。保存时自动滚动并聚焦，不显示顶部保存失败，不发送保存请求。
2. 无协议、非 HTTP(S)、路径、查询/片段、账号密码分别显示对应原因；空地址、删除全部后端与第二集群错误也会阻止提交，保留其他输入。
3. 修改为 `http://127.0.0.1:5000` 后真实创建成功，两个集群的 IPv4/IPv6、末尾根斜杠规范化及失败次数/恢复时间回读正确。API 独立验证无效创建不产生资源，无效编辑保持原名称、修订和配置。
4. 错误出现后切换应用命名端口、托管服务、返回/重定向、静态网站均能保存；隐藏的无效 URL 不干扰相应分支。
5. 三个服务器上游错误的兜底翻译经注入 400 响应验证；它们不冒充真实服务器故障。中文、英文和 390px 通过；已查看桌面与窄屏截图，字段提示和保存按钮可见、页面无横向溢出。

截图保存在本地 `artifacts/screenshots/specs/076-website-upstream-validation/evidence/`，未提交位图。运行浏览器验证前，在 runtime 目录执行 `LIGHTMONI_OPS_QA_PORT=19976 node --import tsx test/fixtures/platform-ui-server.ts` 启动全新隔离 API，在 web 目录执行 `LIGHTMONI_DEV_API_URL=http://127.0.0.1:19976 npm exec -- vite preview --host 127.0.0.1 --port 5176 --strictPort` 预览构建。测试仅保存配置，不部署或派发 Agent 动作；结束关闭 fixture，删除临时 SQLite。

## 兼容与架构

API、服务端接受范围和持久化格式不变，不自动补写协议或移除路径。不影响现有已保存网站。架构同步不适用：仅现有网页校验/提示/定位，`docs/system-design.md` 与 [Doca 系统设计基线](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53) 无受影响章节，未写入或声称完成 Doca 同步。

此记录不代表用户生产网页已部署或真实 OpenResty 已成功代理。
