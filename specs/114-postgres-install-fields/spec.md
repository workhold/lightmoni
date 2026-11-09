# Feature Specification: PostgreSQL 安装身份参数

**Feature Branch**: `codex/114-postgres-install-fields`
**Created**: 2026-11-08
**Status**: Implemented
**Input**: PostgreSQL 的用户名、密码和数据库名都支持安装时指定。

## User Scenarios & Testing

### User Story 1 - 直接指定数据库连接信息 (Priority: P1)

管理员安装 PostgreSQL 时，在基本表单中看到并修改用户名、密码和数据库名，无需展开高级设置寻找连接信息。

**Why this priority**: 默认只显示密码，容易让用户误以为用户名和数据库名不可配置。
**Independent Test**: 打开 PostgreSQL 安装表单，保留高级设置折叠，修改三项并提交，检查保存的应用身份与输入一致。

**Acceptance Scenarios**:
1. **Given** 新打开的安装表单，**When** 查看基本参数，**Then** 用户名、密码和数据库名均可见且可编辑，用户名默认为 `lightmoni`、数据库名默认为 `app`。
2. **Given** 修改过三项参数，**When** 展开或折叠高级设置后安装，**Then** 输入保留且提交准确，每个参数仅出现一次。
3. **Given** 中文或英文界面及窄屏，**When** 打开安装表单，**Then** 三项可见、密码遮蔽、无横向溢出。

### Edge Cases
- 密码缺失或参数不符合已有格式限制时，沿用原有校验。
- 其他应用的基本和高级参数分组保持现有行为。
- 已安装实例不自动修改账号、密码或数据库。

## Requirements

### Functional Requirements
- **FR-001**: PostgreSQL 安装基本表单必须提供用户名、密码和数据库名。
- **FR-002**: 保留现有默认值、可选性、格式限制及密码遮蔽。
- **FR-003**: 高级设置切换必须保留输入且不重复显示同一参数。
- **FR-004**: 自定义值必须沿用现有安装流程准确保存；公开响应不得泄露密码。

## Success Criteria

### Measurable Outcomes
- **SC-001**: 中英文、桌面及 390px 窄屏的四种验收组合均能直接修改三项参数。
- **SC-002**: 自定义身份和默认身份的安装验证均通过；高级设置切换不丢失输入。

## Assumptions
- 需求针对 PostgreSQL 商店应用的新安装；复用已有安装能力和界面样式。

## Architecture Impact
不适用：仅调整现有安装字段的展示位置，组件职责、数据与控制路径、凭据边界、存储、协议及部署拓扑均不变。仓库系统设计与 Doca 在线设计无需修改。
