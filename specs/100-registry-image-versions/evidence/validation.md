# SDD100 验收记录

日期：2026-11-07；功能分支：codex/100-registry-image-versions；基于 GitHub origin/main 开发，保留原工作区发布改动。本次不发布镜像、不操作现有镜像库。

## 结果

- runtime/web TypeScript 检查通过；git diff --check 通过。
- 针对性后端测试 95/95 通过：Registry HTTP 协议分页、完整扫描、摘要别名、多架构依赖、全部仓库清理、读取失败零删除、部分拒绝与未开启删除、传输不确定性；管理员/部署/执行器能力门槛、系统与普通商店仓库删除配置隔离、跨集群与旧部署/Compose 引用、写入围栏、领取复验、unknown 同作业审计解除，以及既有受管执行回归。完整结果见 runtime-tests.txt。
- 浏览器连续三轮通过：ui-pass-1.json、ui-pass-2.json、ui-pass-3.json。覆盖部署选择、按镜像筛选、版本与应用引用、翻页、空镜像、错误重试、取消不删除、全仓库清理范围、重复点击保护、结果刷新、中英文、页面刷新后恢复清理跟踪、部分失败警告。前端使用仅监听回环地址的契约 fixture，不冒充生产 E2E。
- 本机独立 Registry 3.0.0 真实 HTTP 验收通过：两个镜像库、三个 manifest 摘要，删除两个未引用摘要，保留被引用摘要及 stable/v2 两个标签；旧摘要 GET=404、使用中摘要 GET=200、重复清理删除数为0。见 registry-real.json。临时容器与数据未连接任何既有仓库，验收后移除。
- 视觉证据：versions-desktop.png（1440×1100）、versions-mobile.png（390×844）、versions-zoom.png（200%）、cleanup-review.png（完整确认框）。独立存量界面评审不打分；补齐移动横向滚动提示及确认框截图等待 opacity=1 后复查通过。动效复用现有 Button loading / Table Spin / Modal；未制作录屏，不声称完成动态视觉验收。

## 架构同步

适用：新建 registry.inspect/registry.cleanup 控制路径、全局引用快照、持久清理写入围栏、系统仓库删除配置。仓库 docs/system-design.md 第100章与 [Doca 系统设计基线](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53)第100章同步。Doca 保存确认后在 seq=1755 逐块回读五段文字完全一致；既有 images059-registry-flow 的10个节点与10条连线完整回读，内容一致。见 doca-readback.json。

Doca 新建原生流程图接口连续两次返回500，未继续重试，采用文字同步并保留既有图块；没有声称新图保存成功。旧图及无关章节未重建。在线段落稳定 ID 保持既有写入时的 sdd099-registry-content-*，不因 SDD 编号最终选为100而更换锚点。

## 兼容与边界

需升级中心及具备 operations.platform.registry.v1 的受管执行器；既有系统仓库需重新部署，开启 manifest 删除。普通商店 Registry 的默认删除配置保持关闭。单仓库拓扑、数据目录和凭据不变。

清理会短暂阻止应用/网站写入与新的 apply；unknown 需通过同作业审计或已有机器恢复证据解除。只判定平台登记引用，外部直接推送导致的可变标签变化不在围栏内。只删除 catalog/tags 可枚举的历史版本，不在线 GC，不承诺立即回收镜像层磁盘。

## 复现

在仓库根运行：

```sh
node --import ./runtime/node_modules/tsx/dist/loader.mjs --test runtime/test/platform-registry-images.test.ts runtime/test/platform-clusters.test.ts runtime/test/platform-registry-auth.test.ts runtime/test/managed-executor-jobs.test.ts
npm --prefix runtime run typecheck
npm --prefix web run typecheck
```

浏览器：启动 `node scripts/serve-registry-images-qa.mjs`，另一个终端运行 `node web/src/app/ops/verify-registry-images-ui.mjs`，脚本自动连续验证三轮并输出证据。

真实 Registry：仅对临时测试容器运行以下命令，验证后删除同名测试容器。

```sh
docker run -d --name lightmoni-registry-100-qa -p 127.0.0.1::5000 -e REGISTRY_STORAGE_DELETE_ENABLED=true -e REGISTRY_HTTP_DEBUG_ADDR=127.0.0.1:0 registry:3.0.0
node --import ./runtime/node_modules/tsx/dist/loader.mjs scripts/verify-registry-images.mts
docker rm -f lightmoni-registry-100-qa
```
