# Student Track 开发规则

<!-- BEGIN:nextjs-agent-rules -->
## Next.js 本地文档

当前 Next.js 版本可能包含训练数据之外的破坏性变化。修改框架相关代码前，先阅读 `node_modules/next/dist/docs/` 中对应指南，并遵循弃用提示。
<!-- END:nextjs-agent-rules -->

## 目标

优先验证真实产品价值，同时保持六个月后仍容易理解和修改。不要为尚未出现的问题引入复杂架构。

Student Track 已进入 1.x 产品期。默认优先处理维护、稳定性、兼容性、隐私、缺陷，以及已经由真实使用验证并在 GitHub Issue 中收敛范围的需求。需要明显改变产品工作流、领域规则或功能边界的提议必须先建立 GitHub Issue；确认用户价值、兼容边界和回滚方案后，才能作为独立设计任务实施。

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

只在稳定认知变化时更新长期文档：

- 领域概念变化：`docs/DOMAIN.md`
- 架构或稳定规则变化：`docs/ARCHITECTURE.md`
- 启动、迁移、备份或恢复变化：`docs/OPERATIONS.md`
- 重要且难以逆转的选择：`docs/DECISIONS.md`
- 隐私分类、禁止提交内容和泄露处置：`docs/PRIVACY.md`
- LLM 提示词边界变化：`docs/PROMPTING.md`
- 稳定 UX 规则变化：`docs/UX.md`

当前事实必须保持唯一来源：

- Student Track 产品版本只以 `package.json` 为源；根 README 与 `docs/RELEASES.md` 只是可检查的展示副本。
- 当前跨组件配对只在 `docs/RELEASES.md` 维护；单个版本的历史理由与验证证据进入 `docs/release-evidence/`。
- 不在 `PRODUCT_VERSIONING.md`、WCG 适配说明、架构或决策文档中额外维护“当前版本/当前基线”。
- 路由、Schema 和 ER 图等机械事实由脚本生成。

任务过程、Bug、Feature、重构和技术债进入 GitHub Issues。已经由 release evidence 保存的版本历史不要再次复制到长期文档。

纯 Markdown 改动按 L0 运行 `npm run docs:check`、`npm run docs:links`、`node scripts/check-doc-semantics.mjs` 和 `npm run privacy:check`；修改发布记录时再运行对应的 `npm run release:check-version -- <record>`。Schema 或 API 路由变化仍需追加文档检查，但它们属于产品改动，不能按 L0 处理。

## 跨仓库协议治理

Student Track 与 WCG 的跨仓库契约以独立的 `theodontino/protocol-st-wcg` 仓库为唯一规范来源。涉及跨仓 JSON、HTTP、交换目录、哈希、错误码、能力、授权、no-send 或发布顺序的 Feature，必须先在该协议仓库建立并接受 Issue/RFC，再在本仓库实现。`docs/contracts/` 中已登记的 Schema 与示例是生成快照，不得在本仓库单独编辑；边界和同步方式见 `docs/contracts/README.md`。

Student Track 与 STEP 的正式协议治理入口是 `theodontino/Protocol-of-sts`。当前 experimental STEP bridge 不是正式协议，不得把历史延期 RFC 当作实现蓝图或兼容承诺。

## 产品版本（Zhuiver）

Student Track 的程序版本遵循 `theodontino/Protocol-of-sts` 中的 `Zhuiver.md`；WCG 或 STEP 协议的 `contractVersion`、URL 路径、协议快照 tag 和兼容矩阵继续遵循各自协议仓库的版本规则。产品版本和协议版本不能互相替代。

每个发布 PR 必须写明上一版本、本版本、Zhuiver 分类（`PATCH`/`MINOR`/`MAJOR`）、用户主张、核心工作流、领域模型和协议影响。页面数量、文件数量、代码行数和重写技术栈不能单独决定版本级别。使用 `docs/release-evidence/TEMPLATE.md` 与 `npm run release:check-version -- <record>` 形成可检查的发布记录。

## 完成标准

验证采用“先分类、按影响范围运行、失败时按需展开”的流程。测试运行时间本身不是问题，但不得为了汇报成功而重复运行无关门禁或读取、回传完整测试日志。详细口径见 `docs/OPERATIONS.md` 的“变更分级与 CI 证据”。

所有 `verify:*` 入口都会在运行前后自动比较真实 SQLite 主文件和 WAL 的 size、mtime 与 SHA-256；自动化测试必须使用隔离临时数据库，真实库指纹变化时验证直接失败。验证通过后可以立即进入真实使用，不以固定次数的人工重复流程作为日常发布门禁。

### Agent 验证策略

- 任何验证开始前，先按累计改动记录 L0–L3 等级和 `browser`、`database`、`build`、`windows`、`macos`、`contract`、`ci`、`release` 等实际影响范围。混合改动取最高等级，范围取并集；无法可靠分类时按 L2，并运行通用基线与生产构建。
- L0 只适用于严格文档白名单，不包含 CI workflow、依赖或构建配置、Prisma、检查脚本和协议快照。只运行文档与隐私检查；不得运行构建、应用测试、E2E 或平台流程。
- L1 普通应用改动运行 lint、类型检查、单元/集成测试和 Chromium 冒烟。
- L2 平台或构建敏感改动运行适用的通用检查，再追加受影响 scope 的平台、集成或 E2E；只有 Windows 敏感改动要求 Windows，只有浏览器敏感改动要求完整浏览器矩阵。
- L3 发布或高风险改动运行当前实际支持的完整发布矩阵：macOS Full 生产构建与启动、Windows Core 离线包构建、安装、启动和重启持久化、Chromium 与 WebKit 发布 E2E，以及发布级隐私、迁移、备份和恢复检查。仓库具备签名和公证流程前，不把 macOS 步骤称为 packaging。
- CI 分别记录当前候选 `HEAD_SHA` 和最近完成产品验证的 `PRODUCT_VERIFIED_SHA`。严格 L0 提交在当前 `HEAD_SHA` 通过 gate，并确认祖先关系和累计差异仍为 L0 后，可以继承产品证据；产品改动通过相应门禁后再更新 `PRODUCT_VERIFIED_SHA`。
- 同一 `HEAD_SHA` 下，确认属于抖动的失败 job 可以单独重试一次，不重启整个矩阵。修复产生新提交后必须重新分类，并运行该新提交计划要求的全部 job；只有严格 L0 可以按上一条继承产品证据。
- 不为成功或预期跳过的 CI job 启动审计或评审 subagent。任何 in-scope job 出现失败、超时、取消或异常跳过都要调查。
- 人工冒烟只由相关边界变化触发：WCG Accessibility、会话定位或草稿填入变化时验证一次真实“不发送”；破坏性 migration 先备份并验证迁移；安装、签名或进程托管变化在干净环境验证。未变化的边界不重复人工验收。
- 成功时只读取命令退出状态和精简摘要，不打开 `.verification-logs/` 或 CI artifact。
- 失败时只查看失败步骤打印的末尾日志；仍无法定位时，再读取该步骤的单个日志或 CI artifact，不批量读取全部日志。
- 需要实时完整输出进行诊断时可临时使用 `VERIFY_VERBOSE=1 npm run verify:quick`，不得作为默认验证方式。

所有自动化测试必须使用隔离的临时数据库，不得为了验证读取或修改真实 `dev.db`。
