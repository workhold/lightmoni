# 验收记录

## 故障定位

2026-11-02，通过既有管理员会话和平台 SSH 终端只读核对实际主机：CentOS Linux 8.5.2111、Docker Engine 26.1.3、Compose plugin 2.27.0，Docker service active/running；远端原安装记录为 failed / checking_system / docker_install_unsupported。主机已有依赖，失败来自发行版检查早于组件检查。没有在用户主机安装、升级或重启 Docker，没有启用独立执行器或扩大普通 Agent 权限。

## 代码与自动验收

- 新增生产 shell 隔离执行回归：修复前 5 项中 2 项失败，均复现过早的发行版拒绝；修复后 5 项全部通过。
- 与 Docker 环境、人工管理员确认、主机任务互斥、中心重启及只读核对一起执行：26 项通过，0 失败/跳过。
- runtime 与 web 类型检查、构建通过。Web 构建保留依赖的既有 use-client 指令提示，无构建错误。
- 新回归执行真实固定 shell；系统目录映射到临时目录，包管理命令使用受控桩并拒绝实际安装。它不等于真实发行版软件包安装验收。

## 浏览器验收

使用仅监听 127.0.0.1 的合成主机面板核对中英文：缺少执行器时解释待检测、执行权限链接绑定当前主机、重新采集禁用；明确确认只提交一次合成依赖验证，成功后仍显示执行器待检测且不允许重复安装；已有执行器就绪时允许采集、禁用安装；不支持补装时保留明确错误。见 evidence/ui-report.json。截图仅保留在忽略的本地诊断目录。

## 架构与兼容

架构同步不适用，理由见 plan.md。没有新增接口、存储、权限或架构路径；不恢复旧 Agent Docker 授权或历史安装迁移。改动只调整已有组件验证的准入顺序和界面说明。

## 交付

修复已通过 [GitHub PR #75](https://github.com/workhold/lightmoni/pull/75) 合入 main，源码提交 `e3b5f75f68be37a7f15eea496218098ff3cf98b4`。双平台镜像已发布：`docker.heyphp.com/lightmoni/lightmoni:20261102-e3b5f75` 与 `latest`，索引摘要 `sha256:9d907f840b17058ad752e73eabcef7a3d36a431d792fbb62cee6cc95c46b81f2`。根 Compose 固定到新标签，配置解析通过。

- linux/arm64 与 linux/amd64 各 41 项真实镜像检查通过，0 错误。两平台镜像内均用生产编译安装器执行 5 项隔离 shell 回归；另检查生产前端确实包含新的依赖与执行器说明。
- 两平台生产前端共 66 个资源 SHA256 相同：`2d6b5185da3f97f8277d5b6dd948edcbc27e33156e30c7f141ced4f691c7e7a6`。
- 发布前逐 blob 校验与已验收镜像 rootfs/config 比对；发布后远端索引、manifest/config 回读及实际双平台 Docker pull 比对通过。32 个历史固定标签保持不变。
- 本次临时 ClickHouse、中心容器、卷、网络与运行时凭据已清理；原有 15 个运行容器保持原样。回环 UI 服务与临时页面已关闭。
- 本任务仅发布镜像，未替换线上中心容器、重装 Agent 或启用独立执行器。中心使用新镜像后，新的验证流程与说明才生效。

见 evidence/verified-release.json、历史标签、清理、资源校验和 Compose 证据。
