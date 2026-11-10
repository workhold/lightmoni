# Feature Specification: 单机内存图显示总内存

**Feature Branch**: `codex/119-host-memory-total`
**Created**: 2026-11-10
**Status**: Ready for implementation
**Input**: 用户取消“系统监控机器负载”，要求回退；仅在机器监控页面的内存图上补充当前机器总内存。

## User Scenarios & Testing

### User Story 1 - 在内存图直接识别机器容量 (Priority: P1)

用户进入单机监控，在内存图标题直接看到该机器的总内存，便于判断已有曲线与机器容量的关系。

**Why this priority**: 无需离开图表寻找容量信息。
**Independent Test**: 当前机器已有 16384 MiB 容量时，内存图标题显示总内存 16.0 GiB；其他机器容量不同则展示其自身值。

**Acceptance Scenarios**:
1. **Given** 当前机器已有有效容量，**When** 打开机器监控，**Then** 内存图标题显示总内存及 GiB 单位，与页面原物理内存摘要一致。
2. **Given** 当前机器尚无有效容量，**When** 打开内存图，**Then** 明确显示总内存未知，不显示 0、NaN 或其他机器容量。
3. **Given** 容量在既有刷新中更新或切换机器，**When** 新机器数据加载，**Then** 标题跟随当前机器容量变化。

### Edge Cases

- 缺失、非有限数值、非正数都视为未知。
- 离线或过期观测沿用原页面告警和服务端容量有效性，不捏造新鲜观测。
- 中英文、深浅色、1440px 与 390px 下标题可读，无页面横向溢出。

## Requirements

### Functional Requirements

- **FR-001**: 仅在已有单机内存图标题增加当前机器总内存说明，显示一位小数 GiB。
- **FR-002**: 使用当前机器已有容量数据，未知容量明确标识。
- **FR-003**: 沿用既有机器切换、容量刷新、图表查询与刷新行为。
- **FR-004**: 保留中英文显示及现有自适应布局。

### Key Entities

- **当前机器容量**：已存在的机器总内存观测，用于图表标题；不新增存储或采集。

## Success Criteria

### Measurable Outcomes

- **SC-001**: 16384 MiB 在中文与英文标题均显示 16.0 GiB；不同机器的容量互不串用。
- **SC-002**: 缺失、非正数或无效容量均显示未知。
- **SC-003**: 桌面与 390px 窄屏可读，无横向溢出；容量刷新后标题更新。

## Assumptions

- 用户所说“补充总内存”以在图标题常驻展示为准，复用页面原物理内存摘要的一位小数 GiB 口径。
- 原内存图已包含 used/available/total 指标曲线，无需新加指标。

## 架构影响

不适用：仅把现有机器响应中的容量补充到既有图标题，不改变组件职责、数据/控制路径、API、凭据、存储、协议或部署。无需更新 docs/system-design.md 或 Doca。无需升级 Agent。
