# Chem-Track AI 开发规则

<!-- BEGIN:nextjs-agent-rules -->
## Next.js 本地文档

当前 Next.js 版本可能包含训练数据之外的破坏性变化。修改框架相关代码前，先阅读 `node_modules/next/dist/docs/` 中对应指南，并遵循弃用提示。
<!-- END:nextjs-agent-rules -->

## 目标

优先验证真实产品价值，同时保持六个月后仍容易理解和修改。不要为尚未出现的问题引入复杂架构。

## 修改前

1. 阅读 `docs/DOMAIN.md`，确认术语和领域边界。
2. 阅读与任务直接相关的代码，不根据文档猜测实现。
3. 检查工作区已有修改，不覆盖用户或其他任务的改动。

## 工程边界

- 页面不得直接访问 Prisma。
- 简单 CRUD 可由 Route Handler 直接访问 Prisma。
- 涉及多个业务规则、多表写入或多个入口复用时，放入 `src/services/`。
- Repository 只在复杂查询被多个 Service 复用时建立，不作为强制层。
- 多表业务写入必须考虑事务和重复提交。
- 只有教师或机构可能调整的规则进入 `src/config/`。
- 不引入 Redis、消息队列、微服务、GraphQL 或 Kubernetes，除非已有明确需求。

## 数据安全

- Schema 变更必须包含 Prisma migration。
- 迁移必须在全新数据库上验证。
- 破坏性数据操作前必须创建并校验备份。
- 外部 LLM 失败不得破坏已保存业务数据。
- 日志、历史或辅助记录失败不得把已成功业务显示为失败。

## 文档规则

只在稳定认知变化时更新文档：

- 领域概念变化：`docs/DOMAIN.md`
- 架构或稳定规则变化：`docs/ARCHITECTURE.md`
- 启动、迁移、备份或恢复变化：`docs/OPERATIONS.md`
- 重要且难以逆转的选择：`docs/DECISIONS.md`

任务过程、Bug、Feature、重构和技术债进入 GitHub Issues。路由、Schema 和 ER 图等机械事实由脚本生成。

## 完成标准

至少运行与改动匹配的测试，并在可行时运行：

```bash
npm test
npm run test:coverage
npm run lint
npx tsc --noEmit
npm run build
```

涉及快速评分、草案复核或反馈工作台流程时，同时运行 `npm run test:e2e`。所有自动化测试必须使用隔离的临时数据库。
