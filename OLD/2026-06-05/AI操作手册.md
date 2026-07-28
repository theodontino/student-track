# AI 操作手册

> **给 AI 会话的唯一入口文档**。读完这份文档即可开始工作。如需深入细节，可按链接跳转到对应专题文档。

---

## 1. 项目定位

**Chem-Track AI**：高中化学教师的 Web 智能学生追踪系统。

核心工作流：`NL 输入 → LLM 解析 → LLM 自审 → 教师复核 → 写入数据库`

---

## 2. 快速启动

```bash
cd "$HOME/Documents/engineering/archive-center/chem-track-ai"

npm install          # 首次
npm run db:seed      # 初始化数据库（首次或重置）
npm run dev          # http://localhost:3000
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
| 样式 | Tailwind CSS 4 | `@import "tailwindcss"` |

### .env 配置

```
DATABASE_URL="file:./dev.db"
LLM_API_KEY="<REVOKED_LLM_API_KEY>"
LLM_API_BASE_URL="https://api.deepseek.com"
LLM_MODEL="deepseek-v4-flash"
```

---

## 4. 代码文件地图

```
chem-track-ai/
├── prisma/
│   ├── schema.prisma              # 9 张表的数据模型定义
│   └── seed.ts                    # 种子数据
├── src/
│   ├── app/
│   │   ├── layout.tsx             # 根布局（Sidebar + 内容区）
│   │   ├── page.tsx               # / → 仪表盘
│   │   ├── students/
│   │   │   ├── page.tsx           # /students → 学生列表 CRUD
│   │   │   └── [id]/page.tsx      # /students/[id] → 雷达图+折线图+事件
│   │   ├── input/page.tsx         # /input → NL 自然语言录入
│   │   ├── review/page.tsx        # /review → 复核中心
│   │   ├── quick-score/page.tsx   # /quick-score → 快速评分卡片
│   │   ├── export/page.tsx        # /export → 数据导出
│   │   ├── report/page.tsx        # /report → 报告生成
│   │   └── api/                   # API 端点（路由即路径）
│   │       ├── alerts/route.ts
│   │       ├── attendance/route.ts
│   │       ├── export/route.ts
│   │       ├── input/parse/route.ts
│   │       ├── quick-score/route.ts
│   │       ├── review/route.ts
│   │       ├── report/daily/route.ts
│   │       ├── report/feedback/route.ts
│   │       ├── report/feedback-batch/route.ts
│   │       ├── students/route.ts, [id]/route.ts, import/route.ts
│   │       ├── semesters/route.ts, [id]/route.ts, [id]/session/route.ts
│   │       └── system/archive/route.ts
│   ├── components/
│   │   ├── Sidebar.tsx
│   │   └── ArchiveButton.tsx
│   ├── lib/
│   │   ├── prisma.ts              # Prisma 客户端单例
│   │   ├── llm.ts                 # LLM 客户端工厂
│   │   ├── prompts.ts             # System Prompt 模板
│   │   └── parser.ts              # LLM 调用 + JSON 解析 + 自审
│   └── generated/prisma/          # 自动生成，勿手动编辑
├── .env
├── package.json
└── tsconfig.json
```

---

## 5. 核心业务规则

> 完整规格见 **[系统设计](系统设计.md)**。

### 5.1 课次编码体系

每节课通过 `YYYYMMDDNN` 全局唯一编码标识：

```
2026060401 = 2026年6月4日 第1次课
2026060402 = 2026年6月4日 第2次课（同天不同班级）
```

- 编码即 ID，API 用 `/api/sessions/{code}` 而非 `/{id}`
- `date` 从 `code.slice(0,8)` 推导，冗余存库方便索引
- `semesterNumber` 在增删课次后自动重排

### 5.2 四维评分

| 维度 | 名称 | 打分方 | 范围 |
|---|---|---|---|
| A | 学习目标达成 & 课堂测验 | 教师 / LLM | 0-5 |
| B | 精神面貌 & 课堂纪律 | 教师 / LLM | 0-5 |
| C | 课后任务 | 教师 / LLM | 0-5 |
| D | 考勤 | 系统自动计算 | 0-5 |

### 5.3 考勤公式

```
D = ROUND(5 × 出勤次数 / 当前学期总课次数)
```

重算时机：创建课次、考勤变更、删除课次。

### 5.4 预警规则

| 条件 | 等级 |
|---|---|
| 任一维度最新得分 < 2 | 🔴 红色 |
| 任一维度连续 3 次 < 3 分 | 🟡 黄色 |

### 5.5 NL 处理链

```
教师文本 → parseInput(temp=0.3) → reviewParsed(temp=0.2)
→ DraftRecord(pending) → 教师复核确认/修改 → SessionMetric + Event + Communication
```

- LLM 只输出文本中提及的学生，未提维度 score 为 `null`
- D 不由 LLM 打分
- `SessionMetric` 唯一约束 `@@unique([studentId, sessionId])`，同课次覆盖

### 5.6 数据写入规则

- **SessionMetric**: 按 `(studentId, sessionId)` upsert；快速评分带 `sessionCode` 时按 sessionId 精确 upsert；NL 复核（无课次）时 `sessionId=null`，同天仅保留一条
- **Event/Communication**: 追加模式，必绑 `sessionId`，日期从 `ClassSession.date` 获取
- **scoreD**: 更新到学生最新一条 metric，不创建 A/B/C=0 的新行
- **数据版本留存**: 评分更新前旧值自动归档到 `SessionMetricHistory`

---

## 6. 编码规范

1. **所有新页面加 `"use client"`** — 项目无 Server Component
2. **Prisma 客户端路径**: `@/lib/prisma`（封装了单例 + libsql 适配器）
3. **labels 字段**: DB 中为 JSON 字符串，API 返回时 `JSON.parse()`，写入时 `JSON.stringify()`
4. **API 错误处理**: catch 后统一 `{ error: string }` + HTTP 状态码
5. **LLM JSON 解析**: 使用 `parser.ts` 的 `parseJSON()`，已处理空串、markdown 代码块、finish_reason 截断
6. **日期格式**: 统一 `YYYY-MM-DD` 字符串（`new Date().toISOString().split("T")[0]`）
7. **只改与任务直接相关的文件**，不顺手"优化"无关代码

---

## 7. 常用命令

```bash
npm run dev              # 开发服务器 → http://localhost:3000
npm run db:seed          # 种子数据
npm run db:reset         # 清空 + 重新播种
npm run db:archive       # 归档当前数据 + 重置
npx prisma studio        # 数据库 GUI
npx prisma migrate dev --name "描述"   # Schema 变更后迁移
npx tsc --noEmit         # 类型检查
npm run build            # 生产构建
```

---

## 8. AI 工作启动检查清单

新会话开始时：

```
[ ] 1. 阅读 文档/功能状态.md — 了解当前进度
[ ] 2. 阅读 文档/开发流程.md — 了解文档维护和 commit 规范
[ ] 3. 确认 .env 配置正常
[ ] 4. npm run dev 验证系统可运行
[ ] 5. 根据任务需要查阅 系统设计.md / 数据结构.md
[ ] 6. 工作完成后按 开发流程.md §2.3 更新相关文档
```
