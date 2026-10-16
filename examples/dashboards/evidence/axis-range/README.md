# Y 轴范围验收

本目录的截图、参考图和录屏仅保存在本机 [`artifacts/screenshots/examples/dashboards/evidence/axis-range/`](../../../../artifacts/screenshots/examples/dashboards/evidence/axis-range/)，由 Git 忽略；下文未带路径的图片和录像文件名均相对此目录。文字报告继续保留在仓库中。

2026-10-11：类型检查、24 项相关单元测试通过；最终浏览器验收连续第 1、2、3 轮均通过，无页面脚本错误。主 Agent 查看了桌面图表及桌面、390px 设置截图；本次为局部调整，自检，无独立视觉评审。

图表使用固定 SQL 数值，通过运行中的 Docker API 和 ClickHouse 返回，用于验证范围和视觉位置，不代表真实主机指标。验证脚本创建独立临时大盘，在结束时删除，不修改现有大盘。

- `gallery.png`：包含 0、贴合数据、独立双轴、正负堆叠、全零、常量、面积、可见阈值、对数与样本直方图。
- `editor.png`：单轴范围选择和手动上下限；峰值上方具有更大的刻度值。
- `narrow-editor.png`：390px 设置抽屉，范围与上下限均可操作，无横向溢出。
- `report.json`：最后一轮检查结果及实际提交给 G2 的各轴范围。

还验证了范围选项保存后刷新回显、模拟保存失败时保留草稿并重试成功、清空手动上下限后恢复自动范围。沿用现有显示设置组件，将左轴范围移出双轴折叠区，缩短原有双轴说明；未增加动效。

运行（当前源码的开发服务器需代理运行中的 API）：

```sh
cd web
npm run typecheck
node --test src/features/dashboards/model.test.mjs src/features/dashboards/chart-refresh.test.mjs
LIGHTMONI_UI_URL=http://127.0.0.1:5174 node src/features/dashboards/verify-axis-range.mjs
```
