# AI 对接文档

> **给新 AI 会话的快速上手指南**。每次打开新窗口时，AI 应首先阅读此文档。

---

## 1. 一句话定位

**Chem-Track AI**：高中化学教师的 Web 智能学生追踪系统。NL 输入 → LLM 解析 → 人工复核 → 可视化仪表盘 + Excel 导出。

---

## 2. 快速启动

```bash
cd $HOME/Documents/engineering/档案中心/chem-track-ai

# 安装依赖（首次）
npm install

# 初始化数据库 + 种子数据（首次或重置）
npm run db:seed

# 启动开发服务器
npm run dev
# → http://localhost:3000

# 或使用一键启动脚本
cd $HOME/Documents/engineering/档案中心
./start.sh
```

---

## 3. 核心文件地图

### 每次必读（优先级从高到低）

| 文件 | 为什么读 |
|---|---|
| `文档/需求目录.md` | 当前功能完成状态，知道什么做完了、什么没做 |
| `文档/需求文档.md` | 完整功能规格（v0.9: Event/Communication 绑定课次） |
| `文档/数据结构文档.md` | 8 张表的字段、关系、已知问题和优化方案 |
| `文档/版本记录.md` | 历史变更和已修 Bug，避免重复踩坑 |
| `文档/流程.md` | 开发流程规范，知道改什么、不该改什么 |

### 代码文件速查

```
chem-track-ai/
├── prisma/
│   ├── schema.prisma          # 数据模型定义（8 张表，v0.9: SessionMetric/Event/Comm 改名/重构）
│   └── seed.ts                # 种子数据脚本（v0.9: Event/Comm 绑定 sessionId）
├── src/
│   ├── app/
│   │   ├── layout.tsx         # 根布局（Sidebar + 内容区）
│   │   ├── globals.css        # 全局样式（Tailwind）
│   │   ├── page.tsx           # / → 仪表盘
│   │   ├── students/
│   │   │   ├── page.tsx       # /students → 学生列表（CRUD + 导入）
│   │   │   └── [id]/page.tsx  # /students/[id] → 学生详情（雷达图+折线图+事件+考勤）
│   │   ├── input/
│   │   │   └── page.tsx       # /input → NL 自然语言录入
│   │   ├── review/
│   │   │   └── page.tsx       # /review → 复核中心
│   │   ├── quick-score/
│   │   │   └── page.tsx       # /quick-score → 快速评分卡片
│   │   ├── export/
│   │   │   └── page.tsx       # /export → 数据导出
│   │   ├── report/
│   │   │   └── page.tsx       # /report → 报告生成（日报+反馈+批量）
│   │   └── api/               # API 端点，路由结构即 API 路径
│   │       ├── alerts/route.ts        # GET  仪表盘数据+预警
│   │       ├── attendance/route.ts    # GET/PUT  考勤查询+批量更新
│   │       ├── export/route.ts        # POST  Excel 导出
│   │       ├── input/parse/route.ts   # POST  NL 解析（LLM 双阶段）
│   │       ├── quick-score/route.ts   # GET/POST  按课次查询评分考勤 + 批量评分
│   │       ├── review/route.ts        # GET/POST  草案列表+确认/放弃
│   │       ├── report/
│   │       │   ├── daily/route.ts      # POST  班级日报（LLM）
│   │       │   ├── feedback/route.ts   # POST  单人家校反馈（LLM）
│   │       │   └── feedback-batch/route.ts  # GET/POST  批量反馈 SSE 流式 + 缓存下载
│   │       ├── students/
│   │       │   ├── route.ts           # GET/POST  学生列表+创建
│   │       │   ├── [id]/route.ts      # GET/PUT/DELETE  学生详情+更新+删除
│   │       │   └── import/route.ts    # POST  Excel 导入花名册
│   │       └── semesters/
│   │           ├── route.ts           # GET/POST  学期列表+创建
│   │           ├── [id]/route.ts      # PUT/DELETE  学期更新+删除
│   │           └── [id]/session/route.ts  # POST  记录课次
│   ├── components/
│   │   └── Sidebar.tsx        # 侧边栏导航
│   ├── lib/
│   │   ├── prisma.ts          # Prisma 客户端单例
│   │   ├── llm.ts             # LLM 客户端工厂（OpenAI SDK → DeepSeek）
│   │   ├── prompts.ts         # System Prompt + Review Prompt
│   │   └── parser.ts          # LLM 调用 + JSON 解析 + 自审
│   └── generated/prisma/      # Prisma 自动生成（勿手动编辑）
├── .env                       # LLM API Key + 模型配置
├── package.json               # 依赖和脚本
└── tsconfig.json              # TypeScript 配置
```

---

## 4. 技术栈与关键配置

```env
# chem-track-ai/.env
DATABASE_URL="file:./dev.db"
LLM_API_KEY="<REVOKED_LLM_API_KEY>"
LLM_API_BASE_URL="https://api.deepseek.com"
LLM_MODEL="deepseek-v4-flash"
```

| 类别 | 技术 | 重点 |
|---|---|---|
| 框架 | Next.js 16 (App Router) | 所有页面用 `"use client"` |
| ORM | Prisma 7 + libsql (SQLite) | 客户端路径 `@/generated/prisma/client` |
| LLM | OpenAI SDK → DeepSeek | `parser.ts` 封装双阶段调用 |
| 图表 | Recharts 3.8 | 雷达图 + 折线图，在学生详情页 |
| Excel | xlsx 0.18 | 导入花名册 + 导出 5 Sheet |
| 样式 | Tailwind CSS 4 | `globals.css` 中 `@import "tailwindcss"` |

---

## 5. 关键业务规则

### 课次编码体系

每节课通过 `YYYYMMDDNN` 全局唯一编码标识：
```
2026060401  =  2026年6月4日 第1次课
2026060402  =  2026年6月4日 第2次课（同天不同班级）
```
- 编码即 ID，API 用 `/api/sessions/{code}` 而非 `/{id}`
- 同天可多课次（不同班级）
- `date` 字段从 code 推导（`code.slice(0,8)`），冗余方便索引
- 学期内序号 `semesterNumber` 在增删课次后自动重排

### 课次级评分 (v0.4)

`DailyMetric` 唯一约束为 `@@unique([studentId, sessionId])`：
- 快速评分提交时带 `sessionCode` → 按 `sessionId` upsert，每课次独立一行
- NL 输入复核时 `sessionId=null`，同天仅保留一条（findFirst + update/create）
- scoreD 更新到学生最新一条 metric，不创建 A/B/C=0 的新行

> 评分维度、考勤公式、预警规则、NL 处理链等完整业务规则见 **[需求文档 §3](./需求文档.md#3-功能模块)**。

---

## 6. 常见操作速查

```bash
# 归档当前数据 + 重置数据库
npm run db:archive

# 重置数据库（清空 + 重新播种）
npm run db:reset

# 单独运行种子脚本
npm run db:seed

# 查看 Prisma Studio（数据库 GUI）
npx prisma studio

# 数据库迁移（修改 schema 后）
npx prisma migrate dev --name "描述"

# 类型检查
npx tsc --noEmit

# 构建生产版本
npm run build
```

---

## 7. 编码规范

1. **所有新页面组件加 `"use client"`**，当前项目中无 Server Component。
2. **Prisma 客户端导入路径**固定为 `@/generated/prisma/client` 或 `@/lib/prisma`（后者封装了单例和 libsql 适配器）。
3. **labels 字段**在数据库中是 JSON 字符串，API 返回时需要 `JSON.parse()`，写入时需要 `JSON.stringify()`。
4. **API 错误处理**: catch 后统一返回 `{ error: string }` + HTTP 状态码。
5. **LLM JSON 解析**: 使用 `parser.ts` 的 `parseJSON()` 函数，已处理空串、markdown 代码块、finish_reason 截断。
6. **日期格式**: 统一使用 `YYYY-MM-DD` 字符串（`new Date().toISOString().split("T")[0]`）。

---

## 8. 已知问题提醒

> 功能层面限制见 **[需求文档 §4](./需求文档.md#4-已知限制)**；数据模型问题见 **[数据结构文档 §2](./数据结构文档.md#2-表结构详情)**。

---

## 9. AI 工作启动检查清单

新会话开始时，按顺序执行：

```
[ ] 1. 阅读 文档/需求目录.md — 了解当前进度
[ ] 2. 阅读 文档/流程.md — 了解开发流程和文件修改规范
[ ] 3. 阅读 文档/数据结构文档.md — 了解表结构和已知问题
[ ] 4. 根据任务需要查阅 文档/需求文档.md 对应章节
[ ] 5. 确认 .env 配置正常
[ ] 6. 启动 npm run dev 验证系统可运行
[ ] 7. 开始工作
[ ] 8. 按 文档/流程.md §2.3 更新相关文档
```
