# Feature Specification: 主机 Docker 环境与补装

**Feature Branch**: `codex/069-docker-environment`
**Created**: 2026-11-01
**Status**: Accepted
**Input**: 机器列表展示 Docker 环境是否缺少，一键部署；应用安装因缺少 Docker 失败时提供补装。

## User Scenarios & Testing

### User Story 1 - 查看环境并安装 (P1)
管理员在主机列表查看 Docker 环境和观测时间，缺少时直接打开安装面板。

**Independent Test**: 同屏存在可用、未安装、服务异常、权限不足、未知和过期观测主机，显示各自真实状态。

**Acceptance Scenarios**:
1. Given 最近观测缺少 Docker，When 查看列表，Then 显示“未安装”和安装入口。
2. Given 没有观测或 Agent 离线，When 查看列表，Then 显示待检测或过期，不误报未安装。
3. Given 有效 SSH 凭据与受支持系统，When 明确确认安装，Then 后台安装 Engine、Compose 并显示真实结果，关闭面板不取消任务。

### User Story 2 - 应用失败后补装 (P1)
安装抽屉展示 Docker 缺失原因，为所选执行对应主机提供补装；旧记录仅有 Docker 前提错误时允许检查环境。

**Independent Test**: OpenResty 在检查 Docker 阶段失败后，可从同一窗口检查/补装；补装成功后显式重新部署已有应用，不重复创建应用。

**Acceptance Scenarios**:
1. Given Docker 缺失导致失败，When 打开该机器执行，Then 展示可读诊断与对应主机的补装入口。
2. Given 仅有权限错误，When 查看失败，Then 显示修复权限建议，不声称 Docker 未安装。
3. Given 多机器或历史执行，When 切换记录，Then 安装目标始终为当前执行的 Agent 对应主机。

### Edge Cases
凭据失效、一次性凭据、多凭据无默认、不支持系统、无免密 sudo、软件包冲突、网络失败、重复点击、断网、平台重启、SSH 结果未知、已有 Agent 操作、历史观测过期。安装不得删除已有 Docker 数据或卸载冲突软件包。

## Requirements

### Functional Requirements
- FR-001 显示可用、未安装、服务不可用、权限不足、待检测、过期状态与时间；Compose 缺失独立诊断。
- FR-002 管理员可从主机列表和应用安装失败详情打开统一面板，选择有效可复用凭据，确认后安装。
- FR-003 安装固定流程限 Linux Ubuntu/Debian amd64/arm64 与 systemd；不支持环境明确失败并提供官方手动指南。
- FR-004 已安装 Engine 不覆盖升级；仅缺 Compose 时补齐；已有软件包冲突时停止，不删除业务容器或数据。
- FR-005 提交幂等且可回读；安装期间排斥其他主机生命周期、Agent 作业和任务；未知结果不能自动重试安装。
- FR-006 安装检查 Engine 和 Compose；对绑定身份匹配的受管 Agent 配置 docker 补充组并按需重启。确认面板说明权限与重启影响，最终应用可用性仍依赖 Agent 实际采集。
- FR-007 补装完成提示从现有应用显式重新部署，保留失败历史。
- FR-008 不向浏览器、日志和文档暴露凭据或原始命令输出；不扩大 AI 写权限。

### Key Entities
- Docker 环境观测：状态、静态原因、观测时间、来源。
- Docker 安装记录：主机、请求标识、凭据绑定、创建人、状态、阶段、静态原因与时间。

## Success Criteria
- SC-001 六种环境状态均有可重复验收，未知/过期观测误报缺失为零。
- SC-002 两个入口均能完成提交、跟踪、关闭重开和失败恢复。
- SC-003 重复同一请求只产生一次安装，未确认和非管理员提交均拒绝。
- SC-004 安装完成与应用重部署分开呈现，失败历史保留，凭据泄露为零。

## Assumptions
沿用现有 Ant Design 和中英文文案。安装由现有 SSH 受保护凭据通道执行；Agent 不提权。受管 Agent 补装时以固定 systemd drop-in 授予 docker 补充组，必要时重启 Agent；必须核验绑定身份，禁止更改非受管服务。第一版自动安装支持 Docker 官方 apt 仓库覆盖的 Ubuntu/Debian，其他系统显示手动指引。
