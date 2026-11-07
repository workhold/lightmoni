# 验收

## 修复和本地验证

线上只读查询确认两个已卸载应用都存在 retired=1/state=stopped/desired_state=removed 的旧 Agent 实例，且带有已认证 current_machine_binding/零容器恢复审计。没有执行线上删除来复现问题。

修复新恢复回执的终态，并对旧记录核对原始成功回执、completed 恢复记录、实例/应用/机器、旧新 Agent 及当前机器绑定。伪造或缺少 observed_json/回执、失败回执、容器仍存在、机器绑定变化、旧 Agent 在线仍阻断；有网站引用也继续阻断。

Runtime/Web 类型检查及构建通过。`runtime/test/platform-clusters.test.ts` 85项通过，0失败、0跳过，覆盖上述旧记录场景、正常卸载删除、停止/未知结果阻断和保存/发布网站引用保护。

主 Agent 执行 `node web/src/app/ops/verify-resource-actions-ui.mjs`，最终连续三轮通过，每轮6组交互检查，0 pageerror，0写请求。覆盖应用/网站监控路由、图标可访问名称、32px点击范围、悬浮与键盘提示、更多菜单、删除确认取消、新建网站表单、中英文和1440px/390px视口。早期夹具已修正中文确认按钮空格与关闭/重排等待；真实筛选框溢出已通过约束控件宽度修复。开发服务器共输出6条组件库Tooltip的React flushSync提示，无未处理页面异常；不将其表述为控制台零警告。

自行查看应用桌面/窄屏、网站桌面/英文窄屏截图，监控按钮统一为蓝色折线图，操作使用同套Ant Design图标，菜单和确认保留文字。此为局部控件改动的主Agent自检，没有独立评审。截图按仓库规则保存于本地 `artifacts/screenshots/specs/103-resource-actions/evidence/`，文字报告在本目录。

架构不适用：修复既有退役/删除契约和现有页面入口，无新增协议、权限、存储布局、部署拓扑或控制入口。系统设计基线无需改写。

## 发行与线上

代码及Compose固定版本经[PR135](https://github.com/workhold/lightmoni/pull/135)合入main，发行源码为`af712cfffa3a9d68bb0fb08d245a760d74039a7d`。

双平台镜像`docker.heyphp.com/lightmoni/lightmoni:20261107-resource-actions-v1`已发布。固定索引`sha256:90bbd6b5205242c814a0362c472bc38085973f62690e16fcbf71891b97ad70b7`，amd64/arm64的实际根文件系统、配置和revision与经过测试的本地成品一致，所有blob SHA256、远端HEAD、manifest/config和固定索引回读通过；latest保持原值。每个架构45项成品检查、85项平台回归及7项仓库协议回归通过；临时服务、数据卷及运行时凭据已清理。

通过指定1Panel终端，当前配置、环境、主密钥和一致性SQLite快照已备份到root私有`/opt/lightmoni/backups/sdd103-20261107`。快照322211页，quick_check=ok，容器副本和宿主复制文件的SHA256一致；未输出密钥值。对两个旧实例的真实原始回执只读查询确认completed/succeeded、absent=true、container_count=0，实例、机器及旧新Agent绑定均一致。

线上拉取的索引和revision与发行记录一致。仅替换既有Compose的镜像标签，经配置校验后执行`up -d --no-build --pull never --wait`；中心与原ClickHouse健康。中心启动时间`2026-11-07T06:09:27.567490067Z`，revision如上，原`lightmoni_lightmoni-state-v2-20261103 -> /data`保留，公网healthz=ok。既有未使用旧卷标签警告保留，没有为消除警告删除卷。

使用新成品的`instanceRemovalConfirmed`对线上数据库只读执行，两个目标应用的当前removed实例及有认证回执的旧stopped实例全部返回true；没有改数据库或提交线上DELETE。ABC Demo仍被`abc.heyphp.com`托管服务配置引用，此项有效保护需要先解除绑定。Gitea公网HTTPS200、Registry未认证HTTPS401，鉴权边界保留。

正式Chrome刷新应用页面后，新图标可见；点击Gitea监控进入对应应用ID，CPU、内存、网络、磁盘曲线和running容器可见，默认采集成功时间14:10:55。点击网站图标进入Gitea对应网站ID，QPS、耗时、真实访问日志可见，14:10:44请求HTTP200，采集成功时间14:11:35。

指定`/dashboards`列表5个大盘，上报中心13面板全部加载，未见查询错误；QPS0.13、最近一分钟接收352、在线中心1、上报失败0。最终应用页Gitea、OpenResty、SDD091快速安装、系统Registry全部运行中；两项已卸载应用与未部署DBX保持原意图。DBX在重启后的回执等待期间曾短暂待处理/保留地址，下一次巡检恢复运行中，未篡改健康时效或隐藏状态。

最后通过指定终端只读复核，中心更新后16条平台执行全部succeeded，失败/unknown为空，核验时无排队项。DBX公网HTTPS200，中心再次确认healthy及同一revision。此检查包含重启后更新的旧执行，不只筛选重启后新创建的执行。
