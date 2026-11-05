# 验收记录：SDD096

日期：2026-11-05。基线：GitHub origin/main，实施位于独立工作区和 codex/096-machine-reconciliation 分支。原工作区 compose.yaml 与发布证据未改动；未发布镜像、未修改生产机器。

## 功能结论

- 注册式核心独立于业务；加密单机期望、完整快照事务、稳定目标 ID、单调代次、迟到结果 CAS、依赖就绪和反向清理、退避和周期核验可复现。
- 首批 deployment.instance、file.certificate、agent.config 已在实际 app composition root 注册。实例清单包含集群、机器、域名、端口、声明文件路径和证书版本。
- Agent 同版本内存/磁盘漂移实际修复；目录证书执行真实临时文件安装、损坏/权限漂移检查、修复版本原子发布和旧入口清理。
- 部署 HTTP/作业回执集成覆盖人工实例漂移、离线期望、代次 fencing；执行器测试使用模拟 Docker inventory 加实际临时配置文件，核对环境变量/文件正文的 configuration_matches。没有把模拟 Docker 证据描述为生产验收。
- 托管状态实例保留最低可用性；旧 Agent 保留原健康检查和证书下发，深度核验显示升级阻塞。未知执行通过现有主机互斥与人工审计守卫，不自动重放；没有新增普通 Agent 写入权限。
- 管理员清单/触发接口覆盖权限、分页及秘密不进入公开视图。显式目录 remove 清理完成后才允许删除目标；关闭自动同步不隐式删除文件。

## 检查

| 检查 | 结果 |
| --- | --- |
| npm --prefix runtime run typecheck | 通过 |
| npm --prefix runtime run build | 通过 |
| npm --prefix web run typecheck | 通过 |
| npm --prefix ai-runtime run typecheck / build | 通过 |
| node --import tsx --test --test-concurrency=1 test/reconciliation.test.ts test/agent.test.ts test/nodes.test.ts test/platform-api.test.ts test/platform-executor.test.ts test/platform-clusters.test.ts | 112 项，111 通过，1 跳过，0 失败 |
| 环境补齐后 application-list-filter / assistant-alerts / assistant 三个套件复测 | 27 项全部通过 |
| git diff --check | 通过 |
| 提交前 git fetch origin main | 通过；与远端主干无分叉/落后 |

相关测试的 1 项跳过为已有真实容器证书 QA，需要 LIGHTMONI_CERTIFICATE_DOCKER_QA=1；本次未启用。现有 signed executor/unknown fencing 回归包含于扩展全量检查。

## 扩展全量检查的限制

npm --prefix runtime test 首轮：1503 项，1466 通过、33 跳过、4 失败。3 项失败因新工作区最初缺少 web 依赖链接和 ai-runtime/dist，补齐后上述三个套件 27 项全部通过。另一个 machine-terminal.test.ts 套件在真实 SSH/PTY 用例后超过 5 分钟未退出，结束该测试子进程后其余套件继续执行。该测试、SSH 终端实现和相关 SSH fixture 均与 origin/main 相同；挂起原因尚未定位，本次不声称全量测试全绿。最后功能验收使用上述独立相关套件，结果全部明确。

本地详细日志保留在 /tmp/lightmoni-reconciliation-verified-tests.log、/tmp/lightmoni-reconciliation-environment-recheck.log、/tmp/lightmoni-reconciliation-full-tests.log，未将可能包含 fixture 输出的完整日志提交仓库。

## 架构同步

架构影响：是，新增注册模块、单机期望存储、实际观测/核验和重试控制路径。仓库对应 docs/system-design.md 第 96 节；Doca 对应 [LightMoni 系统设计基线](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53) 新增原生章节及图。

保存并回读至 seq 1744。原 911 个块（包含既有原生图）的内容及顺序在 seq 1743 全量比较一致；新章节文字、7 个节点和 8 条连线核对一致，seq 1744 仅补充渐进升级说明并重新回读目标段落及图。文档标题保持原样。结构化证据：doca-sync.json。没有令牌、私钥或真实凭据进入文档或证据。

## Pull Request

[GitHub PR #102](https://github.com/workhold/lightmoni/pull/102)，目标 main。代码与文档均在该 PR；未合并、未发布生产。
