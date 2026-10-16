# 本地验收图片与录屏

截图、设计参考图和验收录屏统一存放在 `artifacts/screenshots/`，Git 和 Docker 构建上下文均忽略此目录。文件按原仓库路径归档，例如：

- `docs/evidence/<任务>/a.png` → `artifacts/screenshots/docs/evidence/<任务>/a.png`
- `examples/dashboards/evidence/a.png` → `artifacts/screenshots/examples/dashboards/evidence/a.png`
- `web/src/features/logs/evidence/a.jpg` → `artifacts/screenshots/web/src/features/logs/evidence/a.jpg`
- `examples/logs/results/a.png` → `artifacts/screenshots/examples/logs/results/a.png`

Markdown 验收记录、JSON 报告与测试数据继续保留原路径。文档中的本地图片链接只在对应文件存在时可用，新克隆仓库需要重新执行相关验收脚本生成图片。

浏览器验收脚本通过 `scripts/qa-artifacts.mjs` 的 `mediaDirectory()` 计算图片与录屏目录。新增脚本沿用此函数，手动截图也存入对应的归档目录。显式指定仓库外的输出目录时沿用该位置。
