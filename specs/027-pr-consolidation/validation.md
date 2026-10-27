# 验收记录（2026-10-27）

## 整合范围与冲突

以 `origin/main` 的 `a7e5fe2` 为基线，保留已合入的运维能力和镜像发布配置。四个原 PR 的固定 head 如下：

| 原 PR | 固定 head | 保留内容 |
| --- | --- | --- |
| [#1](https://github.com/workhold/lightmoni/pull/1) | `0edb5fdae55ca473015edd0480e827562d1eca76` | Apache-2.0、贡献与安全说明、开源入口、SDK 模块路径和许可打包 |
| [#3](https://github.com/workhold/lightmoni/pull/3) | `b2e56120bfc9436beda0c9cf7446da2c023e0276` | GitHub 为主仓库、通过 PR 合入的协作规则 |
| [#4](https://github.com/workhold/lightmoni/pull/4) | `add298f0418b06b8866c064e978f2732595a4d39` | 五分类导航、当前组展开、其余默认收起、图标模式、成员过滤 |
| [#5](https://github.com/workhold/lightmoni/pull/5) | `fbcb78abe742c8bfd2879d00e72db22e043d72d5` | 1Panel 能力调研与分批建设路线 |

- README 保留 main 的 `20261027-operations` 镜像示例；没有回退至旧标签。
- 导航冲突中保留 main 的页面懒加载、管理员 `/operations` 路由、登录回跳与权限逻辑；新增“网站与运维 / Websites & operations”菜单入口，顶部标题和 AI 页面上下文沿用“运维工具 / Operations”。
- 调研明确历史基线 `0735d26fd29ff54b956e7a30d5b988a30bef9d17`，代码证据链接固定至该提交，并指向 SDD 026 已落地能力及当前运维手册；项目当前许可修正为 Apache-2.0。
- 独立只读复核通过：原四 PR 的有效变更完整保留，未发现阻塞问题。

## Web 与导航

- `npm --prefix web run typecheck`、`npm --prefix web run build` 通过；构建包含 `tsc -b`，产物在被忽略的 `runtime/public`。第三方 `use client` 和大块体积提示仍存在，无构建错误。
- `node --test web/src/app/*.test.mjs`：17/17 通过。
- 使用本次生产构建和管理员、成员两个临时只读 API fixture，所有非 GET 请求返回 405；不连接真实后台、不修改账户、不执行 SSH、部署或模型调用。完成后停止 fixture 服务、关闭测试标签并恢复临时视口。
- 管理员 `/operations`：默认只展开运维分类，包含主机、节点、服务部署、网站与运维四项；既有网站、证书、容器、备份、计划任务页面正常加载。
- 键盘 Return 可收起当前组；点击系统设置只展开该组；访问个人设置后，浏览器返回 `/operations` 自动恢复运维组并关闭系统组。
- 切换英文后菜单为 `Websites & operations`，页面顶部和 H1 为 `Operations`；图标模式有 13 个唯一路径，只有 `/operations` 带 `aria-current="page"`。
- 成员直接访问 `/operations` 跳转 `/settings`；运维分类只有节点助手，`/agents` 显示只读提示。图标模式共有 9 个入口，隐藏 `/machines`、`/services`、`/operations`、`/admin`，只有 `/agents` 高亮。
- 390×844 成员图标模式截图检查通过；页面宽度与视口均为 390，无横向溢出。1280×600 管理员图标模式导航可滚动到底，管理后台入口中心可接收点击，未被 AI 按钮遮挡。
- [脱敏界面验收摘要](ui-report.json) 记录观察结果及最终 fixture 请求计数。成员没有请求管理员运维或服务 API，`rejected_writes=0`；这验证前端导航与路由行为，不代表重新验证后端权限或业务执行。

## SDK 与开源

- Go：`go test -race -mod=readonly ./sdk/go` 通过，六个示例包编译通过；TypeScript SDK 18/18、Python SDK 32/32、Rust SDK 3/3 通过，Rust doc-test 无测试。
- 四种 SDK 实际打包通过，生成四个归档与 `SDK_SHA256SUMS`；根 LICENSE 与 TypeScript、Python、Rust 随包 LICENSE 一致，Go 归档包含同一许可。SpecKit、Doca 等第三方原有 MIT 声明保留。
- Python wheel 构建通过，包含 `License-Expression: Apache-2.0`、`dist-info/licenses/LICENSE` 和四个 GitHub Project-URL；Python 构建后端要求 `setuptools>=77`，运行要求仍为 Python>=3.9。
- 本机工具为 Node 22.23.1、Python 3.9.6、Go 1.27.2、Rust 1.99.1。未覆盖 Go/Rust 最低支持版本。Rust 默认索引获取受网络影响，改用命令级公开 rsproxy 索引缓存，以 `--offline --locked` 完成测试；未改用户全局 Cargo 配置或锁文件。
- 外部 Go 使用者需要把旧模块导入与 `replace` 路径更新为 `github.com/workhold/lightmoni`；HTTP 上报协议、SDK 运行逻辑和依赖版本未改变。SDK 测试、构建和产物检查由独立审查在临时隔离目录完成，产物不入库。

可复核的 SDK 命令（Go 在仓库根，其余在相同源码的临时副本根）：

```sh
go test -race -mod=readonly ./sdk/go
go test -mod=readonly ./examples/...
npm --prefix sdk/typescript test
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=sdk/python python3 -m unittest discover -s sdk/python/tests -v
cargo --config 'source.crates-io.replace-with="rsproxy-sparse"' --config 'source.rsproxy-sparse.registry="sparse+https://rsproxy.cn/index/"' test --offline --locked --manifest-path sdk/rust/Cargo.toml --target-dir /tmp/lightmoni-pr1-sdk-audit-jcdyy0fu/rust-target
sh scripts/build-sdk-release.sh 0.1.0 /tmp/lightmoni-pr1-sdk-audit-jcdyy0fu/releases
python3 -m venv /tmp/lightmoni-pr1-sdk-audit-jcdyy0fu/py-venv
/tmp/lightmoni-pr1-sdk-audit-jcdyy0fu/py-venv/bin/python -m pip --isolated --disable-pip-version-check install 'setuptools>=77' wheel
/tmp/lightmoni-pr1-sdk-audit-jcdyy0fu/py-venv/bin/python -m pip --isolated --disable-pip-version-check wheel --no-deps --no-build-isolation --wheel-dir /tmp/lightmoni-pr1-sdk-audit-jcdyy0fu/wheels ./sdk/python
```

`--offline` 复核需要预先具备对应公开依赖缓存；wheel 构建环境实际使用 setuptools 82.0.1、wheel 0.48.0。

## 文档与差异检查

`git diff --check origin/main` 通过。变更 Markdown 的 75 个本地相对链接目标存在、代码围栏配对，JSON 可解析。针对相对主干的增量执行私钥头、Doca/GitHub token、AWS access key 模式检查，没有命中；这不等同于重新执行全历史秘密审计，原迁移审计范围与限制保留在 SDD 025。

## 架构与交付边界

架构同步不适用：本次改变许可、SDK 包标识、协作流程、历史调研说明和导航展示，不改变运行组件职责、数据或控制路径、凭据、存储、协议、部署拓扑及 AI 工具边界；无需改写系统设计或 Doca。

整合 PR 是本次统一交付入口；按用户授权在校验后合入，再关闭被覆盖的四个旧 PR。最终操作状态以整合 PR 时间线为准。本次不发布镜像、不更新线上容器或远程 Agent；合入源码后，线上界面仍需构建发布新镜像并升级才会显示。
