# 告警助手浏览器验收

日期：2026-10-18。使用独立 Vite、Playwright Chrome 和全量 API fixture 拦截；不修改真实告警，也不调用付费模型。

- [完整报告](evidence.json)：12 组交互检查，包含确认前零写入、重复点击、权限、版本冲突、过期、历史状态、页面上下文和刷新。
- [回执报告](receipt-evidence.json)：提前结束静默后的实际服务器时间、完整结果及中文工具标签。
- [桌面卡片](desktop.png)、[确认对话框](confirmation.png)、[390px 页面](mobile.png)、[实际回执](receipt.png)。

从仓库根目录运行：

```sh
npm --prefix web run dev -- --host 127.0.0.1 --port 18887 --strictPort
```

在另一终端运行，需要本机可用的 Playwright Chrome：

```sh
node scripts/verify-alert-controls-ui.mjs
LIGHTMONI_TEST_SCENARIO=receipt node scripts/verify-alert-controls-ui.mjs
```

可通过 `LIGHTMONI_TEST_BASE_URL` 和 `LIGHTMONI_TEST_OUTPUT` 修改服务地址和输出目录。报告中的 `apply_posts=3` 来自独立的成功、冲突和成员确认场景；每次明确确认只发一个 POST。报告不代表真实供应商模型的诊断效果或生产环境部署验收。
