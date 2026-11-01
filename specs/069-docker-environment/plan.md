# 实现设计

1. 复用 Agent Docker inventory 和即时采集作业，向主机摘要添加 Docker 环境投影；只读状态按最新采集时间计算，过期不判定缺失。
2. 中心新增 machine_docker_installations 持久记录和管理员路由。复用 SSH 主机公钥验证、可复用凭据、busy 与生命周期排斥。request_id 幂等绑定目标和凭据。后台固定命令交给独立 systemd transient unit，中心后台读取有界结构化结果；重启标记 unknown，允许显式只读核对远端结果。
3. 平台拥有固定脚本：校验系统/架构/systemd/权限；Ubuntu/Debian 官方签名 apt 仓库安装缺失 Engine/Compose，拒绝冲突包，不执行远程下载脚本。对绑定身份匹配且使用平台标准 unit 的 Agent 添加固定 docker 补充组 drop-in 并按需重启；不更改系统用户组或 socket 权限，不自动重部署应用。
4. 安装期间以数据库闸门阻止 Agent jobs 和 host tasks 领取，阻止 SSH 生命周期并发。远端固定安装 unit 与状态目录由 root 管理，不写 Agent 可写目录。
5. 公共 DockerEnvironmentPanel 用于主机列表、HostInventory 和 ApplicationInstallDrawer；显示凭据选择、影响、后台状态、只读核对和即时采集。旧 Docker 检查失败记录允许检查，不根据通用 dependency 错误猜测缺失。
6. 修正应用总体失败摘要及 Docker ENOENT 分类，补齐前后端白名单。

## 架构影响
适用：新增受控 SSH Docker 安装路径与持久化记录，Agent 经管理员确认获得受管 Docker socket 补充组权限，无新增 AI 能力。同步 docs/system-design.md 第 69 节与 Doca 基线新增对应原生章节；保留所有原生图块并回读目标段落/图块。

## 验证
有意义的 HTTP/SQLite/SSH fixture 验证权限、幂等、错误脱敏、并发、重启核对；固定脚本语法检查；Docker 控制与应用安装回归、类型检查、浏览器验证桌面/窄屏/英文。真实远端 apt 安装需隔离 Linux 主机，未执行时如实记录。
