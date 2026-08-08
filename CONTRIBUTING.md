# 开发流程

## 什么时候创建 Issue

以下改动创建 Issue：

- 用户可感知的新功能
- 可复现的 Bug
- 跨文件或跨模块重构
- 数据模型、迁移、备份和恢复工作
- 暂时不处理但需要保留的技术债

拼写、文案和显而易见的单行修复不强制创建 Issue。

## Issue 类型

- `bug`：现有行为不符合预期
- `enhancement`：新增用户价值
- `refactor`：保持行为不变的结构调整
- `tech-debt`：已确认但暂缓的工程风险
- `documentation`：稳定认知或操作方式变化

当前阶段不引入复杂 Project 看板。一个 Issue 只描述一个可验收目标。

## 开发步骤

1. Issue 写清问题、目标和验收标准。
2. 阅读 `AGENTS.md` 与相关稳定文档。
3. 检查现有代码和测试。
4. 实现最小充分改动。
5. 本地运行 `npm run verify:quick`；高风险或发布改动运行对应专项测试或 `npm run verify:release`。自动化通过后即可进入真实使用，不等待固定次数的人工流程；完整覆盖率、构建与浏览器回归由 CI 兜底。
6. Commit 中引用 Issue，例如 `Refs #12`；完成时使用 `Closes #12`。
7. 只有稳定认知变化时才更新 `docs/`。

## 验证层级

- `npm run verify:quick`：日常开发默认入口，执行 lint、类型检查和单元/集成测试。
- `npm run verify:quality`：执行 CI quality 检查，包括文档、隐私、覆盖率和生产构建。
- `npm run verify:browser`：在隔离的临时数据库上执行 WebKit（Safari 基线）回归。
- `npm run test:e2e:chromium`：保留的 Chromium 兼容性回归入口，仅在需要时手动运行，不属于日常 CI 门禁。
- `npm run verify:release`：正式发布前执行 quality 与 browser 的完整合集。

这些命令都会在运行前后自动比较真实 SQLite 主文件和 WAL 的 size、mtime 与 SHA-256，任何变化都使验证失败；实际测试仍只使用系统临时目录中的隔离数据库。成功时只输出精简摘要，完整日志保存在 `.verification-logs/`；失败时先查看输出中的有限日志末尾，再按需打开单个日志。CI 会上传完整日志 artifact，已通过同一提交的 CI 时无需重复本地全量验证。

人工冒烟按变化边界触发，而不是每次发布重复执行：WCG Accessibility、会话定位或草稿填入变化时做一次真实“不发送”验证；破坏性 migration 先备份并验证；安装、签名和进程托管变化在干净环境验证。其余真实使用属于自动化通过后的持续产品验证，发现问题再进入 Issue。

## 文档职责

| 内容 | 归属 |
|---|---|
| 当前任务、Bug、Feature、技术债 | GitHub Issues |
| 版本变化 | Git tag + GitHub Release |
| 领域概念与术语 | `docs/DOMAIN.md` |
| 架构和稳定规则 | `docs/ARCHITECTURE.md` |
| 迁移、备份、恢复 | `docs/OPERATIONS.md` |
| 重要设计选择及原因 | `docs/DECISIONS.md` |
| Schema、路由和 ER 图 | `docs/generated/` |
| 隐私分类、禁止提交内容和泄露处置 | `docs/PRIVACY.md` |
