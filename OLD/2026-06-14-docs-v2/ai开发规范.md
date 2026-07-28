# AI 开发规范

> **文档定义** — AI 会话唯一入口 + 开发流程标准 | v0.14.0
>
> **此文档包含**: 项目定位、快速启动、技术栈、文件地图、编码规范、文档维护流程、Save 流程、AI 施工流程
> **此文档不包含**: 版本变更记录（→版本记录.md）、功能状态矩阵（→功能状态.md）、架构设计（→系统设计.md）、数据模型（→数据结构.md）、工程进度（→施工文档.md）
> **更新频率**: 技术栈/编码规范/文件结构变化时更新。版本号在每次发布时更新。
>
> 新会话：读完此文档即可开始工作。深入细节按链接跳转专题文档。

---

## 1. 项目定位

**Chem-Track AI**：高中化学教师 Web 智能学生追踪系统。

核心工作流：`NL 输入 → LLM 解析 → LLM 自审 → 教师复核 → 写入数据库`

---

## 2. 快速启动

```bash
cd $HOME/Documents/engineering/档案中心/chem-track-ai

npm install          # 首次
npm run db:seed      # 初始化数据库（首次或重置）
npm run dev          # http://localhost:3000
npm test             # 运行单元测试
```

---

## 3. 技术栈

| 类别 | 技术 | 说明 |
|---|---|---|
| 框架 | Next.js 16 (App Router) | 所有页面 `"use client"` |
| ORM | Prisma 7 + libsql (SQLite) | 客户端导入 `@/lib/prisma` |
| LLM | OpenAI SDK → DeepSeek | `deepseek-v4-flash`，封装在 `lib/parser.ts` |
| 图表 | Recharts 3.8 | 雷达图 + 折线图 |
| Excel | xlsx 0.18 | 导入花名册 + 导出 5 Sheet |
| 测试 | vitest | `npm test` |
| 样式 | Tailwind CSS 4 | `@import "tailwindcss"` |

### .env 配置

```
DATABASE_URL="file:./dev.db"
LLM_API_KEY="<REVOKED_LLM_API_KEY>"
LLM_API_BASE_URL="https://api.deepseek.com"
LLM_MODEL="deepseek-v4-flash"
```

---

## 4. 文件地图

```
chem-track-ai/
├── prisma/
│   ├── schema.prisma              # 14 张表：含 WorkHistory 长期页面快照
│   └── seed.ts                    # 种子数据（含标签初始化）
├── scripts/
│   ├── archive-and-reset.ts       # 归档+重置
│   └── db-maintain.ts             # SQLite 维护
├── src/
│   ├── app/
│   │   ├── layout.tsx             # 根布局（Sidebar + 内容区）
│   │   ├── page.tsx               # / → 仪表盘（概览+预警+快捷流程+班级概览）
│   │   ├── students/              # /students → CRUD（搜索/折叠/评分预览）
│   │   │                         # /students/[id] → 雷达+趋势+事件（分页+加载更多）
│   │   ├── input/page.tsx         # /input → NL 自然语言录入
│   │   ├── review/page.tsx        # /review → 复核中心（状态+班级筛选）
│   │   ├── quick-score/page.tsx   # /quick-score → 快速评分卡片
│   │   ├── feedback/page.tsx      # /feedback → 一键反馈向导（4 步串联）
│   │   ├── export/page.tsx        # /export → 数据导出（5 Sheet）
│   │   ├── report/page.tsx        # /report → 报告生成（日报+反馈+批量 SSE）
│   │   ├── semesters/             # /semesters → 学期列表
│   │   │                         # /semesters/[id] → 学期详情课次表
│   │   ├── system-logs/page.tsx   # /system-logs → 操作日志面板
│   │   └── api/                   # 19 个路由文件
│   ├── components/ (Sidebar, SemesterPicker, ScoreBar, ArchiveButton, WorkHistoryButton)
│   ├── hooks/ (useSemesterContext)
│   ├── lib/ (prisma, llm, prompts, parser, archive, logger, sse, history, nlAttendance, types, constants)
│   ├── tests/
│   │   ├── parser.test.ts         # 18 例纯函数测试
│   │   ├── logger.test.ts         # 3 例集成测试
│   │   └── api/                   # 9 文件 26 例 API 冒烟测试
│   └── generated/prisma/          # 自动生成，勿手动编辑
├── .env.example                   # 环境变量模板
├── vitest.config.ts               # @ alias + DATABASE_URL env
├── .gitignore                     # .env* 排除，!.env.example 例外
├── package.json
└── tsconfig.json
```

---

## 5. 核心业务规则

### 5.1 评分维度

| 维度 | 名称 | 打分方 | 范围 |
|---|---|---|---|
| A | 学习目标达成 & 课堂测验 | 教师 / LLM | 0-5 |
| B | 精神面貌 & 课堂纪律 | 教师 / LLM | 0-5 |
| C | 课后任务 | 教师 / LLM | 0-5 |
| D | 考勤 | 系统自动计算 | 0-5 |

### 5.2 考勤公式

```
D = ROUND(5 × 出勤次数 / 当前学期总课次数)
```

### 5.3 预警规则（v0.10）

**班级预警**（≥5 人）：任一门均分 < 2.5 🔴 / < 3.0 🟡

**学生预警**：综合偏差排名（A+B+C 均值），取后 10% 🔴 + 10-20% 🟡

**D 维度**：缺勤 ≥ 4 🔴 / ≥ 2 🟡

### 5.4 课次编码

`YYYYMMDDNN`，`date` 从 `code.slice(0,8)` 推导。

### 5.5 NL 处理链（3 轮 LLM）

```
教师文本
→ ① correctNamesWithLLM(temp=0.1): LLM 修正同音/形近/缺姓氏
   → 返回 { correctedText, corrections[{ original, corrected, confidence, reason }] }
→ ② parseInput(temp=0.3): 实体识别 + 打分 + 事件提取
   → 支持 ?stream=true SSE 流式输出 token
→ ③ reviewParsed(temp=0.2): 逻辑自审 + 姓名/事件对应检查
   → 输出 name_issues 含 severity 级别
→ 服务端按课次班级补齐花名册：未提及学生 present=false
→ DraftRecord(pending) → 教师复核（前端高亮显示修正项+置信度）
→ 确认 → SessionMetric upsert + Attendance upsert + Event create + Communication create
```

### 5.6 数据写入规则

- **SessionMetric**: `@@unique([studentId, sessionId])`，按 sessionId upsert
- **Event**: 追加模式，必绑 sessionId，v0.10 加 `@@unique([studentId, sessionId, description])`
- **scoreD**: 更新最新 metric，不创建 A/B/C=0 的新行
- **operator**: v0.12 起为 Prisma `enum Operator`（`quickScore`/`nlReview`/`teacher`/`system`），编译期类型约束
- **label**: v0.13 起为 `Label` + `StudentLabel` 关联表，前端传 `labelNames: string[]`，后端 findOrCreate
- **SystemLog**: 追加模式，fire-and-forget 写入，失败不影响主流程 (v0.11)
- **quick-score**: v0.11.1 起只提交与原始状态有差异的学生，避免日志噪音
- **D 维度分母**: v0.11.4 起按学生班级过滤（含全校课次 classId=null），修复多班失真
- **工作历史**: v0.14 起使用 `WorkHistory`；恢复只改页面状态，清理必须由用户主动触发

---

## 6. 编码规范

1. **所有新页面加 `"use client"`** — 项目无 Server Component
2. **Prisma 客户端路径**: `@/lib/prisma`
3. **label 操作**: 前端用 `labelNames: string[]` 传参加，后端 `resolveLabelNames()` findOrCreate
4. **API 错误处理**: `{ error: string }` + HTTP 状态码
5. **LLM JSON 解析**: `parser.ts` 的 `parseJSON()` + `correctNamesWithLLM()` + `correctNames()`
6. **日期格式**: `YYYY-MM-DD`（`new Date().toISOString().split("T")[0]`）
7. **只改与任务直接相关的文件**，不顺手"优化"无关代码
8. **Class 查询**: 必须同时匹配 `name` 和 `code`（`OR: [{ name }, { code }]`）
9. **SSE 流式**: 用 `POST /api/input/parse?stream=true`，前端用 `readSSEStream()` 工具（`lib/sse.ts`）
10. **`?summary=true`**: `GET /api/students?summary=true` 返回最新评分概览
11. **三级选择器**: 使用 `<SemesterPicker>` 组件（`components/SemesterPicker.tsx`），非内联重复
12. **共享常量**: 维度标签 `DIM_LABEL` / `DIM_CONFIG` / `SCORE_COLORS` 从 `lib/constants.ts` 引用
13. **历史快照**: 页面使用 `<WorkHistoryButton>`，保存使用 `saveWorkHistory()`；历史失败不得让已成功业务显示失败
14. **NL 考勤**: 必须选择课次并按对应班级花名册补齐，禁止跨班姓名匹配

---

## 7. 常用命令

```bash
npm run dev              # 开发服务器 → http://localhost:3000
npm test                 # 单元测试 (vitest)
npm run db:seed          # 种子数据
npx prisma migrate deploy # 执行版本化迁移
npm run db:reset         # 清空 + 重新播种
npm run db:archive       # 归档当前数据 + 重置
npx prisma studio        # 数据库 GUI
npx prisma generate      # 重新生成 Prisma Client
npx tsc --noEmit         # 类型检查
```

---

## 8. 文档维护

### 改代码后必须同步的文档

| 文件 | 何时更新 |
|------|---------|
| `功能状态.md` | 完成/新增功能 → 改状态标记 |
| `版本记录.md` | 发布/修 Bug → 新版本号 + 变更项 + 文件清单 |
| `数据结构.md` | Schema 变更 → 更新表结构 / ER 图 / 已知问题 |
| `系统设计.md` | 功能行为变化 → 更新路由表 / API 参考 / 已知限制 |
| `施工文档.md` | 版本推进 → 更新当前/上一/下一版本状态 |
| `ai开发规范.md` | 技术栈/编码规范变化 → 更新对应章节 |

### Save 流程（每次发布后执行）

```
[1] 版本记录.md    — 新增版本条目（版本号+日期+变更摘要+文件清单）
[2] 功能状态.md    — 更新功能点状态标记 + 统计数字
[3] 数据结构.md    — Schema 变更 → 更新表结构 / ER 图 / 已知问题
[4] 系统设计.md    — 页面/API 变更 → 更新计数 / 路由表 / 已知限制
[5] 施工文档.md    — 上一版本归档 → 当前版本状态更新 → 下一版本规划
[6] README.md      — 功能描述变化 → 同步更新
[7] Git commit + tag → [类型] 版本: 摘要
```

> 核心原则：**改了什么代码，就更新什么文档的对应章节**。不做大段重写，只做外科手术式更新。
>
> **大版本全量升级**：每次主版本（x.y.0）发布时，从上到下逐节通读所有文档，确保数字（表数、路由数、测试数）、结构图与代码一致。小版本只需增量更新关联章节。
>
> **文档隔离**：每个文档头部有明确的文档定义，说明包含/不包含的内容。施工文档只保留三版本（上一/当前/下一），功能状态只体现状态，版本记录只存变更日志。

### AI 施工流程

> 新会话：读完 `ai开发规范.md` → 读 `施工文档.md` 了解当前施工安排 → 按需查阅其他文档。

1. **开工前**：读 `施工文档.md` → 确认当前版本待办
2. **施工中**：按需查阅 `系统设计.md` / `数据结构.md` / `功能状态.md`
3. **完成后**：执行 Save 流程 → 更新施工文档 §上一/当前/下一版本
4. **大版本时**：全量升级所有文档的数字和图表

### Commit 格式

```
[类型] 模块: 简短描述

类型: feat / fix / refactor / doc / chore / test

示例:
  [feat] quick-score: 新增评分历史覆盖提示
  [fix] parser: LLM JSON 解析增加 token 截断检测
  [chore] v0.10 审计修复 + 文档同步
  [test] API 冒烟测试覆盖关键路由
```

### 新会话启动清单

```
[ ] 1. 读 施工文档.md — 当前进度 + 待办/废料场/下层候选
[ ] 2. 读 功能状态.md — 确认各功能点完成状态
[ ] 3. 确认 .env 正常（.env.example 参考）
[ ] 4. npx tsc --noEmit — 类型检查
[ ] 5. npm test — 确认全部测试通过
[ ] 6. npm run dev — 验证系统可运行（localhost:3000）
[ ] 7. 按任务需要查阅：
      - 系统设计.md / 数据结构.md — 架构/Schema
      - 版本记录.md — 历史变更
      - 施工文档.md §四 — 前端模块化重构规划
```

---

## 9. 版本文档存档

已实现版本 → `版本记录.md`
未实现/进行中 → `施工文档.md`
旧版本文档 → `OLD/`（按日期分目录）
