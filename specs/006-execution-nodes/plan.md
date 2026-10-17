# Implementation Plan: 执行节点与任务标签

## Technical Context

沿用 Go 中心、SQLite、Go LightMoni Agent、React/AntD。中心拥有标签与任务权威，旧节点继续轮询 RemoteConfig。不新增智能执行权限。

## Constitution Check

规格先于产品代码；Go 鉴权与配置权威保持；不引入 AI 修改工具；保留数据及已有未提交模型管理工作；凭据不进入响应、截图或日志。全部通过。

## Design

1. 持久化独立任务、标签及节点关联，事务内编译验证，启停/编辑/绑定发生冲突时拒绝提交。
2. 以 ANY 标签匹配去重任务，按稳定顺序合成现有 RemoteConfig。无匹配显式关闭内部采集及清空拨测，业务 OTLP 转发不停止。
3. 一次幂等迁移旧 group 到同ID标签和独立任务，保留命令和轮询协议。迁移完成标记防止任务复活。
4. 节点助手三页签：执行节点、任务管理、任务标签。默认节点列表；旧 group 查询参数映射为标签过滤，接入保留初始标签兼容。
5. 共用命名覆盖导航、概览、接入、SDK及空态。安装程序和二进制技术名保持 LightMoni Agent/lightmoni-agent。已保存自监控大盘不强行覆盖。

## Files and Ownership

- 后端：internal/server/agent_config.go、server.go、新任务/标签编译模块与测试。
- 页面：web/src/app/AgentsPage.tsx、agent-model.ts、AgentTaskEditor.tsx、agents.css。
- 接入命名：AgentInstall.tsx、App.tsx、DataPage.tsx、SDKSetup.tsx、SDK examples及空态。
- 文档：README、docs/contracts.md、docs/ui-design.md、examples/agent/README.md及本规格目录。

## Verification

迁移、任务匹配/撤除/去重、冲突原子拒绝、权限、旧节点与注册兼容的 Go 集成及 race；前端类型检查与隔离浏览器，验收桌面/390px、接入深链、任务增改启停、节点多标签、标签引用删除失败。序列构建网页再嵌入Go，重启8080并复测。
