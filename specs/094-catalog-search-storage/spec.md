# SDD094：搜索、抓取与云存储应用

日期：2026-11-04；分支：codex/094-catalog-search-storage。

## 用户需求与验收

应用商城新增 Meilisearch、SearXNG、Firecrawl、RustFS，可查找、查看官方 Logo、填写参数并沿用既有安装流程。用户补充允许新增分类，RustFS 必须归云存储。

- 35 个唯一模板、8 个分类；搜索服务含 Meilisearch / SearXNG，工具含 DBX / Firecrawl，云存储含 RustFS；旧应用 ID 不变。
- 固定上游可获取的镜像版本或多架构摘要；每个模板提供中英文描述、参数、安装要求与官方部署文档。
- Meilisearch 必填至少 16 个字符主密钥、生产模式、7700 HTTP 与独立数据卷。
- SearXNG 生成独立服务密钥，启用 HTML / JSON 检索；无内建访问认证，默认仅本机监听。
- Firecrawl 包含 API/worker harness、Playwright、Redis、RabbitMQ、NuQ PostgreSQL；仅 API 发布，默认仅本机监听。自托管无账号鉴权，须明确网关认证要求；不冒充云服务功能。
- RustFS 单节点单盘模式，必填访问密钥与秘密，S3 9000 / 控制台 9001 分别配置宿主端口，数据与日志独立持久化；不承诺冗余或自动迁移。
- 秘密只经既有加密修订与运行环境传递，不插入命令或公开配置；无主机特权、Docker socket、全局卷。

## 架构影响

适用：新增第三方工作负载的部署拓扑、存储与凭据边界。在同一 SDD/PR 同步 docs/system-design.md 与 Doca 系统设计基线，保留已有原生图和无关内容，写后回读目标章节并记录结果。平台组件/API/表结构不变。新增应用不会自动连接 LightMoni 凭据、AI 或其他应用。

## 范围

本轮开发、隔离验证与功能 PR；不合并主干、不发布生产镜像、不安装用户生产机器。记录真实容器与受控 HTTP/浏览器验证各自范围。
