# SDD060 验证记录

日期：2026-11-01（Asia/Shanghai）。PR：[#47](https://github.com/workhold/lightmoni/pull/47)，保持 Draft，未合入或发布。

## 本轮实现与验收范围

同一发行包增加独立 root 执行器入口；普通 Agent 和普通任务继续以 `lightmoni-agent` 运行，获批提权脚本明确以 root 账户（UID/GID 0）运行。已实现独立身份/策略/防重、签名计划和短期在线许可、持久 journal 与 unknown fence、加密输出、root 一次性脚本、最小结构化 Docker 操作、SSH 首次引导、独立卸载和缺席核对。

普通 Agent 的旧 operations/systemd/制品/Docker 写操作已停止领取；即使中心返回旧写任务，本地仍拒绝执行、下载私有 payload 或制品。只读健康检查和 Docker 清单继续使用普通通道。中心旧 claim/payload 尚未停派，旧 Agent 或自定义调用方仍可能领取旧写任务；新客户端拒绝不等于中心只读保证。旧中心适配器尚未迁移，未领取任务需要取消或等待过期；不能把本 PR 当作既有运维功能的完整迁移版本。

## 自动化与独立复核

- 执行器核心 runner/scripts/Docker/journal/协议/安全测试 76/76 通过。
- SSH bootstrap 集成与实际固定 shell 探测 85/85 通过；维护 API 48/48、独立安装/卸载 shell 28/28 通过。
- 主机执行权限/维护浏览器 UI 16/16、提权任务浏览器 UI 24/24 通过，截图已核对。
- runtime 类型检查与构建、web 类型检查与生产构建通过。
- 独立复核许可启动时限、日志写入顺序、unknown/fence、防重、输出加密及主体门控，未发现新的阻断问题。
- 完整 runtime 回归在同步最新 main 后记录最终结果；中间一次旧证书写通道测试仍期待普通 Agent 执行，已按新的拒绝行为更新，不据此恢复旧权限路径。

## 真实 Linux 验收

本机隔离 Colima Linux arm64/systemd 252、Node 24.15.0 中，通过同包安装与独立注册、中心签名计划及在线许可、真实 UID 0/root 脚本、普通主体隔离、敏感正文隔离、签名策略关闭、离线卸载和精确中心撤权。测试 CA 显式受信，未关闭 TLS 校验。

真实签名超时负例将 `sleep 20` 限为 1 秒，以 `failed/timeout` 结束且不留下 unknown fence；system bus 停止时 readiness 拒绝就绪。Docker 验证脱敏 list、外部资源拒绝、固定 digest/架构的受管 create/remove，没有启动测试容器或修改已有容器。

发现并修复 systemctl 私有 socket 不能替代 system bus 就绪判断、RemainAfterExit 保留管道 FD、运行超时与租约丢失混淆三处实际接缝。停止或观察不确定时仍为 unknown。

复现步骤、fixture 摘要局限与无秘密报告见 [linux-validation.md](linux-validation.md) 和 [linux-validation-report.json](linux-validation-report.json)。所有本轮 QA 容器已停止并保留状态；没有 SSH 访问用户主机、改变生产权限、发布镜像或部署。

## 明确未完成

独立执行器自动升级/回退、部分安装残留修复、旧运维/网站/证书/systemd/备份适配器迁移、定时提权授权、完整业务容器部署及发行灰度尚未完成。真实 amd64、完整 root/sudo 矩阵和 Docker pull/start/stop/restart/仓库鉴权尚未验收。任意获批 root 脚本具有整机权限；不宣称它是沙箱，也不保证恶意 root 脚本执行后的主机可信。

## Doca 架构同步

[LightMoni 系统设计基线](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53) 已同步仓库系统设计第6、13.10、17、33.8、57与60章。

- 初始目标设计：902→903，回读37个新增块及两张原生图（9节点/9连线、10节点/10连线）；626个原有块和31张图保持不变。
- 代码复用设计：903→904，回读4个新增段落与2个来源链接，其余662个块及33张原生图保持不变。
- 实现边界：904→905，回读60.10的6个新增块和引言，666个无关块及33张图保持不变。
- 实现交叉引用与历史通道说明：905→906，回读4处引用和57章的拒绝写入说明，669个无关块及33张图保持不变。
- 普通 control 边界说明：906→907，回读2处段落，明确新 Agent 的本地拒绝和旧中心接口尚未停派，672个无关块及33张图保持不变。

证据见 [doca-sync.json](doca-sync.json)。结构回读不等于浏览器视觉验收。凭据代理会话已关闭，token 未写入仓库。

## 设计阶段历史

最初设计基线为 `f2fd1d54d8ba384c5007bcb4b3f8e8e2a80fd53b`，当时只交付 SDD/HLD/LLD。研究核对 Cockpit、1Panel 与 Docker Socket Proxy 的官方源码/文档；四张 Mermaid 通过解析，文档链接与锚点检查通过。此历史设计检查不替代上述实现及 Linux 验收，也不代表未完成阶段已可用。
