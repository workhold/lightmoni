# 验收记录：主机页按需加载弹窗

日期：2026-11-13。性能对比基线为 GitHub main 的 `01dff1b76d2f13740bff6b994923fd4d71f51d0b`。提交前主干已推进到 `2b0276055de1ee8be3630303a3c87e23c59346e8`（发布 PR #179，仅 Compose 标签与 SDD 131 文档变化）；本分支已变基至该提交。变基后重新运行构建、类型检查和隔离浏览器验证，均通过。

## 构建与浏览器请求

`npm --prefix web run build` 与 `npm --prefix web run typecheck` 均通过。构建前后相关块如下（Vite 输出字节为十进制 kB）：

| 资源 | 基线 raw / gzip | 本轮 raw / gzip | 首屏请求 |
| --- | ---: | ---: | --- |
| `HostsNodesPage` JS | 443.80 / 130.98 kB | 362.48 / 106.63 kB | 是 |
| `MachineTerminalDialog` JS | 348.24 / 90.00 kB | 345.09 / 88.96 kB | 否；点击终端后请求 |
| `bracketMatching`/Monaco JS | 2858.26 / 732.71 kB | 2858.30 / 732.73 kB | 否；打开文本文件后请求 |
| `HostFilesDialog` JS | 归入其他块 | 30.40 / 11.82 kB | 否；点击文件管理后请求 |
| `HostContainersDialog` JS | 归入其他块 | 42.42 / 14.33 kB | 否；点击容器面板后请求 |
| `ExternalComposeManagement` JS | 归入其他块 | 15.56 / 6.37 kB | 否；点击 Compose 接管后请求 |

隔离 Chromium 使用本轮生产构建并拦截全部 API。`node web/src/app/verify-host-lazy-assets.mjs` 通过；原始请求清单见 [lazy-assets.json](evidence/lazy-assets.json)。主机首屏请求 28 个 JS/CSS 资源、原始体积合计 3,121,222 字节，未请求三个弹窗、Monaco 或 xterm。随后按“容器清单 → 文件目录 → 文本编辑 → 终端 → Compose 接管”顺序打开：各阶段分别新增 46,464、32,230、2,971,464、352,796 和 19,116 字节。容器清单和文件目录阶段都没有 Monaco 请求；Compose 阶段已复用先前文件编辑阶段加载的 Monaco。原始体积不是耗时或 gzip 传输量，不据此推断生产网络延迟。

分别人为阻塞三个弹窗模块及 Compose 子弹窗加载并关闭占位弹窗：文件管理未创建文件会话，终端未创建终端会话，容器未请求清单，Compose 未读取接管资源；模块稍后完成也没有重新挂载。正常打开文件管理由列表账户元数据发出一次 `POST file-session`，包含根目录，关闭发出一次释放；无额外主机详情读取。终端模块挂载后沿用有效默认凭据的自动连接；关闭仍在创建中的会话会发出删除请求。现有终端清理逻辑对同一在途会话会发出两次幂等删除，本轮未更改。非管理员路径未读取 `/machines`，无文件管理入口。浏览器无页面脚本异常。

`node web/src/app/verify-host-file-maintenance.mjs` 使用临时真实 OpenSSH/SFTP 和 SQLite，3 轮文件浏览、创建、编辑、快捷保存、重命名、权限、删除、结果未知与中英文/窄屏交互均通过；缺少列表账户元数据时的详情回退通过。该脚本生成的既有 SDD 117 证据文件已恢复，本轮没有改写其历史证据。

## 架构同步与兼容

不适用：仅改变现有浏览器组件和静态块加载时机。服务端授权、API、SSH 会话、数据/控制路径、凭据边界及部署拓扑均未变化；无需同步 `docs/system-design.md` 或 Doca。静态文件继续采用现有内容哈希命名及 SDD 131 缓存头。冷缓存首次点击弹窗需要下载独立块，加载占位可见且可关闭；已缓存后复用浏览器资源。
