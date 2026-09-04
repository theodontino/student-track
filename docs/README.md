# 文档索引

Student Track 的长期文档只记录稳定认知，不记录项目进度。当前版本、一次性验证证据和历史发布信息有单独来源，避免同一事实在多篇文档中长期漂移。

| 文档 | 回答的问题 |
|---|---|
| [`DOMAIN.md`](DOMAIN.md) | 系统里有哪些核心概念，它们分别代表什么？ |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | 代码如何分层，稳定业务规则在哪里？ |
| [`PROMPTING.md`](PROMPTING.md) | LLM 提示词如何维护，哪些是硬边界，哪些应保留生成空间？ |
| [`OPERATIONS.md`](OPERATIONS.md) | 如何启动、迁移、备份、恢复和验证？ |
| [`DECISIONS.md`](DECISIONS.md) | 为什么做出少数重要且长期有效的设计选择？ |
| [`PRIVACY.md`](PRIVACY.md) | 哪些数据不得进入 Git，开发与公开发布如何检查？ |
| [`UX.md`](UX.md) | 页面采用什么视觉、交互、状态和响应式规则？ |
| [`PRODUCT_VERSIONING.md`](PRODUCT_VERSIONING.md) | Student Track 如何应用 Zhuiver，产品版本的唯一来源是什么？ |
| [`RELEASES.md`](RELEASES.md) | 当前 ST 与外部组件如何配对，发布和联合验证边界是什么？ |
| [`WECOM_FILE_HANDOFF.md`](WECOM_FILE_HANDOFF.md) | Student Track 如何消费 WCG 协议并完成教师复核？ |
| [`generated/SCHEMA.md`](generated/SCHEMA.md) | 当前 Schema 字段和 ER 关系是什么？ |
| [`generated/ROUTES.md`](generated/ROUTES.md) | 当前 API 路由和 HTTP 方法是什么？ |

## 事实来源

- 产品版本唯一来源：根 `package.json`。
- 当前跨组件兼容关系：`RELEASES.md`。
- 单个版本的历史理由与验证证据：`release-evidence/`。
- WCG 跨仓协议 canonical：`theodontino/protocol-st-wcg`；本仓 `contracts/` 只是同步快照。
- STEP 正式协议治理与 Zhuiver：`theodontino/Protocol-of-sts`。
- Schema 与 API 路由：由代码自动生成，不手工维护。

以下内容不进入长期文档：当前功能完成百分比、测试数量、文件数量、Bug 列表、下一版本计划、一次性 CI 运行详情和已经由 release evidence 保存的发布历史。

Schema 或 API 路由变化后运行 `npm run docs:generate`。提交前运行 `npm run docs:check`、`npm run docs:links`、`node scripts/check-doc-semantics.mjs` 和 `npm run privacy:check`；CI 会执行同类检查。
