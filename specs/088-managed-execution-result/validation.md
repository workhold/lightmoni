# 验收记录

- 真实组件与本机隔离fixture：安装记录和操作日志回执均显示同一主机运维结果组件。
- CUA实际提交一次隔离人工核对：空原因时禁用、未勾选确认时禁用；填写原因且确认后才可提交。回读仍为unknown，带resolved_at/核对人/原因；没有重试、改成功或读取敏感输出。
- 错误主机与错误能力均只显示身份不匹配警告，没有核对按钮。普通旧作业404不显示特权控件。非管理员被既有路由送回个人设置，且fixture记录中没有特权API请求。
- Web TypeScript、fixture语法、git diff --check通过，现有筛选/网站状态定向回归4/4通过。原有脚本/容器能力文案和确认逻辑保持不变；本次只增加已存在的operations.managed.v1呈现分支。
- 稳定画面：忽略目录`.local-dev/panel-ui-088/reconciled-unknown.png`和`receipt-managed-result.png`。另以390×740实际iframe子视口看图核对表单、确认框和按钮换行；浏览器未应用原生窗口尺寸覆盖，不声称原生缩放。证据`evidence/ui-checks.json`；镜像和线上验收在PR发布验证节回填。

线上只读现场：job `6e1d41c9bd13acd3cd1ba2f6ceab1997`，动作inspect，中心与目标journal均为unknown/code executor_http_502。目标没有其他prepared/intent/running记录，关联unit not-found/inactive/dead，无managed operation lock。Agent active，Demo容器healthy，四个业务容器均运行。现场核对没有修改数据库、任务状态、进程或容器。

架构同步不适用，理由见spec.md；仓库系统设计和Doca无需改写，不声称在线同步。

## 发布

固定镜像`docker.heyphp.com/lightmoni/lightmoni:20261103-f9d7480`，源码`f9d7480d3c72553f7a3d67a63fdb88c8e0f82545`，后续提交仅验收文档和Compose发布引用。linux/arm64与linux/amd64各42项成品检查通过，另外各自通过编译成品私网HTTP/TCP健康探测；AMD64为Docker仿真。37个本地OCI blob逐个校验SHA256，rootfs/config与实测镜像一致，索引`sha256:0da1a10ea55f1853aa176c5e71cadb3a6bbf63a9e679b89671191ac51efb7631`。详见evidence/image-checks.json。

远端发布、线上保护性备份、中心升级、正常产品人工核对及随后新检查的结果以[PR #84](https://github.com/workhold/lightmoni/pull/84)发布验证节为准；本地成品通过不代表线上已恢复。保留原未知记录及原因，不通过SQL修改作业或将未知状态改成成功。

## 最终线上核对

已通过正常产品界面核对原受管inspect未知结果：保留unknown与executor_http_502，2026-11-03T03:28:19.382Z记录管理员、原因和确认，不重放旧作业。后续发现并经SDD089修复Agent包装层互斥，最终上线20261103-1bfd49c后新检查与DNS/HTTPS恢复。完整升级和最终回读证据见../090-ui-delivery-isolation/evidence。
