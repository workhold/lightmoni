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
- 证书同步任务默认折叠，点击“同步任务 · 0”展开原任务面板并显示空状态；折叠/展开画面均回读。
- 最终浅色应用/网站截图已刷新，网站动作对齐、服务标识及 DNS 厂商确认边界均可见。
- 通过864×418 iframe视口在1728×836画面中等比放大两倍，检查网站列表、配置弹窗、固定保存栏与Tab聚焦名称输入框。此项为模拟200%放大，不是原生Chrome缩放。临时预览HTML不进入产品提交。

## 验收边界与发布

- 桌面自动化检测到Mac锁屏，已请求用户解锁；未执行原生桌面200%缩放。浏览器扩展内的键盘Tab及模拟放大已通过，不把390px截图或模拟放大描述为原生缩放实测。
- 镜像源提交为13a2f326840e7f8b80afe48b241246122c49434c；后续变动仅补验收文档、隔离fixture及发布元数据。linux/arm64与linux/amd64各42项成品检查通过，另外各自通过编译成品的私网地址HTTP/TCP健康探测。AMD64使用本机Docker仿真，ClickHouse为隔离ARM64实例。
- 固定镜像`docker.heyphp.com/lightmoni/lightmoni:20261103-13a2f32`；双架构索引SHA256为`4e7722c28fc226262da4e8eeddabe65a3294e24fc4f3dc23c3ce63e627530951`。已核对37个本地OCI blob的SHA256及其与实测镜像完全一致的rootfs/config。远端发布、线上备份和升级后的回读结果以[PR #82](https://github.com/workhold/lightmoni/pull/82)发布验证节为准，本地镜像通过不等于已在线升级。

## 证据位置

现场画面保存在忽略目录 `.local-dev/panel-ui-087/`：applications-before.png、applications-light.png、applications-mobile.png、websites-light.png、websites-1366.png、websites-dark.png、websites-mobile.png、website-editor-light.png、website-editor-mobile.png、save-failure-input-preserved.png、unknown-state-disabled-actions.png、certificates-dark.png、certificates-expanded-dark.png、hosts-dark.png、websites-simulated-200.png、website-editor-simulated-200.png。

截图中的资源与计数属于隔离fixture，不是生产实时指标。三处轻量反馈沿用列表入场、导航收放与组件菜单/弹窗；只验证可观察状态，未声称完整录屏动效评审。

## 最终线上验收补充

新版UI已随最终镜像20261103-1bfd49c上线。CUA实际回读1728×836生产页面：四个应用当时均运行，三个网站已发布并显示HTTPS，网站DNS提示保留“厂商已确认”的范围；页面scrollWidth等于clientWidth。实际公开Demo按钮请求成功。生产截图、升级、DNS/HTTPS/私有镜像和备份证据统一记录于../090-ui-delivery-isolation/evidence，不把隔离fixture计数当作生产结果。

## 架构与兼容

架构变更不适用：仅前端呈现、既有事件入口和组件状态，不新增 API、协议、数据结构、权限、凭据或部署拓扑，仓库设计与Doca无需改写。显式保存的浏览器主题、强调色、导航偏好不迁移；仅缺省主题改为浅色。证书同步任务默认收起，可通过任务数量或行箭头展开。表单字段始终挂载，路径与序列化不变。
