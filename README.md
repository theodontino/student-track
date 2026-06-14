# Chem-Track AI

高中化学教师 Web 智能学生追踪系统。

**核心工作流**：`NL 输入 → LLM 解析 → LLM 自审 → 教师复核 → 写入数据库`

## 快速启动

```bash
cd chem-track-ai
npm install
npx prisma migrate deploy # 首次运行及升级执行迁移
npm run db:seed
npm run dev           # → http://localhost:3000
npm test           # 57 test cases
npx tsc --noEmit   # 0 errors
```

## 工程文档

- [领域模型](docs/DOMAIN.md)：系统中的核心概念与统一术语
- [架构设计](docs/ARCHITECTURE.md)：分层、数据流和稳定业务约束
- [运维手册](docs/OPERATIONS.md)：迁移、备份、恢复和发布
- [设计决策](docs/DECISIONS.md)：少量需要长期保留的技术选择
- [参与开发](CONTRIBUTING.md)：Issue 与开发流程
- [AI 规则](AGENTS.md)：AI 修改代码时必须遵守的边界

任务进度、Bug、Feature 和技术债使用 GitHub Issues 跟踪，不写入长期工程文档。

## 技术栈

- **框架**: Next.js 16 (App Router)
- **ORM**: Prisma 7 + libsql (SQLite)
- **LLM**: DeepSeek V4 Flash (OpenAI SDK)
- **测试**: vitest (57 例), supertest/API 集成测试
- **样式**: Tailwind CSS 4

## 功能

| 模块 | 功能 |
|------|------|
| 仪表盘 | 班级/学生概览、四维均分进度条、预警系统（红/黄分级） |
| 学生管理 | 按班级分组/折叠、搜索、标签、评分预览、Excel 导入 |
| 快速评分 | 卡片评分、考勤勾选、批量设置、长期历史恢复 |
| NL 录入 | 自然语言 → LLM 解析 → 草案（SSE 流式），未提及学生自动缺勤 |
| 复核中心 | 草案审核、分数修改、按班级筛选、确认/放弃 |
| 一键反馈 | 4 步向导：输入→确认→流式反馈→长期导出 |
| 报告生成 | 班级日报、单人家校反馈、批量流式反馈、历史恢复 |
| 数据导出 | 5 Sheet Excel：档案/指标/事件/沟通/考勤，日期范围可恢复 |
| 学期管理 | 学期列表/详情、课次创建/删除/排序 |
| 操作日志 | SystemLog 面板，保留 90 天 |
