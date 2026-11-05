# Implementation Plan

基于 PR94 的采集修复继续工作，隔离工作树保留原工作区。复用 Node/TypeScript 控制面、SQLite 加密修订、签名部署任务与 Web SSH 终端。

## Design
- 新建 application-upgrades 模块：只读返回 revision/source/current_images/target_images/available/blocked_reason；确认接口核验 revision、目标商店版本及镜像映射指纹，自定义请求严格限制已存在服务镜像键。保留全部配置，清除生成 YAML 后转回结构化配置，升级设置 image_pull_policy=always，绑定 refresh_images 与强制重建任务，要求执行器声明 operations.platform.image-refresh.v1；store.update 保存新修订后调用已有 deploy；重复旧 revision 拒绝，保存后的部署错误如实返回并保留目标供重试。
- 商店采用模板最新 spec 的镜像映射；服务集合必须一致。不猜测镜像标签和模板版本的对应；目录当前 version 为唯一升级目标，历史安装允许旧版本。
- 新增容器目标解析器：SQLite 当前实例归属、Agent Docker 快照逐项匹配；服务端目标包含固定完整 ID，拒绝 retired/stopped/离线快照。终端创建可携带 application_id/instance_id/container_id/shell；不接受任意命令。
- SSH 在已授权连接中用 exec+PTY 执行固定命令，docker inspect 再核验 owner/instance/running，使用用户 Docker 权限或 sudo -n，最后 exec docker exec -it <full-id> /bin/sh|/bin/bash。失败退出，无主机 shell。WebSocket 附着及周期检查重新核验中心实例归属。
- 审计扩展单独目标表关联现有 session ID；不改变既有 machine terminal API 默认行为。
- Web 复用现有 Ant Design、安装记录和 xterm；升级对话框及按机器/容器选择器，错误和重试明确。

## Architecture impact
适用：新增应用升级控制路径及 SSH 到容器的目标校验与审计边界。同步 docs/system-design.md“应用升级与容器终端”章节和 Doca 原生章节；原图保留，新流程图独立追加并最新回读节点/连线。

## Validation
目录升级与配置保留/冲突/鉴权 HTTP 回归；目标隔离/失效/注入测试；真实 SSH PTY 容器 exec 协议测试；runtime/web 类型检查、构建、相关部署/终端回归与浏览器流程。PR94 生产恢复单独记录，不用本地夹具代替线上验收。
