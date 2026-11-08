# 验收记录

## 结果

- `npm --prefix web run typecheck`：通过。
- 主 Agent 连续运行三轮既有 `verify-catalog-ui.mjs`：每轮覆盖中文/深色/1440px、英文/浅色/1440px、中文/浅色/390px、英文/深色/390px。高级设置收起时安装位置、宿主端口及监听范围可见；服务标识收起时隐藏、展开后可见。每轮 DBX 通过真实隔离 HTTP 接口创建资源，响应不含测试密码，Agent 工作保持待执行；pageerror 均为空。
- 三轮结果：[round-1/ui.json](evidence/round-1/ui.json)、[round-2/ui.json](evidence/round-2/ui.json)、[round-3/ui.json](evidence/round-3/ui.json)。
- 原生浏览器手动核验 Redis：无需打开高级设置即可切换自选位置，唯一集群与在线机器正常显示；端口填写 16379，展开/收起高级设置、触发缺失密码校验、切回自动选址后仍保留 16379。高级设置保持可收起。
- OpenResty：常规区域展示安装位置和固定宿主机 80/443 提示，无可编辑端口字段。
- 桌面、窄屏及 200% 图片已由主 Agent 实际看图；局部字段间距与原样式一致，没有新增遮挡或文字溢出。小改动自检，未启动独立视觉评审，不打分；未新增动效。
- 减法：将自动说明中的「端口」移除，避免自定义端口时与说明矛盾；没有添加重复说明或装饰。

## 证据与复现

图片按仓库约定保留在忽略目录 `artifacts/screenshots/specs/106-install-basic-settings/evidence/`，包括 before.png、after-default.png、custom-port-validation.png、openresty-fixed-ports.png、各轮 dbx-basic 截图及 zoom-200/page-@2x.png。文本证据见 [browser-checks.json](evidence/browser-checks.json) 与 [zoom-report.json](evidence/zoom-report.json)。

截图工具记录了一条既有 `/favicon.ico` 404；安装字段加载正常，不将该资源错误记为产品逻辑通过或修复。首次截图遇到抽屉入场过程；取证脚本改为滚动到监听范围并等待元素稳定后截图，最终三轮基于该版本连续执行。

使用可丢弃的 `app-install-ui-server.ts`（127.0.0.1:19976）与工作树 Vite（127.0.0.1:5199），测试数据与生产隔离。没有执行外部 Docker、真实 DNS 或生产安装。

```sh
LIGHTMONI_CATALOG_UI_URL=http://127.0.0.1:5199 \
LIGHTMONI_CATALOG_UI_OUT=specs/106-install-basic-settings/evidence/round-1 \
node web/src/app/ops/verify-catalog-ui.mjs
```

架构同步：不适用。仅移动既有前端字段，详见 spec.md；未修改仓库系统设计或 Doca 文档，未声称完成在线同步。
