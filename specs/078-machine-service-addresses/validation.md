# 验收记录

日期：2026-11-01。主机内外网候选与手动修正已在隔离环境完成；未修改生产主机服务地址、发布网站、写入生产 DNS 或部署新版本。

## 后端与状态

Runtime 中运行：

```sh
node --import tsx --test --test-concurrency=1 test/machine-service-addresses.test.ts test/host-network.test.ts test/host-observed-identity.test.ts test/managed-machines.test.ts test/platform-website-routing.test.ts test/website-management-state.test.ts
```

结果 95/95 通过。覆盖管理员权限、独立 revision/SSH 目标代次、错误类型/字段/范围、原子失败、IPv4/IPv6 手动覆盖、自动网卡优先、数字 SSH/公网来源候选、代理内网与容器/隧道排除、SSH 域名不解析、心跳更新不覆盖手工值、Agent 替换保留手工值并排除旧观测、恢复自动、主机删除清理。

网站 NAT 集成使用真实 SQLite/控制器和受控 Agent/DNS 厂商响应：私网网卡与代理来源不能产生公网 A 或网站 CNAME；状态指出缺少公网服务地址的机器。管理员确认公网地址后，A 使用指定公网，CNAME 指向入口域名，内部端点继续使用私网。此证据不代表真实公网端口可达或公网缓存传播。

Runtime/Web 类型检查通过；`git diff --check` 通过。

## 浏览器与视觉

采用 `test/fixtures/website-management-ui-server.ts` 的真实主机 API/SQLite，外部 SSH、Agent 接入和云请求禁用。Web 中运行 `LIGHTMONI_UI_RUN=1/2/3 node src/app/verify-machine-service-addresses.mjs`，最终实现连续三次通过，每次 5 组断言、零页面错误。仅 revision 冲突响应使用受控 409；实际保存、恢复自动和刷新均从真实 API 回读。

验证候选不隐式保存、内外网范围错误定位字段、冲突保留输入、真实操作者与来源、独立恢复自动、中文/英文、深浅主题、390px/200% 和减少动态效果。200% 额外断言关闭、保存和公网候选“采用”可见；滚动公网区不遮挡固定操作区。首次出场、采用候选字段展开记录实际 180ms CSS 时间轴三帧，保存记录按下/释放反馈。

结果在 `evidence/ui-{1,2,3}/results.json`，截图在同名 `artifacts/screenshots/specs/078-machine-service-addresses/`。SDD077 的隔离视觉评审同时核对此表单，发现的 200% 裁切已修正并复查通过。

## 架构同步

有架构影响：中心新增 `machine_service_address_settings`、管理员 GET/PUT 接口与服务地址优先级，并增加托管入口缺公网地址的 DNS 资格原因。Agent 网卡协议、凭据、AI 权限、DNS 归属与部署拓扑不变；无网卡快照的历史数字地址兼容保留。

仓库 `docs/system-design.md` 的第64/78节与 [Doca 系统设计基线](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53) 在同一 SDD/PR 同步。Doca 保存确认且最新 seq=922 回读第64段、SDD078 标题/4段/原生图：8节点、8连线与提交内容逐项相同。原第71节原生图的8节点/10连线保持逐项相同，根标题不变，块数由727增至733，未对无关块执行替换。详见 `doca-readback.json`。首次编号标题规范化问题已按真实块ID修正，最终标题、章节与图块回读确认；不以保存回执代替回读。

交付：[GitHub PR #62](https://github.com/workhold/lightmoni/pull/62)，目标 `main`，实现提交 `c2f313c`；已同步远端主干 `fe99013`，未合入或部署。PR 描述覆盖最终行为、兼容边界、架构章节、Doca 回读与验证范围。
