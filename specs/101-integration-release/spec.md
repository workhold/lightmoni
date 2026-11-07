# 统一合入、Docker 发布与部署验收

日期：2026-11-07。用户授权将本次所有提交通过 GitHub PR 合入 main、发布 Docker、通过 panel.heyphp.com/terminal 部署，并在 moni.heyphp.com 验证。

范围：PR129（应用与网站资源 ID 存储、注销与逐机清理）及 PR130（私有镜像版本浏览与清理）。保留两项功能、能力声明、派发校验和架构章节，发布可追溯 main 提交的 linux/amd64 与 linux/arm64 固定镜像。

验收：相关类型检查与集成回归通过；镜像源码标签、平台及内置 Agent 能力可核验；部署保留现有 Compose 项目、环境及卷；中心健康、登录、仪表盘与新功能入口通过真实浏览器验证。对依赖新版 Agent 的功能如实记录升级和宿主回执；不以旧 Agent 无能力的页面当作功能成功。

架构影响：整合与发行本身不适用，不增加 PR129/130 以外的组件、协议、目录或权限。两项原功能的架构变更及 Doca 保存后回读，分别记录在 specs/099-app-registration-storage 与 specs/100-registry-image-versions；保留 docs/system-design.md 第99、100节和原生图证据。无额外架构编辑。
