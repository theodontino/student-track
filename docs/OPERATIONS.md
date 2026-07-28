# 运维手册

## 初始化与升级

使用 Node.js 24 LTS 和 npm 11。项目只支持本机运行，开发和生产命令均绑定 `127.0.0.1`。

```bash
npm install
npx prisma migrate deploy
npm run db:seed
npm run dev
```

启动后访问 `http://127.0.0.1:3000`。

## 课后反馈的分析与成稿模型

先在“系统中心 → LLM 配置”保存可用的模型档案，再分别选择“分析模型（副 Agent）”和“成稿与审核模型（主 Agent）”。副 Agent 只整理本次表现、近期趋势和历史联系，主 Agent 读取这份本机内部草稿并重新对照确定性背景，生成可直接发送的家长话术。任一角色留空时跟随当前激活档案，两个角色也可以选择同一档案。

批量反馈会先完成全部内部分析，再逐条成稿和审核，界面分别显示两阶段进度。这会为每条反馈产生两次模型调用，成本与原来的双模型流程相同。“需要人工确认”的条目在教师修改或重新生成前不能导出。

成稿与审核模型只能检查反馈是否忠实于当前上下文，不能发现原始评分、考勤或沟通记录本身错误。如果生成背景不对，应先修正源记录，再重新生成。内部分析与最终输出会保存在当天的 `data/llm-cache/<上海日期>/feedback/` 操作目录中；内部分析不会进入导出的家长反馈。

## 测试隔离

`npm test`、`npm run test:coverage` 和 `npm run test:e2e` 会在系统临时目录中建立独立 SQLite 数据库，自动执行 migrations 并写入固定测试 fixture。运行器会拒绝使用项目 `dev.db`、`archives/` 或 `data/` 中的路径。

E2E 使用独立应用副本、端口、LLM 配置和转写目录，不复用已运行的开发服务，也不连接真实 LLM。

浏览器回归还覆盖响应式导航、系统中心、旧路由重定向、URL 教学上下文、学生学期汇总、AI 工作流和教学总结。1.0 前继续保留旧路由；未来删除前应先检查书签、工作历史和外部链接。

升级前先执行备份，再执行迁移：

```bash
npm run db:backup
npm run db:verify-backup
npx prisma migrate deploy
```

涉及 Schema 变更时，先在当前数据库副本上演练全部迁移，并确认既有业务表行数和 SQLite 完整性不变：

```bash
npm run db:verify-upgrade
```

## 备份

```bash
npm run db:backup
```

备份保存在 `archives/`，包含：

- SQLite 一致性快照 `.db`
- 同名 `.db.json` 清单
- SHA-256 校验和
- SQLite 完整性检查结果
- 核心表行数摘要

仪表盘的“立即备份”按钮执行相同流程，不会清空或重置数据。

## 恢复演练

恢复演练只读取备份，不修改当前数据库：

```bash
npm run db:verify-backup
npm run db:verify-backup -- archives/student-track_<timestamp>.db
```

建议每次重要迁移后至少验证最新备份。

## 恢复数据库

1. 停止开发或生产服务。
2. 执行恢复命令：

```bash
npm run db:restore -- archives/student-track_<timestamp>.db
```

恢复前会自动创建 `pre-restore_*.db`。恢复后的数据库再次通过完整性检查后才视为成功；失败时自动复制恢复前备份回原位置。

3. 重新启动应用并检查关键页面。

## 重置测试数据

重置是破坏性操作，仅保留为明确的 CLI 命令：

```bash
npm run db:backup
npm run db:reset
```

Web 页面不提供数据库重置入口。

## 本地音频转写

Student Track 的录音转写页面调用项目根目录 `diarize.sh`。该入口默认使用外部工具目录 `~/tools/funasr-diarize`，可通过环境变量 `STUDENT_TRACK_DIARIZE_TOOL_DIR` 指向其他位置。

本地转写依赖：

- 外部 FunASR 工具脚本 `diarize.sh`
- 工具目录中的 Python 虚拟环境
- FunASR/SeACo 模型缓存
- 基础热词文件 `hotwords_active.txt`

`auto` 模式保持现有“通义听悟 → 本地 FunASR → 阿里云 ASR”的尝试顺序，因此音频可能上传到云端。需要确保纯本地时，显式选择 `local` 引擎。设置页的“本地工具状态”只执行路径与可执行文件检查，不会自动安装或启动任务。

反馈工作台批量读取文字型出门测 PDF 时依赖 Poppler 的 `pdftotext`。默认从系统 `PATH` 查找；如工具位于非标准目录，可用 `STUDENT_TRACK_PDFTOTEXT_PATH` 指定可执行文件。工作台支持浏览器文件夹选择；浏览器只把本次选中的文件交给 localhost 页面，不会授予长期目录访问权，刷新后如需重新解析应再次选择文件夹。原始 PDF 只通过进程内管道解析，不写入项目目录、数据库或工作历史；扫描件/OCR 暂不支持。

Student Track 调用本地转写时默认使用纯转写模式，不输出说话人标签和时间轴。每个任务会在自己的输出目录生成任务级热词文件，内容包括基础化学热词和当前数据库中的学生姓名；学生名单变化后，下一次转写会自动使用新名单。

录音、上传音频、转写结果和运行日志保存在 `data/diarize/`。该目录是运行数据，已被 Git 忽略；数据库备份不会替代这些音频和中间文件的归档需求。

浏览器现场录音依赖麦克风权限和浏览器 `MediaRecorder` 支持。权限被拒绝或浏览器不支持录音时，仍可上传已有音频文件。

## WCC handoff 与只读花名册

WeComCatch 是仓库外的独立工具。Student Track 不包含其源码，也不读取或启动其
CLI、配置、archive/gui SQLite、编译产物或备份。

推荐的跨应用交接使用本地文件协议。两端默认共享
`~/Library/Application Support/WCC Student Track Exchange`；如需改目录，
在 Student Track `.env` 设置 `STUDENT_TRACK_WCC_EXCHANGE_ROOT`，并在 WCC
设置相同位置的 `WECOMCATCH_ST_EXCHANGE_ROOT`。WCC 发布完成后可以退出，
Student Track 会独立校验 SHA-256、执行学生匹配与业务提取，并把不含正文和姓名的
回执写回共享目录。详细规则见 `docs/WECOM_FILE_HANDOFF.md`。

首次使用时，在“系统中心 → 集成与工具 → 企微家校工作区”阅读第三方工具使用须知并确认，左侧才显示“企微家校”入口。该确认只保存在当前浏览器本机，须知版本变化时需要重新确认；它不代表已经取得聊天参与者、学生或监护人的授权。隐藏入口不会删除数据库账本、缓存或回滚记录。

“企微家校”只保留“中转仓库”和“教师复核”。用户显式扫描后，服务依次校验路径、
大小、Schema、SHA-256、包身份和幂等性；唯一匹配学生后才运行二次提取。证据必须
落在同一上海日、学生当前班级且当天只有一个课次时才自动绑定，否则由教师选择。
教师确认草案后才写正式 `Communication`。

企微提取模型在“系统中心 → LLM 配置 → 模型角色分工”单独指定。兼容性顺序固定为 `json_schema + reasoning_effort:none`、保留 Schema 并去掉不兼容的推理参数、再尝试 `json_object`；不允许降级到普通文本。自动提取使用 `wecom-grounded-v5-feedback-triage`：模型只看到 `M001`、`M002` 等短消息引用，必须返回短引用、事实摘要、反馈用途分类、优先级和 1–3 条原文短句；服务校验后恢复真实消息 ID。结构或证据校验失败只进行一次针对性纠错，仍失败即进入复核。网络错误只重试一次；连续 3 个证据失败，或前 20 批累计 5 个证据失败时暂停剩余批次。

联系人消息先按上海日期变化或超过 6 小时的间隔拆为连续交流段，每段最多 30 条和 8000 字符。单条超过 8000 字符时独立成段；超过 20000 字符时不截断、不自动写库，直接等待人工处理。`finish_reason=length` 的多消息段会二分，单条仍截断时暂停。

历史回执修复必须先点击“只读预检”。缺失包、哈希冲突和非终态记录会跳过；合法
已有回执只补 `receiptId` 关联，缺失回执才按既有终态生成。实际执行要求输入
`REPAIR_HANDOFF_RECEIPTS`，并先创建、校验数据库备份。修复不改变包、状态、结果、
草案或正式沟通记录。

## LLM 本机缓存

企微提取、课堂解析、反馈生成和教学总结的模型调用按一次用户操作写入 `data/llm-cache/<上海日期>/<任务类型>/<操作 ID>/`。操作清单和顺序编号的调用目录会保存请求正文、模型正文、可获得的推理内容、结束原因和 token 用量；不保存 API Key、Authorization、Cookie 或原始异常对象。目录权限为 `0700`，文件权限为 `0600`，写入使用临时文件加原子改名。

某任务类型下一次完整成功后，只保留该次成功缓存并清理该类型更早缓存；失败时保留当天记录。跨日首次运行清除旧日期，总容量默认限制为 256MB，运行中的操作不会被自动或手动删除。“维护与日志 → LLM 本机缓存”只展示任务类型、时间、状态、调用次数和大小，并可在确认后清理非活动缓存；接口不会返回提示词、聊天正文、模型正文或推理内容。

Student Track 不管理或删除 LM Studio 自身日志。LM Studio 的开发日志可能包含提示词和响应，并可能快速占用磁盘；需要在 LM Studio 中关闭不必要的开发日志或按其运维方式定期检查和清理，清理前确认没有仍需排障的记录。

## 发布与封档

正式检查点按以下顺序执行：

```bash
git status --short
npm run db:backup
npm run db:verify-backup
npx prisma migrate status
npm run docs:generate
npm run verify:release
```

`verify:release` 成功时只输出精简摘要，完整日志保存在 `.verification-logs/`；失败时按摘要指向的单个日志排查。也可以推送候选提交并等待同一提交的 CI `quality` 与 `browser` 全部通过，避免重复执行相同的全量验证。

确认页面和只读接口正常后，再提交版本文件、创建带说明的 Git 标签并发布对应 GitHub Release。`package.json`、标签和 Release 使用同一版本号；运行数据和数据库备份不提交 Git。

```bash
git commit -m "Archive vX.Y.Z"
git tag -a vX.Y.Z -m "Student Track vX.Y.Z"
git push origin vX.Y.Z
gh release create vX.Y.Z --verify-tag --generate-notes --title "Student Track vX.Y.Z"
```

封档完成后至少保留：可校验的数据库备份、干净工作区、通过的迁移状态、最新生成文档、发布提交、版本标签和可访问的 GitHub Release。

## 后续接手开发

新任务开始前按顺序阅读 `AGENTS.md`、`docs/DOMAIN.md`、`docs/ARCHITECTURE.md` 和与任务相关的代码。随后执行：

```bash
git status --short
git log -5 --oneline
npm run docs:check
npx prisma migrate status
npm test
```

本地外部依赖需要单独确认：LLM 配置保存在本机运行配置中；音频转写依赖 `~/tools/funasr-diarize`；WCC 交付只依赖共享交换目录。核心学生数据以 `dev.db` 及通过验证的 `archives/` 备份为准。
