# 验收记录

日期：2026-11-01。当前功能分支的隔离浏览器、SQLite 和 HTTP 验证；未修改线上网站、主机或权威 DNS。

- `runtime/test/website-management-state.test.ts`：未发布、部分集群未发布/失败、已同步、unknown、停用、策略版本差异、实际域名成员为空时的历史停用/配置集群、DNS 资格与厂商最近回读分别判断。与主机/网站相关回归合计 95/95 通过，命令见 SDD078 验收。
- `LIGHTMONI_UI_RUN=1/2/3 node src/app/ops/verify-website-management-ui.mjs`：最终界面连续三次通过，每次 7 组断言、零页面错误；结果在 `evidence/ui-{1,2,3}/results.json`。采用真实隔离 HTTP/SQLite 完成网站保存和入口解析修改；发布/健康/DNS 观测与 action 回执明确使用浏览器夹具，不代表远端执行。
- 覆盖显式发布确认、取消零请求、revision/cluster/confirmed 请求、保存不隐式发布并打开详情、入口字段必填/格式提示、409 保留输入、修改目标集群且其他 spec 保持不变、unknown 先检查、DNS 具体原因、英文/深浅主题、390px/200%、减少动态效果。
- SDD076 上游 URL 浏览器回归覆盖原始无协议输入、路径/查询/凭据等错误、首错聚焦、服务端兜底、静态/返回/应用命名端口/托管分支；相关脚本已适配网站列表与保存后详情。最终代码在独立干净夹具连续三次通过（每次9组、零页面错误），证据沿用 SDD076。
- Web/Runtime `npx tsc --noEmit -p tsconfig.json`、`git diff --check` 通过。本次流程整理未运行生产构建或全量测试。

## 界面与复查

基线与最终截图位于 `artifacts/screenshots/specs/077-website-management-flow/evidence/`，采用现有导航、Ant Design、主题变量和语义状态色。查看了桌面、390px、200%、中英文、深浅主题、发布确认、保存详情和入口表单；首次进入、编辑展开采用实际 180ms CSS 动画的 0/90/180ms 重播采样，发布按钮记录按下/释放三帧。减少动态效果有浏览器断言。

按 oil-ui 流程完成隔离存量界面评审，不打分。评审指出 390px 入口说明裁切、200% 地址弹窗裁切，以及浅色列表截图仅为加载态；已修正说明换行和弹窗视口约束，补拍加载完成后的浅色内容。独立复查确认两项裁切消失、浅色列表可辨识，无阻塞问题。主代理亦查看最终截图；实际滚动/点击由浏览器断言验证，静态评审不代替业务验证。

架构同步不适用：SDD077 仅重组既有表单、列表与确认操作。联动的主机存储/取址变更由同一 PR 中 SDD078 同步仓库和 Doca，记录在其 `doca-readback.json`。

交付：[GitHub PR #62](https://github.com/workhold/lightmoni/pull/62)，目标 `main`，实现提交 `c2f313c`；已同步远端主干 `fe99013`，未合入或部署。PR 描述覆盖最终行为、兼容边界、架构章节、Doca 回读与验证范围。
