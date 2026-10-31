# 验收记录

2026-10-31。采用本地隔离环境，无生产 CA/DNS 请求或生产目录写入。

- `npm run typecheck`：Runtime、AI Runtime、Web 全部通过。
- `npm test`：Runtime 791 项，769 通过、22 条环境条件跳过；AI Runtime 71/71，TypeScript SDK 22/22。没有失败。
- 最后收紧 retry 仅覆盖失败成员后，重新运行 `node --import tsx --test test/platform-api.test.ts test/platform-cloud-certificates.test.ts test/platform-store.test.ts`：61 项，60 通过、1 条真实 Docker Agent 用例在默认环境下跳过。该用例另外显式启用并通过。
- `LIGHTMONI_CERTIFICATE_DOCKER_QA=1 node --import tsx --test --test-name-pattern='two real container Agents' test/platform-api.test.ts`：1/1。两个独立真实 AgentJobRunner 容器领取当前中心的真实 job/lease/私有载荷，在各自文件系统的同一路径安装证书，检查 X.509 指纹、密钥配对及私钥 0600，全部回执后中心才 applied。容器采用上一已发布 Agent，验证协议兼容；容器由测试清理。
- API/控制器覆盖规范化名称、无 name、多域名新建拒绝、历史多域名保持、逐机部分失败、仅失败重试、新成员普通/自动同步、unknown 先检查、取消任务、超过概览 100 条历史仍去重、成员离开/换绑/Agent 移除/证书版本更新/管理员撤权后旧载荷拒绝，以及旧回执与重启恢复。
- 浏览器真实入口连续三轮各 18 项通过、0 错误；报告见 `evidence/ui-{1,2,3}/ui-report.json`。使用真实 Router/SQLite、合成 CA/DNS peer；UI 回执场景使用测试 peer，真实目录落盘由上述独立 Docker 用例证明。覆盖失败保留输入、快捷证书创建保留网站表单、集群转单机清理作用域、刷新回读、逐机器结果、查看下载回归、中英文/深浅色/窄屏/200% 视图。
- 主 Agent 已目视检查第三轮集群表单、域名下逐机器同步结果和英文深色窄屏截图：证书无名称输入；任务紧邻所属域名，集群范围及机器结果可辨；列表内长 CA 错误限制三行，完整原因仍由 tooltip/执行日志提供。窄屏采用现有横向表格滚动。
- `git diff --check` 通过；提交前 fetch `origin/main`，无落后提交。

## 架构同步

适用，更新 `docs/system-design.md` §33.5、§33.6 及现有控制面图；Doca [LightMoni 系统设计基线](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53) 同步保存，并按最新 seq 895 / version 896 回读。两段文本与原生图精确匹配；保留全部 11 个节点、14 条连线、端点、几何及样式，仅更新两个节点和一条连线的标签。证据见 `evidence/architecture-sync.json`。

## 兼容与边界

已有证书 ID、材料、历史、网站引用均保留；历史多域名只能保留原集合编辑，未自动拆分。新建证书只允许一个域名/泛域名，名称由中心派生；依赖任意证书名称或新建多 SAN 的调用方需调整。单机、云、脚本同步接口不变，集群目录返回逐机器 runs。集群成员最多 100 台；空集群/任何成员缺少有效 Agent 整批预检失败，离线有效 Agent 可以排队。自动同步不重放失败/unknown；unknown 需现场检查。已经返回给 Agent 的材料无法远程撤回。

本轮复用现有表、加密载荷与节点任务协议，无新增服务；多个逐机器 queue 各自原子，进程中断依靠下一轮幂等补齐，并非跨机器事务。
