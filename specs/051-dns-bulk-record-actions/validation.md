# 验收记录

日期：2026-10-31（北京时间）。独立工作区，基于 GitHub origin/main；未操作当前 SDK 工作区、真实云 DNS、生产环境或 Gitea。

## 最终行为

- DNS 记录支持逐条/当前页全选与跨页选择，批量删除以及仅改类型、仅改 value、同时修改；每批最多 50 条。
- 同一主机记录、解析类型、线路、TTL、优先级、启用状态可逐行填写多个 value 批量创建，空行忽略且完全相同的 value 去重。
- 确认窗口固定目标和版本，预览准确数量、原值/新值及线路。每条串行请求都有原有 confirmed/revision；不会引入批量事务或自动重试。
- 逐条显示成功、失败、待回读、结果未知和未执行；通信中断保守标记未知；权限/版本冲突停止后续。执行中禁改输入和关闭，支持停止后续。
- 单条编辑、创建、删除、启停仍沿用原有 API；更新保留 ID、TTL、线路 ID、优先级、权重和停用状态。单条显式修改线路时移除旧线路 ID，避免 DNSPod 忽略新的线路。
- 批次结束刷新，成功项退出选择，失败/待核对项保留；删除最后一页时回退到有效页。刷新失败提示独立核对，不掩盖逐条回执。

## 自动检查

| 检查 | 结果 |
| --- | --- |
| `node --test web/src/app/ops/dns-batch.test.mjs` | 7/7，通过；多 value、64 位 ID、字段保留、数量限制、部分失败、未知/待回读、停止、授权/版本冲突 |
| `cd runtime && node --import tsx --test test/platform-cloud-certificates.test.ts` | 19/19，通过；阿里云/DNSPod CRUD、授权、作用域、未知写入不重放、分页及 64 位 ID 等既有契约 |
| `npm --prefix web run typecheck` | 通过 |
| `npm --prefix web run build` | 通过；构建仍有现有依赖的 use client 指令及大 chunk 提示 |
| `node web/src/app/ops/verify-dns-bulk-ui.mjs` | 8 组场景通过，13 个操作请求，页面脚本错误 0 |
| `git diff --check` | 通过 |

浏览器覆盖：跨页勾选、全选、取消零写入、仅改类型/仅改 value、共用线路多 value 创建、双击防重、51 条拦截、202 业务失败/未知/待回读、停止后续、执行期锁定、删除末页回退、搜索/同步清空、50 条选择上限、零字段拦截、单条功能回归、中英文及 390px。成员按既有路由守卫进入个人设置，无法打开域名操作入口。

结果见 [模型报告](evidence/model-tests.txt)、[浏览器报告](evidence/ui-report.json)。浏览器夹具拦截全部 API，不使用云凭据、不发真实 DNS 请求。真实云平台套餐、线路权限、外网 DNS 缓存传播没有在本次验收中验证。

截图由脚本生成在忽略目录 `artifacts/screenshots/specs/051-dns-bulk-record-actions/evidence/`，包含桌面多 value 预览、部分失败/未知/待回读结果、390px 固定操作区域。

## 架构影响与审阅

不适用。仅在浏览器内组合既有逐记录 API，未改变服务器职责、数据/控制路径、存储、协议、凭据、AI/工具边界或部署拓扑。仓库 `docs/system-design.md` 与 [Doca 系统设计基线](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53) 均无需修改，本次未执行 Doca 写入或宣称回读同步。

差异审阅核对了：未选择字段不会覆盖、未将厂商记录 ID 转为 number、202 失败不显示成功、未知请求不重放、选择清理、分页竞态和组件退出停止后续。主分支仅通过 PR 合入，未获得合并授权时不合并。
