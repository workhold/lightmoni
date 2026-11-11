# Implementation Plan: Agent 首装残留与恢复闭环修复

**Branch**: `codex/122-agent-install-recovery` | **Date**: 2026-11-11 | **Spec**: [spec.md](spec.md)

## Summary

把两个受管服务的覆盖目录纳入现有安装足迹、路径安全校验、卸载证据与显式清理。保留禁止服务覆盖的安装限制和 unknown 的保守语义。核对失败后复用已有部署 GET 读回解除不必要的页面锁定，失败提示保留。

## Technical Context

- Language/Version: 现有 TypeScript / Node >=22.19；POSIX shell。
- Dependencies: 复用现有 SSHRunner、SQLite、React 与系统 systemctl/stat/sha256sum；无新依赖。
- Storage: 不新增迁移、表或字段；沿用 program_sha256 和部署诊断。
- Testing: node:test 执行真实隔离 shell；现有 Playwright 页面场景；runtime/web typecheck。
- Target: Linux systemd 主机；macOS 上运行路径重写 fixture。
- Scope: 两个固定 .service.d 目录、SSH 原因白名单、首装恢复交互。
- Constraints: 不跟随链接，不接受请求指定路径，不自动清理，不暴露 token/key/raw SSH 日志；平面目录最多 128 个普通文件，每个不超过 64 KiB。
- Performance: 仅固定服务目录，快照校验有界；恢复错误最多增加一次现有记录读取。

## Constitution Check

设计前与设计后均通过：宿主权限和确认不变；持久数据保留；SDD 先于实现；测试覆盖故障链和拒绝边界；无新依赖。架构同步不适用：修复已有固定程序足迹遗漏和已有恢复交互读回，不变更组件职责、数据/控制通道、协议形状、存储、凭据边界或拓扑。适用用户明确提供的架构同步规则，未以本地 constitution 的在线同步豁免替代用户要求。

## Project Structure

- runtime/src/shared/agent-maintenance-shell.ts：覆盖目录常量、共享校验/摘要/清理函数。
- deploy/agent/{install,uninstall}.sh：fresh 足迹与共享保护块同步；显式卸载清理。
- runtime/src/server/machine-agent-lifecycle.ts：观测、快照与受管卸载。
- runtime/src/server/{machine-ssh,managed-machines}.ts：固定错误码与中文解释。
- web/src/app/MachinesPage.tsx：恢复错误后读回原部署。
- runtime/test/{machine-ssh,machine-agent-lifecycle,agent-uninstall-script,install-release,machine-installation-recovery}.test.ts：回归。
- scripts/test-agent-install-recovery-ui.mjs：隔离 Playwright 交互验证。
- specs/122-agent-install-recovery/{research,data-model,quickstart,tasks}.md、contracts/maintenance.md、evidence/validation.md。

## Implementation Sequence

1. 足迹一致性与首装前拦截。
2. 共享安全校验和摘要，再接入两个显式卸载入口；删除前重检。
3. 诊断白名单和页面恢复读回，保留原状态及请求隔离。
4. 针对性回归、类型检查、构建；记录证据并同步 main 后创建 GitHub PR。

## Complexity Tracking

无新增抽象层、数据迁移或架构例外。

## Release and production verification

先记录授权与任务，再通过 PR #166 合入 main。以干净 git archive 构建两平台成品，验证 revision、非 root、健康、发行校验和及编译后修复行为后发布固定镜像。生产切换沿现有 Compose、卷与环境，先做受保护的一致备份和回滚记录；核对镜像、健康、安装/卸载下载内容及页面恢复入口，将白名单回执记录到本 SDD。发行证据通过后续功能 PR 归档。
