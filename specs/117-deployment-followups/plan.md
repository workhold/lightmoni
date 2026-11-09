# Implementation Plan: 部署问题清单闭环

**Branch**: codex/117-deployment-followups | **Date**: 2026-11-09 | **Spec**: [spec.md](spec.md)

## Summary
以 GitHub main 3d67b5d 为基线。先复核 SDD068/092/097/100/107/109/114/116 已有能力，再补实际缺口。MCP已读全部问题表，6条已解决、11条待解决。

## Technical Context
Node >=22.19、TypeScript、React/Ant Design、SQLite/ClickHouse、SSH2/SFTP、现有Docker受管执行器；后端SDK采用原生语言测试；Monaco本地worker，不增加CDN。Node test、现有浏览器夹具及可丢弃Docker/OpenSSH/S3验收。

## Constitution Check
规格先行；执行权限归中心/真人管理员与已有持久授权；敏感配置走受保护通路；保留精确版本、未知结果和归属围栏。不自动改生产。架构新增路径同步仓库与Doca。设计前后均符合。

## Design
1. 主机补既有cpu_count/memory_total_mb心跳及逻辑CPU指标，规范投影，监控复用已有遥测组件。SDK host.name依次显式资源、环境、OS回退，不授予权限。指标由中心统一metric_命名并保留旧视图。
2. 系统内置大盘从默认用户列表分离，系统/主机页仍可访问；保留用户自定义及删除意图。已有Grafana和大日志先实际复测。
3. 文件沿用人工SSH账户，补排他创建、mkdir、版本核对rename、非递归删除、chmod<=0777；拒绝根/链接/特殊文件，写后回读，可能已写断线为unknown。本地通用代码编辑器供YAML与文件使用。
4. 容器复用host_docker任务，增加有界多目标删除/停止容器清理。全批与逐项核对版本/daemon、逐项回读、默认保留卷。缓存Compose能力探测，列表保留最近缓存。
5. 商店明确官方/源码链接、只读脱敏配置预览；Registry保留原生tags/list，清单4并发及in-flight去重，保留摘要/深度/引用保护。
6. 外部Compose沿既有compose操作资源：inspect→审阅→adopt批准→重建/回读。保留项目/卷名与支持限制，不能用platform apply冒充接管。
7. 计划批准保留真人authorizer，用fires关联schedule_id/revision/resource revision/run_id；派发/领取/开始重验计划权限，不仅剥离schedule:前缀。应用备份与迁移使用完整清单、流式制品、属主/权限/摘要，工具下载仅管理员no-store。
8. 完整应用与迁移采用管理员离线Python/Docker工具，界面提供下载/摘要/命令指引。S3使用受保护运行时凭据、条件PUT和完整GET校验；systemd仅生成供root审阅安装，作为独立本机持续授权，和平台计划来源校验分别验收。

## Project Structure
runtime/src/server、agent、domains、operations、ops、shared、privileged-executor；web/src/app、app/ops、shared；sdk；scripts；本目录规格与证据。

## Implementation strategy
独立故事可并行；同文件顺序合并。遥测、文件、容器分别验收；主代理负责调度/备份/迁移及集成。GitHub PR交付，无合并/发行授权。
