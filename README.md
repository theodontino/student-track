# Chem-Track AI

高中化学教师 Web 智能学生追踪系统。

**核心工作流**：`家校背景 + 课堂记录 → 教师确认 → 上下文组装 → LLM 反馈草稿 → Excel 导出`

## 快速启动

本项目使用 Node.js 24 LTS 和 npm 11，并且只支持本机 `127.0.0.1` 访问。

```bash
cd chem-track-ai
npm install
npx prisma migrate deploy # 首次运行及升级执行迁移
npm run db:seed
npm run dev              # → http://127.0.0.1:3000
npm test
npm run test:coverage
npm run test:e2e
npx tsc --noEmit
```

## 工程文档

- [领域模型](docs/DOMAIN.md)：系统中的核心概念与统一术语
- [架构设计](docs/ARCHITECTURE.md)：分层、数据流和稳定业务约束
- [运维手册](docs/OPERATIONS.md)：迁移、备份、恢复和发布
- [设计决策](docs/DECISIONS.md)：少量需要长期保留的技术选择
- [隐私方针](docs/PRIVACY.md)：禁止提交内容、开发约束与公开发布检查
- [UX 规范](docs/UX.md)：页面模板、视觉、状态反馈与响应式约束
- [参与开发](CONTRIBUTING.md)：Issue 与开发流程
- [AI 规则](AGENTS.md)：AI 修改代码时必须遵守的边界

任务进度、Bug、Feature 和技术债使用 GitHub Issues 跟踪，不写入长期工程文档。

## 技术栈

- **框架**: Next.js 16 (App Router)
- **ORM**: Prisma 7 + libsql (SQLite)
- **LLM**: OpenAI 兼容接口，可保存并切换多个云端或本地 LM Studio 配置
- **测试**: Vitest，包含纯函数、API 与数据库集成测试
- **浏览器回归**: Playwright，使用独立临时数据库和应用副本
- **样式**: Tailwind CSS 4

测试命令会在系统临时目录中创建数据库，不会读写项目的 `dev.db`。

## 功能

| 模块 | 功能 |
|------|------|
| 仪表盘 | 当前学期学生/班级概览、四维均分、红黄预警、按学期往期回顾 |
| 学生档案 | 按班级分组/折叠、搜索、标签、Excel 导入，以及按学期隔离的四维平均表现和综合分 |
| 手动评分 | 卡片评分、考勤勾选、批量设置、长期历史恢复 |
| 课堂录入 | `/entry` 中完成自然语言输入、LLM 解析、草案复核和确认写入 |
| 课后反馈 | 统一单人/批量家校反馈、课堂回顾、助教 Excel、结构化确认和增强 Excel 导出 |
| 班级日报 | 按学期、班级和课次生成班级层面的日报，不混入学生反馈 |
| 数据导出 | 5 Sheet Excel：档案/指标/事件/沟通/考勤，日期范围可恢复 |
| 学期管理 | 学期列表/详情、课次创建/删除/排序 |
| 系统中心 | LLM 配置、WeCom/FunASR 集成状态、数据库备份和 90 天操作日志 |

## 前端结构

- `src/app/` 只保留路由组合与旧路由重定向。
- `src/features/` 按教学上下文、录入、反馈、评分、报告、学生、课程和系统划分职责。
- `src/components/ui/` 提供轻量设计系统；`src/lib/api-client.ts` 统一 JSON 请求、错误和下载行为。
- 教学上下文使用 `semesterId`、`class`、`sessionCode` 查询参数，刷新与工作台跳转后可以恢复。
- 录入、复核、反馈、评分、日报、导出和转写选择会在当前浏览器标签页内自动保留；凭据和未提交的本地文件不会写入恢复存储。
- `/input`、`/review`、`/report`、`/settings`、`/system-logs` 和 `/past-overview` 是兼容入口，至少保留到 v0.18。

## 许可证

Copyright © 2026 theodontino。

本项目采用 [GNU Affero General Public License v3.0 only](LICENSE)，SPDX 标识为 `AGPL-3.0-only`。允许使用、修改、分发和商业使用；分发修改版或使用修改版提供网络服务时，必须按同一许可证向相应用户提供完整源代码。学生数据、运行数据库、导出文件和其他用户内容不因本软件许可证而获得公开授权。
