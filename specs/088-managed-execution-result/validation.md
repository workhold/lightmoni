# 验收记录

- 真实组件与本机隔离fixture：安装记录和操作日志回执均显示同一主机运维结果组件。
- CUA实际提交一次隔离人工核对：空原因时禁用、未勾选确认时禁用；填写原因且确认后才可提交。回读仍为unknown，带resolved_at/核对人/原因；没有重试、改成功或读取敏感输出。
- 错误主机与错误能力均只显示身份不匹配警告，没有核对按钮。普通旧作业404不显示特权控件。非管理员被既有路由送回个人设置，且fixture记录中没有特权API请求。
- Web TypeScript、fixture语法、git diff --check以及现有筛选/网站状态定向回归检查。原有脚本/容器能力文案和确认逻辑保持不变；本次只增加已存在的operations.managed.v1呈现分支。
- 稳定画面：忽略目录`.local-dev/panel-ui-088/reconciled-unknown.png`和`receipt-managed-result.png`。后续窄屏、镜像和线上验收在PR发布验证节回填。

线上只读现场：job `6e1d41c9bd13acd3cd1ba2f6ceab1997`，动作inspect，中心与目标journal均为unknown/code executor_http_502。目标没有其他prepared/intent/running记录，关联unit not-found/inactive/dead，无managed operation lock。Agent active，Demo容器healthy，四个业务容器均运行。现场核对没有修改数据库、任务状态、进程或容器。

架构同步不适用，理由见spec.md；仓库系统设计和Doca无需改写，不声称在线同步。
