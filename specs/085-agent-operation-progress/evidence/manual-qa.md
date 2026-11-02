# SDD085 隔离浏览器验收

- 日期：2026-11-02
- 结果：11/11 检查通过；`results.json` 为自动结果记录，`unexpected` 为空。
- 环境：独立 Vite fixture、Playwright Chromium；所有 API 请求被 fixture 拦截，无生产访问、真实 SSH 或主机操作。
- 检查：主机列表按主机隔离进度；单台和批量流程逐阶段更新；只读 GET 超时后保留进度并提示刷新、重试恢复时清除提示；唯一 apply 请求不会重放；unknown 卸载显示最后可证阶段 50%、停止活动状态与 elapsed 计时；只有 succeeded 为 100%；跨主机/操作身份校验；关闭视图停止轮询；中英文、暗色与 390px 窄屏；迟到响应不会覆盖完成状态。
- 人工查看截图：`terminal-states-zh.png`、`uninstall-unknown-zh.png`、`uninstall-en-dark-390.png`、`batch-independent-zh.png`、`install-timeout-recovered-zh.png`。中英文窄屏布局可读；未见横向溢出。
