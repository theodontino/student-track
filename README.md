# Chem-Track AI

高中化学教师 Web 智能学生追踪系统。

**核心工作流**：`家校背景 + 课堂记录 → 教师确认 → 上下文组装 → LLM 反馈草稿 → Excel 导出`

## 快速启动

```bash
cd chem-track-ai
npm install
npx prisma migrate deploy # 首次运行及升级执行迁移
npm run db:seed
npm run dev              # → http://localhost:3000
npm test
npx tsc --noEmit
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
- **LLM**: OpenAI 兼容接口，可保存并切换多个云端或本地 LM Studio 配置
- **测试**: Vitest，包含纯函数、API 与数据库集成测试
- **样式**: Tailwind CSS 4

## 功能

| 模块 | 功能 |
|------|------|
| 仪表盘 | 当前学期学生/班级概览、四维均分、红黄预警、按学期往期回顾 |
| 学生管理 | 按班级分组/折叠、搜索、标签、评分预览、Excel 导入 |
| 手动评分 | 卡片评分、考勤勾选、批量设置、长期历史恢复 |
| NL 录入 | 自然语言 → LLM 解析 → 草案（SSE 流式），未提及学生自动缺勤 |
| 复核中心 | 草案审核、分数修改、按班级筛选、确认/放弃 |
| 课后反馈 | 家校背景准备、课堂回顾、助教 Excel、结构化确认、流式反馈与增强 Excel 导出 |
| 报告生成 | 班级日报、单人家校反馈、批量流式反馈、历史恢复 |
| 数据导出 | 5 Sheet Excel：档案/指标/事件/沟通/考勤，日期范围可恢复 |
| 学期管理 | 学期列表/详情、课次创建/删除/排序 |
| 操作日志 | SystemLog 面板，保留 90 天 |
