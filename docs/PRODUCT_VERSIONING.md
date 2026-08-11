# Student Track 产品版本（Zhuiver）

Student Track 的产品版本遵循协议仓库中的 [`Zhuiver.md`](../../student-track-wcg-protocols/Zhuiver.md)。
本文件是本仓库的适配说明，不复制或重新定义 Zhuiver 的语义。

## 版本来源

- `package.json` 的 `version` 是产品版本唯一来源；`package-lock.json` 的根版本必须同步。
- system health 和发布文档读取同一版本；版本 tag、GitHub Release 标题和产品版本必须一致。
- 协议仓库的 `contractVersion`、URL 路径、协议快照 tag 和兼容矩阵不是产品版本来源。

## 发布 PR 必填内容

每个版本 PR 或发布记录必须写明：

- 上一版本、本版本和 `PATCH`、`MINOR` 或 `MAJOR`；
- 用户产品主张是否变化，以及工作流、领域模型和部署/数据所有权是否变化；
- 协议契约是否变化。若为 `yes`，必须先引用协议仓库 Issue/RFC 和协议 tag；
- `npm run verify:release` 或同一提交的 CI 质量/浏览器证据，以及迁移、隐私和回滚证据。

页面、文件、代码行数和实现重写不是版本分类依据。修复既有教学工作台承诺，即使新增页面或
入口，也按 PATCH；新增独立业务对象或工作流且仍是同一产品，按 MINOR；改成机构、多角色、
云同步等新的产品范式，才按 MAJOR。

## 当前基线

Student Track `1.1.4` 按 Zhuiver 记录为 PATCH：它保持单教师、本地优先、证据驱动的教学
工作台身份和既有 handoff v1。协议 v1 的版本身份独立维护；产品 PATCH 不代表协议 PATCH。

## 可机器检查的记录

从模板复制发布记录后运行：

```bash
npm run release:check-version -- docs/release-evidence/X.Y.Z.md
```

检查器只验证版本字段、分类和证据是否完整；它不代替 `verify:release`、真实使用验收或协议
联合契约测试。正式发布仍需遵守 [`OPERATIONS.md`](OPERATIONS.md) 的发布与封档流程。
