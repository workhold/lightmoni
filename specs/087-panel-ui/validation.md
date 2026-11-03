# Validation

## 已验证

- 真实 React 组件使用本机127.0.0.1:19887隔离内存 API，不连接生产数据库、SSH、Docker、DNS或仓库凭据。
- 网站配置连续三轮：修改名称、跳转不同配置节、模拟409、输入保留、再次保存、浏览器刷新并读回新名称。三轮均通过，见 evidence/ui-rounds.json。使用 CUA 浏览器执行，没有把旧 Playwright 脚本说成已运行。
- 应用服务名搜索、无匹配结果、真实状态筛选计数；列表与计数共用同一个状态过滤函数。新增定向单测覆盖失败/unknown归组、等待/未部署、运行、停止及空集合；连同网站发布/DNS状态测试4/4通过。
- 停止仍打开原确认窗口；删除登记仍显示解除引用/持久化数据提示，均取消，未派发操作。unknown时仅展示核对入口，停止和卸载禁用；已停止时显示启动，停止禁用，卸载保留。
- 390×844应用/网站/配置弹窗与1366×900网站列表实际看图，document scrollWidth等于clientWidth，无页面横向溢出。手机筛选工具栏重排为两列，长镜像摘要有完整DOM文本及tooltip。
- 浅色与深色均实际看图并记录状态颜色，深色选择刷新后保留。临时浏览器视口已复位。
- 独立静态视觉评审一轮，不打分；反馈和处理见 evidence/visual-review.md。
- Web TypeScript检查、fixture语法检查、git diff --check通过。没有运行与本次改动无关的全量测试。

## 尚待收尾

- 桌面自动化检测到Mac锁屏，已请求用户解锁；原生200%放大和窗口键盘检查待补，不能把390px截图描述为200%实测。
- 证书同步任务按需展开、新的空筛选说明、最终版本截图、GitHub PR和发布状态在后续收尾记录。

## 证据位置

现场画面保存在忽略目录 `.local-dev/panel-ui-087/`：applications-before.png、applications-light.png、applications-mobile.png、websites-light.png、websites-1366.png、websites-dark.png、websites-mobile.png、website-editor-light.png、website-editor-mobile.png、save-failure-input-preserved.png、unknown-state-disabled-actions.png。

浅色早期画面在最终收尾时刷新替换；截图中的资源与计数属于隔离fixture，不是生产实时指标。三处轻量反馈沿用列表入场、导航收放与组件菜单/弹窗；只验证可观察状态，未声称完整录屏动效评审。

## 架构与兼容

架构变更不适用：仅前端呈现、既有事件入口和组件状态，不新增 API、协议、数据结构、权限、凭据或部署拓扑，仓库设计与Doca无需改写。显式保存的浏览器主题、强调色、导航偏好不迁移；仅缺省主题改为浅色。证书同步任务默认收起，可通过任务数量或行箭头展开。表单字段始终挂载，路径与序列化不变。
