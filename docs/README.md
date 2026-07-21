# 文档索引

文档只记录长期稳定认知，不记录项目进度。

| 文档 | 回答的问题 |
|---|---|
| [`DOMAIN.md`](DOMAIN.md) | 系统里有哪些核心概念，它们分别代表什么？ |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | 代码如何分层，稳定业务规则在哪里？ |
| [`OPERATIONS.md`](OPERATIONS.md) | 如何启动、迁移、备份、恢复和验证？ |
| [`DECISIONS.md`](DECISIONS.md) | 为什么做出少数重要且长期有效的设计选择？ |
| [`PRIVACY.md`](PRIVACY.md) | 哪些数据不得进入 Git，开发与公开发布如何检查？ |
| [`UX.md`](UX.md) | 页面采用什么视觉、交互、状态和响应式规则？ |
| [`generated/SCHEMA.md`](generated/SCHEMA.md) | 当前 Schema 字段和 ER 关系是什么？ |
| [`generated/ROUTES.md`](generated/ROUTES.md) | 当前 API 路由和 HTTP 方法是什么？ |

以下内容不进入长期文档：当前版本进度、功能完成百分比、测试数量、文件数量、Bug 列表和下一版本计划。

Schema 或 API 路由变化后运行 `npm run docs:generate`。提交前运行 `npm run docs:check` 和 `npm run docs:links`；CI 会使用相同命令检查生成物与本地链接。
