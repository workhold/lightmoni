# 验收与发行记录

2026-11-03，功能分支 `codex/091-deployment-autoconfiguration`。用户追加授权自行打包、部署、发版并测试；发行结果将在本记录继续补全。

## 功能与兼容

- 受管发布可在已验证的受管任务后顺序入队，实际领取仍串行；普通提权、未完整核对 unknown、生命周期操作仍互斥。没有清空历史执行结果。
- OpenResty 入口在托管区域下稳定生成，后添加区域会补齐；网站仅 CNAME，旧 IP 模式打开编辑器后下次保存转为 CNAME。默认单 CNAME 不再无故申请 DNS 权重能力，供应商回读附加 fqdn。
- 快速安装自动匹配最长托管区域、在线且容量足够的位置和端口；复用有效证书或已有 ACME 账号。应用、入口、网站、证书原子登记，阶段持续调和；相同 request_id 或重试复用资源。过期上传证书、缺少账号、未托管域名等在创建前拒绝，入口 DNS 权限错误可以追踪。
- 系统 Registry 全局仅一个集群/固定机器、一个可写服务、一份存储、容器 5000。拒绝增加系统副本或直接换存储位置，旧多位置配置须先迁移。删除独立 Hub/来源缓存服务，不主动删除旧磁盘目录。额外普通仓库仍可从商店自行安装。保留原 registry 数据挂载。
- 普通应用逐实例注入中心、专用 SDK Key、服务及资产身份；容器和 Compose 自定义环境覆盖默认。Key 加密保存，禁用不自动绕过，删除应用停用 Key；公开响应和日志脱敏。八种后端 SDK 使用同一环境契约，显式配置优先，浏览器配置保持显式。

## 本地验证

- 根 `npm run typecheck` 通过（runtime/AI/web）；TypeScript SDK build 与23项测试通过，Python34项通过，Go全量通过且新增环境回归通过。
- 13份相关 Runtime 回归161项：160通过、0失败、1跳过（真实容器证书同步环境条件）。之后新增过期证书和入口供应商错误断言的 `platform-clusters` 41/41 再通过；Registry认证编译3/3通过。跳过不计通过。
- Java/.NET/PHP/Ruby原生协议验收通过。`scripts/verify-sdk-environment.py` 以实际 HTTP 收到 Node/Python/Ruby/Java/.NET/PHP/Rust 的认证与服务/实例/机器/应用元数据，显式 host 覆盖、无秘密属性均通过；Go以原生 Protobuf 回归验证。Rust crates.io不可达，使用已锁定缓存依赖重新 rustc 编译当前源码后实测，不声称一次新的联网 Cargo 构建通过。
- `scripts/verify-system-registry.py` 从真实模板创建临时 Registry，OCI blob/manifest推送、拉取及重建容器后一份存储的数据保留通过，临时容器与目录已清理。见 [registry-real.json](evidence/registry-real.json)。
- Catalog UI脚本连续3次通过：中英文/明暗主题、1440/390、31应用/6分类、域名主表单、自动位置和高级端口；真实HTTP安装仅记录夹具待执行状态，未伪造生产成功。入口/仓库脚本3轮通过，确认单5000、默认宿主0、自动域名及只选择托管区域。见 [ui.json](evidence/ui.json)、[deployment-ui.json](evidence/deployment-ui.json)。

## 界面与实际画面

沿用现有 React/Ant Design、颜色与排版，主路径收敛为域名及必需业务参数；位置、资源、端口保留高级覆盖。删除手填集群入口、网站IP选项、系统仓库多端口与添加集群副本入口，缩短重复DNS/SSL说明与DBX末尾孤行。独立视觉评审未发现重叠或溢出，提出的重复文案与窄屏换行已修改；窄屏仓库端口名进一步缩为“宿主端口”。

保留抽屉进退、Modal缩放/遮罩、高级折叠三处既有动效，录屏位于忽略目录 `artifacts/screenshots/specs/091-deployment-autoconfiguration/evidence/*.webm`。实际检查桌面、390px窄屏、页尾按钮与200%像素密度局部截图（非原生浏览器缩放），截图同目录：`dbx-zh-CN-390-light.png`、`registry-single-3.png`、`entry-generated-3.png`、`entry-editor-200.png`。旧 SDD 的多仓库 UI 脚本不再代表本次契约，本次以新的 deployment-defaults 脚本为准。

## 架构同步

适用：入口DNS路径、安装编排、仓库存储拓扑、SDK凭据边界。仓库 `docs/system-design.md` 第91章及第62章更新；[Doca系统设计基线](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53) 已保存并最新 seq1714 回读，六段文字与仓库一致，原标题和原生总览10节点/8连线保留，端点有效。见 [doca-readback.json](evidence/doca-readback.json)。

本地 DNS/签名回执夹具不能代替实际公网传播、真实CA签发或生产主机验收；生产测试结果将另列。

## 主干与发行前复核

功能由 [PR #88](https://github.com/workhold/lightmoni/pull/88) 合入 main `9c48c182752e7e3290e7e60ee5256c2e5beb37bd`。发行成品复核前补充：无可用机器时先验证安装参数，保留必填参数及非法端口错误；自动选位置的有状态应用保持固定手动模式，高级托管模式要求自选位置以审阅本地数据限制。相关集群/目录48/48及根类型检查通过。
