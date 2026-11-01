# 任务

## 本轮设计交付

- [x] 核对当前 root/sudo、Agent 运行账户、任务与运维接缝。
- [x] 调研 Cockpit、1Panel 与 Docker socket proxy 并给出取舍。
- [x] 完成需求、HLD/LLD、目标契约、分期与验收清单。
- [x] 完成独立设计评审和文档检查。
- [x] 同步仓库系统设计与 Doca 原生图，最新版本回读并保留证据。
- [x] 创建 GitHub 设计 PR，明确未实现状态（[#47](https://github.com/workhold/lightmoni/pull/47)）。

## 实施进度（开发中）

- [x] A1：主机预检结构化 root/sudo 结果、登记提示和授权/实际状态 UI。
- [x] A2：同一发行包双组合根与共享执行组件；executor安装身份、root目录、受信中心、独立出站协议和签名/防重；启动UID与代码所有权校验。
- [x] A3：任务 lineage、执行主体的全接口门控、统一授权事务与持久锁。
- [ ] A4：生命周期计划/关闭/升级/回退/卸载/SSH恢复与离线卸载器完整事务。
- [ ] B1：受限容器 schema、固定 daemon、受管资源清单及结构化动作。
- [x] B2：一次性提权脚本审阅、账户解析、精确快照授权、专用运行单元及回执。首批账户白名单仅root。
- [ ] B3：真实 Linux root/sudo、普通脚本攻击面、Docker 和提权脚本垂直验收。
- [ ] C1：旧部署/operations/platform/reconcile/root本地恢复入口全量迁移；未迁移入口 fail closed。
- [ ] C2：网站/证书/受管 systemd 与备份适配器分别审计、独立能力启用。
- [ ] C3：有期限、固定代码/主机的定时提权持续授权，暂停/撤权/新增主机重新审阅。
- [ ] C4：分主机灰度、旧执行器停派、身份轮换、灾难恢复和发行验证。

开发遵循上述顺序；未通过验收的项目保持未完成。不得把设计检查勾选为功能实现，不以纯文档检查替代实机验收。

## 当前切片与未完成部分

- A4 已实现首次SSH安装、独立构建心跳验证、原计划防重、安装缺席只读核对、SSH批准卸载、卸载未知核对与离线卸载器；独立执行器升级/回退及部分安装修复未完成，因此A4不勾选。
- B1 已实现固定daemon、root清单、digest/架构与最小无网络/挂载/端口的结构化动作；完整服务配置、Compose/卷和业务容器部署不在该最小切片。
- B3 已在本机隔离Linux/systemd中验证真实root脚本及安装/撤权/卸载，测试与限制见linux-validation；root/sudo及全部Docker动作的实机矩阵未完成。
- C1 普通Agent已经固定拒绝旧operations/systemd/制品/Docker写操作，新执行器不接受ordinary control；适配器与中心停派的全量迁移尚未完成。中心旧claim/payload仍存在，旧Agent或自定义调用方仍可能领取写任务；新Agent本地拒绝，未领取任务需要取消或等待过期；不能将旧发布功能视为已迁移。
- C2—C4 保持目标阶段，未实现部分不作为已可用功能；本PR保持Draft，不发布到线上主机。

## 最新主干实施衔接

- [x] 合并 fe99013 并保留双方主机/Docker/执行器入口，修复双方任务与生命周期互斥。
- [x] 取消普通 unit 自动 Docker/cap 授予，helper 与普通 run 实际核验、旧权限拒绝迁移，不擅改外部权限。
- [x] 运行集成范围回归并更新实施 [PR #64](https://github.com/workhold/lightmoni/pull/64)、Doca924 与验收证据。
