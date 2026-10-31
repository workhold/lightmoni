# 设计验证记录

日期：2026-11-01（Asia/Shanghai）。代码基线 `f2fd1d54d8ba384c5007bcb4b3f8e8e2a80fd53b`。

本次仅交付 SDD/HLD/LLD 与目标契约；没有实现 root 执行器、修改主机权限、执行 SSH、构建镜像或部署。

## 研究与独立评审

- 核对 1Panel 安装器/Agent unit/Docker client 与 Cockpit bridge/提权入口的官方源码；引用固定提交。Socket Proxy 仅作为 API 过滤边界对照，不当成参数授权实现。
- 执行协议审查确认普通脚本同 UID、control 凭据及 claim/payload/events/result 的完整迁移要求；补充显式提权脚本，不再把所有 root 脚本一概排除。
- 独立权限审查修复：30秒许可不使用60秒请求时差容忍，采用包含挂起的单调截止；脚本/容器输出作为可能含秘密的敏感正文；封闭 named volume driver_opts/DriverConfig 和 namespace 借用。
- 独立登记与生命周期审查修复：统一 disabling/unknown；区分首次SSH引导与既有执行器策略更新；程序回退不回滚journal/fence/已消费授权和防重状态。
- 代码复用补充审查：统一源码/发行与双组合根；root拒绝仅限普通角色常驻运行，不破坏root安装器的check/configure；两个unit不能仅修改User；root journal不得吞错或丢unknown，双角色版本/GC/卸载分别核对。

## 文档检查

- 专项设计与系统设计第60章共四张 Mermaid，通过 Mermaid 11 解析器语法检查；临时依赖仅安装在本机 `/tmp`，未修改项目依赖。
- 新增文档的相对链接和章节锚点检查通过；README 指向系统基线及专项设计。
- `git diff --check` 通过；变更不包含凭据、机器身份、实机日志或用户网络地址。
- 纯文档变更未运行代码单元测试；后续 root/sudo/Docker/提权脚本实机测试仍在 tasks 中未完成。

## Doca

同步目标：[LightMoni 系统设计基线](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53)。从902保存到903，最新版本回读验证37个新增块；两张原生图分别为9节点/9连线、10节点/10连线，文字、节点、连线与几何一致。原有626个块、31张原生图和原内容顺序全部保持不变，包括其他开发中的章节。

无秘密证据见 [doca-sync.json](doca-sync.json)。未执行浏览器视觉验收，不将结构回读说成视觉通过。Doca MCP context与运行时凭据会话已关闭。

设计 PR：[#47](https://github.com/workhold/lightmoni/pull/47)，未合入；实现任务保持未完成。
