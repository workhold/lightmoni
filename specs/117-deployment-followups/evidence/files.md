# 文件维护与本地高亮验收

2026-11-09，SDD117 T012—T014。仅操作临时 OpenSSH/SFTP 服务、临时密钥/目录及内存 SQLite；未写真实业务主机、未部署生产。

## 实现

- `runtime/src/server/machine-files.ts` 新增 `GET /api/v1/machines/:id/file-metadata?path=...` 与 `POST /api/v1/machines/:id/file-actions?path=...`。保留真人管理员 cookie、选定 SSH 账户/凭据租约、主机指纹、撤销/取消检查及 no-store；无 shell 或隐式提权。
- file-actions 为严格字段白名单：`operation=create|mkdir|rename|remove|chmod`、`confirmed=true`、`expected_version`。create/mkdir 要求 `expected_version=new` 及 `parent_version`；rename 只接受同目录的新 `name`，不覆盖目标；chmod 为 `0000..0777` 八进制字符串；remove 不接受 recursive，目录必须为空。根、链接、特殊文件拒绝。
- 维护版本独立于正文版本：普通文件只使用 size/mtime/mode/uid/gid，不下载大文件正文；目录版本还覆盖有界直接子项的名称和元数据版本。目录清单超过 2,000 项拒绝维护，避免截断清单被当成完整版本。创建绑定父目录版本，写后读取实际类型/模式/路径/不存在结果。列表新增条目版本和目录版本。
- 创建采用排他 open/mkdir；文件0600、目录0700。chmod 使用已核对的 SFTP handle，避免跟随末级链接。可能已写后回读失败、断线或权限改变记为 unknown，并返回 `file_action_unverified`；审计只包含动作/操作者/主机/SSH账户/路径/结果，不含正文或秘密。
- `HostFilesDialog.tsx` 补新建文件/目录、行操作菜单、精确路径确认、模式输入、非递归删除说明、失败保留输入。未知结果保留目标和输入，禁用原窗口重复确认，提示关闭后刷新核对；HTTP响应丢失和5xx同样按未知处理。成功才刷新目录或打开新文件。
- `web/src/shared/CodeEditor.tsx` 统一文件和 `ops/ResourceFields.tsx` 的 Compose/高级 YAML 输入。Monaco、worker及语言定义均从锁定依赖本地加载，无CDN/远端schema。按文件名选择 YAML、JSON、shell、JS/TS、Python、INI、HTML/XML/CSS/Markdown、Dockerfile/nginx，未知类型回退文本。保持原字符串和 Form value/onChange，继承 Form disabled，跟随明暗主题，支持查找和文件 Ctrl/Cmd+S。
- 实际验收发现 Monaco 默认自动缩进会改写多行输入；已关闭自动缩进、粘贴/输入格式化、缩进推断与自动空白修剪，严格核对中文、引号、换行和 `$VALUE` 原样保存。

## 验证

- `npm --prefix runtime run typecheck`：通过。
- `npm --prefix web run typecheck`：通过。
- `node --import tsx --test test/machine-files.test.ts`（runtime目录）：6项全部通过，无跳过；输出见 `files-runtime.txt`。包含真实HTTP→SSH/SFTP新建/目录/改名/chmod/删除及回读；超过8MiB文件的元数据维护；旧版本、父目录并发新增、同名目标、未确认、非法模式/名称、根/链接、非空目录、recursive字段、成员权限及审计；原有编辑/上传/指纹/边界回归。独立故障注入检查写后回读失败保留 mutationStarted。
- `node src/app/verify-host-file-maintenance.mjs`（web目录）：最终连续3轮通过，报告见 `files-ui.json`。真实临时SSH后端，Vite源码界面；检查创建、键盘保存后的HTTP/SFTP精确字符串回读、重新打开、实际着色、草稿放弃取消、重命名冲突保留输入、chmod列表回读、取消删除不写、确认删除、目录创建/非递归删除。对真实创建后客户端响应注入503，核对未知提示/输入保留/禁用重试/刷新发现实际对象。实际 ResourceFields YAML检查Form字符串与继承禁用。中英/明暗/390px及720px等效200%布局，无页面横向溢出；页面错误和外部HTTP请求均为0。
- `git diff --check`：涉及文件通过。

## 界面复核

沿用现有运维弹窗和文件列表，文件名/目录与正文仍为主内容；新增动作放工具栏与行内菜单，确认只展示目标和必要参数，没有新增视觉系统。主代理自检截图，未另派独立视觉评审。

已实际查看桌面YAML、390px文件列表/编辑区、暗色200%编辑器和实际应用YAML配置截图。图片与每轮视频保存于本地忽略目录 `artifacts/screenshots/specs/117-deployment-followups/evidence/`：`files-yaml-light-1440.png`、`files-zh-390.png`、`files-zh-editor-390.png`、`files-en-dark-200percent.png`、`files-resource-yaml-dark.png`、`files-delete-confirm.png`、`files-video/`。弹窗进入、编辑区淡入、按钮加载/成功反馈沿用现有动效，尊重 reduced-motion；视频记录真实操作过程。

## 边界

SFTP v3元数据时间为秒级，没有远端事务CAS；独立元数据版本不能识别同大小、同秒mtime且其他元数据不变的正文变化，也无法消除最终检查与rename/unlink间的外部竞争。正文保存仍沿用原有内容摘要守卫。目录仅核对直接子项，不递归维护或清空；chmod需要能安全打开目标handle，权限收紧后无法完整回读时返回未知而不假报成功。原编辑1MiB、上传8MiB、账户权限与OpenSSH原子扩展要求保持。

主代理集成后再次运行最终脚本，内部连续3轮全部通过，终端证据 `files-ui-final.txt`。验证服务使用独立临时Vite缓存和关闭HMR/监听，避免并发QA服务互相重建依赖缓存；生产配置不变。
