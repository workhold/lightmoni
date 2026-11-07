# 验收

## 修复和本地验证

线上只读查询确认两个已卸载应用都存在 retired=1/state=stopped/desired_state=removed 的旧 Agent 实例，且带有已认证 current_machine_binding/零容器恢复审计。没有执行线上删除来复现问题。

修复新恢复回执的终态，并对旧记录核对原始成功回执、completed 恢复记录、实例/应用/机器、旧新 Agent 及当前机器绑定。伪造或缺少 observed_json/回执、失败回执、容器仍存在、机器绑定变化、旧 Agent 在线仍阻断；有网站引用也继续阻断。

Runtime/Web 类型检查及构建通过。`runtime/test/platform-clusters.test.ts` 85项通过，0失败、0跳过，覆盖上述旧记录场景、正常卸载删除、停止/未知结果阻断和保存/发布网站引用保护。

主 Agent 执行 `node web/src/app/ops/verify-resource-actions-ui.mjs`，最终连续三轮通过，每轮6组交互检查，0 pageerror，0写请求。覆盖应用/网站监控路由、图标可访问名称、32px点击范围、悬浮与键盘提示、更多菜单、删除确认取消、新建网站表单、中英文和1440px/390px视口。早期夹具已修正中文确认按钮空格与关闭/重排等待；真实筛选框溢出已通过约束控件宽度修复。开发服务器共输出6条组件库Tooltip的React flushSync提示，无未处理页面异常；不将其表述为控制台零警告。

自行查看应用桌面/窄屏、网站桌面/英文窄屏截图，监控按钮统一为蓝色折线图，操作使用同套Ant Design图标，菜单和确认保留文字。此为局部控件改动的主Agent自检，没有独立评审。截图按仓库规则保存于本地 `artifacts/screenshots/specs/103-resource-actions/evidence/`，文字报告在本目录。

架构不适用：修复既有退役/删除契约和现有页面入口，无新增协议、权限、存储布局、部署拓扑或控制入口。系统设计基线无需改写。

## 发行与线上

待合入、成品镜像核验及指定1Panel终端部署后补充。
