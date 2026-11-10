# 验收记录：单机内存图显示总内存

日期：2026-11-10。

## 最终范围

用户取消原“系统监控机器负载”需求；相关 SDD119-system-machine-load 已撤回，未写入任何该功能应用代码。本次只修改 HostMonitoring 的内存图标题，展示当前机器已有容量，保留原曲线与查询。

## 验证

- `npm --prefix web run typecheck`：通过。
- 本地 Vite/React + Playwright：9 个状态通过，0 个页面异常。使用拦截的本地 API 夹具，只验证展示，不声称真实 Agent/ClickHouse 集成验收。
- 1440px 中文浅色、英文深色；390px 中文深色、英文浅色：16.0 GiB 总内存标题可见、文字未裁切、无页面横向溢出。已实际查看截图。
- 切换机器显示 8.0 GiB；未知、0、负数容量显示 unknown；既有 15 秒容量轮询更新为 32.0 GiB。
- 保留内存 used/available/total 查询与机器参数。脚本初次因选择器同时匹配标题与下拉图标而停止，收紧选择器后完整通过；产品代码无额外修复。
- `git diff --check`：通过。提交前已 `git fetch origin`，基于当时最新 `origin/main`（47e9969）。

报告：[browser-report.json](evidence/browser-report.json)。截图按仓库规则保留本地 `artifacts/screenshots/specs/119-host-memory-total/evidence/`，不提交二进制媒体。未新增单元测试或运行无关全量测试；本次为可逆的局部展示改动。

## 架构与兼容

架构同步不适用：只把现有响应的容量显示在图标题，组件职责、读取与控制路径、API、协议、凭据、存储及部署均不变；docs/system-design.md 与 Doca 系统设计基线无需改写。无需升级 Agent。
