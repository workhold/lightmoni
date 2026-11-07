# 验收记录

日期：2026-11-07。源码基线：GitHub origin/main `05ca6ee601700008e09969a05088a8c91734e0fc`，独立分支 `codex/099-app-registration-storage`。原工作区的 compose 与发行证据未改动。

## 最终行为

系统仓库不再因其系统身份而永久拒绝注销；确认全部实例已移除、关闭集群镜像复用并解除对外入口/网站等引用后可删除登记。旧 active 聚合不能覆盖已卸载的实例事实。仅停止、未核对 unknown、活动任务（包括网站拥有但操作应用实例的网关任务）仍阻塞。当前和启用发布版本中的手动/托管网站引用均受保护；停用且解除当前引用后，历史修订继续保留而不再永久阻塞。删除事务退役绑定、释放端口，保留修订、执行和远端数据。

应用/网站详情新增宿主机存储清单，按机器、集群、实例显示最近 Agent 回执中的真实挂载与配置路径。网站明确完整 nginx.conf 与分组材料目录的关系；实际 Docker 卷位置来自 Mounts.Source。标准目录以实例 ID 隔离，现有配置摘要、初始化、数据及自定义目录原样保留。每页20个实例，含退役记录；旧 Agent/无新回执显示未观测，GET 不派发任务。字段白名单隔离秘密与其他网站分组；可选元数据超过原60 KiB结果预算时先截断/省略，避免把正常执行变为 unknown。

## 自动检查

- Runtime 类型检查通过：`npm --prefix runtime run typecheck`。
- Web 类型检查与构建通过：`npm --prefix web run typecheck`、`npm --prefix web run build`。仅有依赖包既有 module directive 提示。
- 176 项相关测试：174通过、0失败、2跳过。包含 platform-clusters、platform-store、platform-executor、platform-api、platform-website-routing、managed-executor-jobs、privileged-executor-security、operations-executor。
- 两项跳过是受额外环境条件控制的备份源限制与双容器 Agent 证书同步测试；不将其算作通过。
- `git diff --check` 通过。

复现命令（runtime目录）：

```sh
node --import tsx --test --test-concurrency=1 test/platform-clusters.test.ts test/platform-store.test.ts test/platform-executor.test.ts test/platform-api.test.ts test/platform-website-routing.test.ts test/managed-executor-jobs.test.ts test/privileged-executor-security.test.ts test/operations-executor.test.ts
```

## 真实 Docker 与页面

`LIGHTMONI_DOCKER_LIVE=1 node --import tsx --test --test-name-pattern='real Docker single-container' test/platform-docker-live.test.ts`：1通过、0失败。使用本机 Docker 29.4.3 临时实例；核对实际配置/初始化/数据挂载来源、RO属性，更新后配置改变，运行期初始化修改和业务数据保留，Compose 切换成功。临时容器和目录按测试清理，未操作生产业务。

`node web/src/app/ops/verify-storage-ui.mjs`：隔离HTTP夹具与实际Web渲染通过。覆盖应用卷路径、无回执提示、读取失败恢复、网站完整配置/分组目录、中英文、390px页面与抽屉无横向溢出。报告 `evidence/ui-report.json`，截图保存在忽略的 artifacts/screenshots 对应目录；已查看实际桌面与窄屏截图。该夹具不代表生产各宿主已回读。

当前运行环境是 macOS；未将需要 Linux host 网络的 OpenResty 真实网关用例描述为本轮通过。网站路径与分组契约由执行器/HTTP回归及页面验证。

## 架构同步

适用：新增存储只读清单与 Agent 回执元数据、登记/历史/持久业务存储边界。仓库 `docs/system-design.md` 第99节；Doca [LightMoni 系统设计基线](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53) 同名原生章节和流程图已保存并完整回读。

首次插入因工具将编号标题转成列表并更换ID，使随后段落出现在文首；已按真实ID修复标题属性与顺序，再完整回读确认。最终 seq 1753，原文标题保持，原有941块的顺序、全部内容及原生图完全一致，新章节文字和7节点/5连线图核对通过。证据 `evidence/doca-readback.json`；不将首次保存回执单独视为同步成功。

## 兼容及交付范围

不迁移既有业务数据、不改变 Compose 项目/挂载布局或权限。storage 是可选回执字段；中心可兼容旧 Agent，实际清单需要部署本次 Agent 版本并取得新检查回执。仅停止的实例从此前允许删登记改为要求先卸载，界面返回明确原因。删除系统仓库仍须解除真实依赖。未发布镜像、未部署生产、未合并主干。
