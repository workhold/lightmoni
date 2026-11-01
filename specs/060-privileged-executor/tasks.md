# 任务

## 本轮设计交付

- [x] 核对当前 root/sudo、Agent 运行账户、任务与运维接缝。
- [x] 调研 Cockpit、1Panel 与 Docker socket proxy 并给出取舍。
- [x] 完成需求、HLD/LLD、目标契约、分期与验收清单。
- [x] 完成独立设计评审和文档检查。
- [x] 同步仓库系统设计与 Doca 原生图，最新版本回读并保留证据。
- [x] 创建 GitHub 设计 PR，明确未实现状态（[#47](https://github.com/workhold/lightmoni/pull/47)）。

## 本 PR 的实施范围

- [x] A1：主机root/sudo真实预检、登记提示、授权与实际状态分开。
- [x] A2：同包双固定入口、独立Ed25519身份、签名/防重、root目录与UID核验。
- [x] A3：统一task lineage及所有普通接口主体门控，独立授权事务与持久互斥。
- [x] A4代码：唯一维护入口的首次安装、upgrade/rollback/repair/uninstall、阶段记录、activation确认和显式只读恢复。
- [x] B1首版：固定daemon、root清单、最小七动作与结构化UI；拒绝卷/端口/网络/额外权限/任意command/Compose。
- [x] B2：一次性root脚本精确审阅、独立运行单元、取消/人工核对、加密敏感输出与共享结果UI。
- [x] C1中心：删除旧写任务与私有正文/制品执行通道；历史queued取消、在途unknown，业务profile未迁移则创建前拒绝。
- [x] B3收口：对最终代码完成真实Linux生命周期和最新回归，记录证据。
- [x] 普通Agent旧平台权限清理：精确旧drop-in移除，禁止失败恢复/显式回退重启旧高权限主unit。

## 后续独立功能

- [ ] C2：网站/证书/完整Compose/受管systemd与备份profile逐个审计，接入逐步骤许可；不直接把旧executeOperation用root执行。
- [ ] C3：固定代码/主机/账户、有期限的定时root持续授权与撤销。
- [ ] C4：分主机灰度、身份轮换、灾难恢复与完整多架构发行矩阵。

以上后续功能未实现，旧执行协议不因保留适配器库而继续可用。SDK直报不受此变更影响；没有操作线上主机或发布镜像。

## #64 完成收口

执行契约见 [completion.md](completion.md)。

- [x] 关闭中心旧写任务领取/载荷/回执通道，安全终止旧排队任务并保留在途 unknown。
- [x] 删除 Docker 补装的普通 Agent 提权、重启与相关 UI 误导。
- [x] 完成唯一维护入口的 upgrade/rollback/repair 审批与未知结果核对。
- [x] 补齐维护与最小受管容器 UI、测试、真实 Linux 验证和架构同步，更新 #64。
