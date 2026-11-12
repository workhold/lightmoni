# 任务：面板响应与文件管理会话

## 阶段一：规格与基线

- [x] T001 在 `specs/131-panel-responsive/spec.md` 记录用户场景、状态实际来源、文件连接瓶颈和验收条件。
- [x] T002 在 `specs/131-panel-responsive/plan.md` 与 `contracts.md` 固定会话、静态缓存及兼容契约。

## 阶段二：主机页响应（US1）

- [x] T003 [US1] 在 `runtime/src/server/managed-machines.ts` 优化心跳状态列表读取并暴露观测时间，不引入 SSH。
- [x] T004 [US1] 在 `web/src/app/MachinesPage.tsx` 独立呈现主机响应、限制重叠刷新并展示状态观测时间。
- [x] T005 [US1] 在相关 `runtime/test` 与 `web/src/app` 验证状态 GET 无 SSH、页面慢辅助请求与定时刷新行为。

## 阶段三：文件管理交互（US2）

- [x] T006 [US2] 在 `runtime/src/server/machine-files.ts` 实现有界文件会话、授权绑定、串行 SFTP、过期与关闭；保留无会话头兼容。
- [x] T007 [US2] 在 `runtime/src/server/managed-machines.ts` 保证文件会话失效、目标与凭据检查足够轻且不放宽撤销边界。
- [x] T008 [US2] 在 `web/src/app/HostFilesDialog.tsx` 建立、复用与释放会话，过期只在操作开始前重建，写入未知不自动重试。
- [x] T009 [US2] 在 `runtime/test/machine-files.test.ts` 等定向夹具验证真实 SSH 复用、跨会话拒绝、撤销/变化/超时关闭及原文件安全契约。

## 阶段四：前端缓存（US3）

- [x] T010 [US3] 在 `runtime/src/server/app.ts` 实现 HTML 不缓存、版本化资源长期缓存、未版本化资源有界缓存及缺失资源 404。
- [x] T011 [US3] 在 `runtime/test` 验证 GET/HEAD 与实际 `web` 构建的内容哈希 URL。

## 阶段五：设计同步与交付

- [x] T012 在 `docs/system-design.md` 更新第 107 章和新增第 131 章；同步 Doca 对应章节并用最新版本回读文字、原生图节点与连线，在 `specs/131-panel-responsive/validation.md` 记录证据。
- [x] T013 运行相关类型、测试、构建与差异检查；同步 GitHub `main`，在 `specs/131-panel-responsive/validation.md` 记录结果。
- [ ] T014 推送 `codex/131-panel-responsive` 到 GitHub `origin` 并创建面向 `main` 的 Pull Request，描述最终行为、兼容影响、架构章节、Doca 链接与回读结果。

T003–T005、T006–T009 和 T010–T011 可在规格完成后按文件并行；T012–T014 依赖实现与验证结果。主机页和缓存可独立验收；文件会话须同时验收服务端安全与浏览器生命周期。
