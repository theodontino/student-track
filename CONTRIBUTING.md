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
- `feature`：新增用户价值
- `refactor`：保持行为不变的结构调整
- `tech-debt`：已确认但暂缓的工程风险
- `docs`：稳定认知或操作方式变化

当前阶段不引入复杂 Project 看板。一个 Issue 只描述一个可验收目标。

## 开发步骤

1. Issue 写清问题、目标和验收标准。
2. 阅读 `AGENTS.md` 与相关稳定文档。
3. 检查现有代码和测试。
4. 实现最小充分改动。
5. 运行测试、类型检查和 lint；涉及核心页面流程时同时运行 `npm run test:e2e`。
6. Commit 中引用 Issue，例如 `Refs #12`；完成时使用 `Closes #12`。
7. 只有稳定认知变化时才更新 `docs/`。

## 文档职责

| 内容 | 归属 |
|---|---|
| 当前任务、Bug、Feature、技术债 | GitHub Issues |
| 版本变化 | Git commits / GitHub Releases |
| 领域概念与术语 | `docs/DOMAIN.md` |
| 架构和稳定规则 | `docs/ARCHITECTURE.md` |
| 迁移、备份、恢复 | `docs/OPERATIONS.md` |
| 重要设计选择及原因 | `docs/DECISIONS.md` |
| Schema、路由和 ER 图 | `docs/generated/` |
