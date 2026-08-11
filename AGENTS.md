# Student Track 开发规则

<!-- BEGIN:nextjs-agent-rules -->
## Next.js 本地文档

当前 Next.js 版本可能包含训练数据之外的破坏性变化。修改框架相关代码前，先阅读 `node_modules/next/dist/docs/` 中对应指南，并遵循弃用提示。
<!-- END:nextjs-agent-rules -->

## 目标

优先验证真实产品价值，同时保持六个月后仍容易理解和修改。不要为尚未出现的问题引入复杂架构。

Student Track 正在向 1.0 收敛：默认只接受维护、稳定性、兼容性、隐私与缺陷修复。需要明显改变产品工作流、领域规则或功能边界的提议必须先建立 GitHub Issue；确认现有方案走不通后，才能作为单独设计任务实施。

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

## 隐私开发

- 修改前阅读 `docs/PRIVACY.md`，所有代码按仓库未来可能公开处理。
- 禁止提交真实学生数据、数据库、导出、音频、日志、凭据、个人绝对路径和内部运行 handoff。
- 测试 fixture 必须是固定合成数据，不得从真实 `dev.db` 抽样或匿名化生成。
- 新增路径必须使用项目相对路径、`$HOME`、`os.homedir()` 或环境变量。
- 提交前运行 `npm run privacy:check`；公开或发布前还要扫描完整 Git 历史。
- 发现泄露先停止推送并轮换凭据，不得只用后续提交删除历史中的敏感内容。

## 文档规则

只在稳定认知变化时更新文档：

- 领域概念变化：`docs/DOMAIN.md`
- 架构或稳定规则变化：`docs/ARCHITECTURE.md`
- 启动、迁移、备份或恢复变化：`docs/OPERATIONS.md`
- 重要且难以逆转的选择：`docs/DECISIONS.md`
- 隐私分类、禁止提交内容和泄露处置：`docs/PRIVACY.md`

任务过程、Bug、Feature、重构和技术债进入 GitHub Issues。路由、Schema 和 ER 图等机械事实由脚本生成。

修改 Markdown、Schema 或 API 路由后运行 `npm run docs:check` 和 `npm run docs:links`；CI 使用相同命令阻止过期生成物与失效本地链接进入主分支。

## 跨仓库协议治理

Student Track 与 WCG 的跨仓库契约以独立的 `student-track-wcg-protocols` 仓库为唯一规范来源。
涉及跨仓 JSON、HTTP、交换目录、哈希、错误码、能力、授权、no-send 或发布顺序的 Feature，
必须先在协议仓库建立并接受 Issue/RFC，再在本仓库实现。`docs/contracts/` 中已登记的 Schema
与示例是生成快照，不得在本仓库单独编辑；边界和同步方式见 `docs/contracts/README.md`。

## 产品版本（Zhuiver）

Student Track 的程序版本遵循协议仓库 `Zhuiver.md`，而协议 `contractVersion`、URL 路径、
协议快照 tag 和兼容矩阵继续遵循协议仓库自己的版本规则。两者不能互相替代。

每个发布 PR 必须写明上一版本、本版本、Zhuiver 分类（`PATCH`/`MINOR`/`MAJOR`）、用户
主张、核心工作流、领域模型和协议影响。页面数量、文件数量、代码行数和重写技术栈不能
单独决定版本级别。使用 `docs/release-evidence/TEMPLATE.md` 与
`npm run release:check-version -- <record>` 形成可检查的发布记录。

## 完成标准

验证采用“本地精简输出、CI 全量兜底、失败时按需展开”的流程。测试运行时间本身不是问题，默认禁止为了汇报成功而读取或回传完整测试日志。

```bash
npm run verify:quick
```

`verify:quick` 执行 lint、类型检查和单元/集成测试；成功时只输出步骤、耗时和测试摘要，完整日志写入被 Git 忽略的 `.verification-logs/`。

所有 `verify:*` 入口都会在运行前后自动比较真实 SQLite 主文件和 WAL 的 size、mtime 与 SHA-256；自动化测试必须使用隔离临时数据库，真实库指纹变化时验证直接失败。验证通过后可以立即进入真实使用，不以固定次数的人工重复流程作为日常发布门禁。

### Agent 验证策略

- 文案、样式、小型组件或低风险重构：运行改动直接相关的测试（如有），然后运行 `npm run verify:quick`。完整覆盖率、构建和双浏览器回归交给 CI。
- API、Service、状态管理、LLM、导入、回滚或数据写入：先运行相关测试，再运行 `npm run verify:quick`；涉及页面、导航或用户流程时再运行 `npm run test:e2e`（WebKit / Safari 基线）。
- Schema、migration、发布候选或跨模块高风险变更：运行 `npm run verify:release`，或者推送当前提交并等待同一提交的 CI `quality` 与 `browser` 全部通过。已通过同一提交的 CI 时，不重复本地全量验证。
- CI 的 `quality` 运行 `npm run verify:quality`；`browser` 运行 `npm run verify:browser`。两个浏览器使用各自的隔离临时数据库。
- 人工冒烟只由相关边界变化触发：WCG Accessibility、会话定位或草稿填入变化时验证一次真实“不发送”；破坏性 migration 先备份并验证迁移；安装、签名或进程托管变化在干净环境验证。未变化的边界不重复人工验收。
- 成功时只读取命令退出状态和精简摘要，不打开 `.verification-logs/` 或 CI artifact。
- 失败时只查看失败步骤打印的末尾日志；仍无法定位时，再读取该步骤的单个日志或 CI artifact，不批量读取全部日志。
- 需要实时完整输出进行诊断时可临时使用 `VERIFY_VERBOSE=1 npm run verify:quick`，不得作为默认验证方式。

所有自动化测试必须使用隔离的临时数据库，不得为了验证读取或修改真实 `dev.db`。
