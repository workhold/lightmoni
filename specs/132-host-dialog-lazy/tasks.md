# 任务：主机页按需加载文件、容器与终端弹窗

- [x] T001 核对主机页到 Monaco 与 xterm 的三条静态依赖路径，并在 `spec.md`、`plan.md`、`contracts.md` 固定加载时机和架构影响判断。
- [x] T002 在 `MachinesPage` 按需挂载文件、容器与终端弹窗，加入可关闭的加载反馈。
- [x] T003 在 `HostFilesDialog` 将 `CodeEditor` 延迟到打开文本文件，在 `HostContainersDialog` 将 Compose 子弹窗延迟到点击接管，并保持加载反馈。
- [x] T004 通过构建拓扑、隔离浏览器网络和实际文件/终端交互核验首屏、目录、编辑与终端阶段，记录 `validation.md`。
- [x] T005 同步远端主干、检查差异与相关类型/构建结果，提交给主流程创建 GitHub PR。
