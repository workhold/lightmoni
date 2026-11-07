# 验收记录

日期：2026-11-07。最终布局取代本 SDD 前版的旧目录清单。GitHub origin/main `05ca6ee601700008e09969a05088a8c91734e0fc`，独立分支 `codex/099-app-registration-storage`，沿用 PR129。原工作区的 compose 与发行证据未改动。

## 最终行为

- 已卸载应用允许删除登记，仍检查当前实例、活动/未知作业和资源引用；系统仓库解除真实依赖后允许注销。应用数据、修订和执行历史保留。
- 应用默认目录为 `applications/<application_id>/instances/<instance_id>/`，配置、初始化、数据及私有清单在此之下；默认命名卷同时含应用与实例 ID，显式外部路径或卷保留覆盖语义。应用改名不搬目录，副本不意外共享数据。
- 网站根为 `websites/<website_id>/`，版本包含独立 nginx.conf、SSL、鉴权哈希、认证探针、静态文件和私有元数据，current 指向当前版本。网关仅保留非秘密 include 索引与版本映射；更新一站不改写其他站版本。
- 网站删除先停用路由并清理 DNS，逐宿主清除网关历史引用与归属网站目录，全部确认后注销。持久逐机进度跨重启、离线和重复请求保留；已知失败重试，unknown 先核对而不盲目重放。共享中心证书和应用数据保留。路径穿越、符号链接、归属不符、运行网关仍引用均拒绝清理。
- 管理员可查看实际挂载、应用根和网站配置/SSL/鉴权/静态目录，以及逐机删除进度；202 不误报成功。无新版回执显示待检查/升级。签名布局作业需 `operations.platform.storage.v2`，旧执行器不能领取。

## 自动检查

Runtime 类型检查、Web 类型检查与构建、`git diff --check` 均通过。Web 构建只有依赖包既有 module directive 提示。

相关测试244项：239通过、0失败、5跳过。复现命令（runtime 目录）：

```sh
node --import tsx --test --test-concurrency=1 test/platform-*.test.ts test/instance-recovery-review.test.ts test/managed-executor-jobs.test.ts test/privileged-executor-security.test.ts test/operations-executor.test.ts
```

5项跳过分别是受额外条件控制的备份源限制、双容器 Agent 证书同步，以及原有3项 opt-in Docker/OpenResty 测试，不将跳过算作通过。另运行本次新的 Linux Docker 验收如下。最终收紧归属检查、只读清理核对和恢复路径后，相关执行器/恢复用例23项再次全部通过。

## 真实 Linux Docker 与页面

`runtime/test/storage-layout-live.mjs` 在明确 opt-in 的一次性 Linux 容器中运行，使用本机 Docker daemon、临时受管根及唯一资源 ID，不操作生产实例。运行前 `npm --prefix runtime run build`；镜像需包含 Node 与 Docker CLI/Compose，设置 `LIGHTMONI_STORAGE_LIVE=1`，使用 host 网络并挂载 Docker socket 与源码的同一绝对路径。

真实验证5组全部通过，报告 `evidence/storage-v2-live.json`：

1. 应用 ID / 实例 ID 目录及真实 Docker 命名卷；初始化不覆盖，卸载后持久数据与卷保留。
2. OpenResty 实际 include 独立网站版本，静态页面、TLS 和 Basic 鉴权可用，私钥0600，网关状态不包含秘密。
3. `nginx -t` 通过但重载后健康验证失败时，恢复旧网关索引并等待旧版本验证，网站指针及另一个站服务正常。
4. 更新网站A不重写B；非法配置预检失败保留活动版本。
5. 活动引用阻止清理；撤下后删除网站目录和历史索引引用，SSL/auth/static 随站点清理，其他网站及应用数据保留，重复删除幂等。临时容器、卷和目录最终清理。

`node web/src/app/ops/verify-storage-ui.mjs`：隔离HTTP夹具与实际Web渲染通过。覆盖真实格式的应用/网站路径、无回执、读取失败、202离线删除进度、中英文、1440与390px，页面/抽屉无横向溢出、无运行时错误。报告 `evidence/ui-report.json`，截图在忽略的 artifacts/screenshots 对应目录，已实际查看桌面与窄屏画面。夹具不代表生产主机已部署新版本。

## 架构同步

适用：目录归属、只读容器挂载、网站版本/删除控制路径、回执与能力协议变化。仓库 `docs/system-design.md` 第99节，与 Doca [LightMoni 系统设计基线](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53) 原生章节和流程图同步。

保存 seq1756 后以最新版本完整回读19页，955个原生块；7段目标文字、11节点/8连线图与预期一致，其他947个块的内容、样式、原生图及顺序完全不变，标题保留。包含并保留其他并行新增的仓库管理内容。证据 `evidence/doca-readback.json`。

## 兼容及交付范围

按用户确认，项目尚未上线，直接采用layout v2，不做旧目录迁移、双布局运行或旧文件删除。新布局作业要求新版执行器，旧存储回执在清单中为null。业务网站删除会清理其归属目录；应用卸载/登记删除保留数据。仅提交功能分支及更新 PR；未合并、发布镜像或部署生产。
