# Student Track

高中化学教师 Web 智能学生追踪系统。

**核心工作流**：`家校背景 + 课堂记录 → 教师确认 → 上下文组装 → LLM 反馈草稿 → Excel 导出`

当前开发版本为 **1.1.0-beta.4**；当前稳定版本为 **1.0.0**。1.1 beta 与
WCG 0.5 beta 联合验证，handoff v1 与 receipt v1 保持兼容。

## 快速启动

本项目使用 Node.js 24 LTS 和 npm 11，并且只支持本机 `127.0.0.1` 访问。

```bash
git clone https://github.com/theodontino/student-track.git
cd student-track
npm install
npx prisma migrate deploy # 首次运行及升级执行迁移
npm run db:seed
npm run dev              # → http://127.0.0.1:3000
npm run verify:quick
```

## 工程文档

- [领域模型](docs/DOMAIN.md)：系统中的核心概念与统一术语
- [架构设计](docs/ARCHITECTURE.md)：分层、数据流和稳定业务约束
- [运维手册](docs/OPERATIONS.md)：迁移、备份、恢复和发布
- [设计决策](docs/DECISIONS.md)：少量需要长期保留的技术选择
- [隐私方针](docs/PRIVACY.md)：禁止提交内容、开发约束与公开发布检查
- [UX 规范](docs/UX.md)：页面模板、视觉、状态反馈与响应式约束
- [发布与兼容性](docs/RELEASES.md)：当前版本、WCG 配对版本与文档更新规则
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
| 仪表盘 | 当前学期学生/班级概览、可解释的关注与警告、独立考勤提醒、教师内部家校沟通观察 |
| 学生档案 | 按学期班级分组/折叠、搜索、学期 active/inactive 名单状态、综合分排序、悬停预览、标签、Excel 名单预览导入和四维平均表现 |
| 手动评分 | 卡片评分、考勤勾选、批量设置、长期历史恢复 |
| 课后工作台 | 统一自然语言/录音/助教 Excel 录入、草案复核、可控风格/长度的单人或批量反馈、换模型版本选择和 Excel 导出 |
| 教学总结 | 按课次或日期汇总确定性教学事实，按需生成教师 AI 解读，并管理可追溯的家校沟通观察 |
| 数据导出 | 6 Sheet Excel：档案/学期班级归属/指标/事件/沟通/考勤，日期范围可恢复 |
| 学期管理 | 学期列表/详情、学期班级创建与编辑、课次创建/删除/排序 |
| 系统中心 | 四套本地配色、LLM 配置、WeCom/FunASR 集成状态、第三方工具入口、数据库备份、操作日志、项目介绍与开源许可 |
| 企微家校 | 阅读第三方工具使用须知后启用；显式扫描 WCG handoff 包及不可变修订、在本机完成提取与 replacement/correction 教师复核，并写回不可变回执 |

## 前端结构

- `src/app/` 只保留路由组合与旧路由重定向。
- `src/features/` 按教学上下文、录入、反馈、评分、报告、学生、课程和系统划分职责。
- `src/components/ui/` 提供轻量设计系统；`src/lib/api-client.ts` 统一 JSON 请求、错误和下载行为。
- 教学上下文使用 `semesterId`、内部 `classId`、兼容班级显示名和 `sessionCode` 查询参数，刷新与工作台跳转后可以恢复。
- 录入、复核、反馈、评分、日报、导出和转写选择会在当前浏览器标签页内自动保留；凭据和未提交的本地文件不会写入恢复存储。
- 课后工作台将录入、复核、生成和导出组成可自由切换且可恢复的五步流程；跨课次草案在工作历史中集中复核。
- 外观提供经典、暮蓝、星云和平衡星云四套配色，默认使用平衡星云；选择只保存在当前浏览器，不写入学生或教学数据。
- `/entry`、`/input`、`/review`、`/report`、`/settings`、`/system-logs` 和 `/past-overview` 在 1.0 前继续作为兼容入口；删除前必须检查书签、工作历史和外部链接。

## 许可证

Copyright © 2026 theodontino。

本项目采用 [GNU Affero General Public License v3.0 only](LICENSE)，SPDX 标识为 `AGPL-3.0-only`。允许使用、修改、分发和商业使用；分发修改版或使用修改版提供网络服务时，必须按同一许可证向相应用户提供完整源代码。学生数据、运行数据库、导出文件和其他用户内容不因本软件许可证而获得公开授权。
