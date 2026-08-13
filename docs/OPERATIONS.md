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

运行数据默认继续保存在项目的 `data/` 目录。由其他本机进程启动后端、且工作目录不固定时，可以设置
`STUDENT_TRACK_DATA_ROOT` 作为统一数据根目录；首批覆盖 LLM 设置、LLM 操作缓存和转写任务：

```bash
STUDENT_TRACK_DATA_ROOT="$HOME/Library/Application Support/Student Track/data" npm run start
```

组件专用变量 `LLM_SETTINGS_PATH`、`LLM_CACHE_ROOT` 和 `DIARIZE_DATA_DIR` 的优先级高于统一根目录。
未配置统一根目录时保持原路径；设置变量也不会自动复制或迁移旧文件，切换前应先停止 Student Track，
备份并核对目标目录。数据库、反馈附件和 WCG 交换目录继续使用各自现有配置，不受该变量影响。

## 课后反馈的分析与成稿模型

先在“系统中心 → LLM 配置”保存可用的模型档案，再分别选择“分析模型”和“成稿与审核模型”。
生成页复用这两个全局角色的选择器，企微提取模型仍只在系统中心显示；模型实际使用记录写入
`GenerationRecord`，不增加计划级模型覆盖配置。

生成前可选择“标准生成”或“快速生成”。标准生成依次使用分析模型和成稿与审核模型；快速生成只使用
分析模型，并跳过 LLM 审核润色。两种方式都执行最终程序核验，教师仍需在导出页检查、修改和批准。

反馈计划开始生成后，目标条目先进入 `queued`，后台最多并发处理 2 条。教师可以暂停、继续或
单独重试失败条目；暂停只阻止领取新条目，已在运行的最多 2 条完成后计划进入 `paused`。
页面只轮询 `FeedbackPlan` 详情，不依赖浏览器请求或 SSE 生命周期。刷新、断线后已完成结果仍在
计划中；总耗时、成功条目的平均耗时、生成速度和逐条耗时随计划保存，完成后或从历史恢复仍可查看。
暂停时间不计入总运行耗时。进程重启后，继续/开始操作会把没有活动执行器的 `generating` 条目重新入队。

多班反馈批次在课后工作台顶部管理。创建时每班独立确认课次或阶段范围；如选择共同课，必须明确确认已冻结修订，系统会把材料复制进每个子计划。开始后班级严格串行，当前班失败时先重试该班，成功后才进入下一班。刷新不影响执行；进程重启后点击“恢复执行”即可从持久状态继续。批次暂停只停止领取新条目，当前班已经运行的条目会安全完成。

“导出新增已批准”按学生条目补导，单班已经导出的条目仍可首次进入批次工作簿；“完整批次重导”要求所有条目批准，相同清单必须再次确认。批次导出只生成 Excel，不生成 WCG 草稿包且不发送。

生成失败只保存脱敏错误摘要，并将条目标为 `generation_failed`。已批准或已导出的正文不能原位
覆盖；教师修改后的最终文本是批准和 Excel/WCG 草稿导出的唯一权威。

成稿与审核模型只能检查反馈是否忠实于当前上下文，不能发现原始评分、考勤或沟通记录本身错误。如果生成背景不对，应先修正源记录，再重新生成。内部分析与最终输出会保存在当天的 `data/llm-cache/<上海日期>/feedback/` 操作目录中；内部分析不会进入导出的家长反馈。

## 测试隔离

`npm test`、`npm run test:coverage` 和 `npm run test:e2e` 会在系统临时目录中建立独立 SQLite 数据库，自动执行 migrations 并写入固定测试 fixture。运行器会拒绝使用项目 `dev.db`、`archives/` 或 `data/` 中的路径。

`npm run verify:quick`、`verify:quality`、`verify:browser` 和 `verify:release` 还会在整个验证前后自动比较真实 SQLite 主文件及 `-wal` 文件的 size、mtime 和 SHA-256。真实库原本不存在时，验证结束后也必须保持不存在；任何差异都会使验证失败。`-shm` 是 SQLite 运行期锁与共享内存文件，不作为业务内容指纹。生成指纹期间若仍有业务写入，验证会要求停止写入后重试。

E2E 使用独立应用副本、端口、LLM 配置和转写目录，不复用已运行的开发服务，也不连接真实 LLM。

浏览器回归还覆盖响应式导航、系统中心、反馈五步流程、历史筛选恢复、URL 教学上下文、学生学期
汇总、AI 工作流和教学总结。`/review` 是独立待复核草案入口；旧 `history?view=drafts` 和
`history?view=ai` 只做兼容重定向，不再写入旧历史系统。

## 教学记忆保留

“系统中心 → 维护与日志”提供教学记忆和 AI 生成审计的人工维护入口。选择班级后，“生成到期长期背景草案”只检查来源课次已满六个月的温层记录，并从对应的已确认学期快照读取受控摘要；没有可靠摘要时会安全跳过，不调用模型。生成后的草案必须由教师逐条核对和确认，确认前不会清理温层细节。

热数据转为学期快照后的 7 天内，同一页面会列出可撤销运行。撤销会恢复运行中涉及的完整生成记录；超过期限后回滚载荷自动清理。已确认长期背景仅供教师内部查看，当前不进入家长反馈 prompt、预览、成稿或导出。

升级前先执行备份，再执行迁移：

```bash
npm run db:backup
npm run db:verify-backup
npx prisma migrate deploy
```

FeedbackPlan 统一历史的迁移还必须记录升级前备份路径、`WorkHistory` 行数和备份 SHA-256。
迁移完成后再次检查 SQLite 完整性、外键、`FeedbackPlan` 及其他关键业务表行数；旧
`WorkHistory` 不转换为 FeedbackPlan。真实运行库升级只允许在已验证备份后执行，日常测试使用
隔离临时库或当前库的只读副本。

涉及 Schema 变更时，先在全新数据库、固定合成旧库和当前数据库只读副本上演练全部迁移，并确认既有业务表行数、原字段内容指纹和 SQLite 完整性不变：

1.2 beta.1 的共同课迁移只新增班级组、共同课修订和真实课次关联表，不回填或重新解释既有班级、课次、评价、考勤和反馈计划。升级前后的既有业务表行数与内容指纹必须保持一致。

1.2 beta.2 的批次迁移新增反馈批次、批次导出账本以及 `FeedbackPlan`/`FeedbackExportRun` 的可选关联列。既有单班计划和导出运行保持空关联，不回填批次，不改变原状态或导出资格。迁移演练必须同时验证旧单班计划仍可读取和导出。

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

反馈工作台批量读取文字型出门测 PDF 时依赖 Poppler 的 `pdftotext`。默认从系统 `PATH` 查找；如工具位于非标准目录，可用 `STUDENT_TRACK_PDFTOTEXT_PATH` 指定可执行文件。工作台支持浏览器文件夹选择；浏览器只把本次选中的文件交给 localhost 页面，不会授予长期目录访问权，刷新后如需重新解析应再次选择文件夹。原始 PDF 只通过进程内管道解析，不写入项目目录、数据库或当前标签页恢复存储；扫描件/OCR 暂不支持。

Student Track 调用本地转写时默认使用纯转写模式，不输出说话人标签和时间轴。每个任务会在自己的输出目录生成任务级热词文件，内容包括基础化学热词和当前数据库中的学生姓名；学生名单变化后，下一次转写会自动使用新名单。

录音、上传音频、转写结果和运行日志保存在 `data/diarize/`。该目录是运行数据，已被 Git 忽略；数据库备份不会替代这些音频和中间文件的归档需求。

浏览器现场录音依赖麦克风权限和浏览器 `MediaRecorder` 支持。权限被拒绝或浏览器不支持录音时，仍可上传已有音频文件。

## 反馈计划与附件

课后工作台的反馈计划支持班级公共、事件微反馈、阶段趋势和结课教学总结四类类型。教师在复核页
确认结构化课堂记录、总体反馈要求和对象后创建计划；生成状态、历史恢复和重新生成都以计划和条目
状态为准。每个计划保存版本化课程材料快照；公共课程材料只作为教学背景，不能作为学生个人表现
证据。个人条目保存本课事实、个人测评/练习证据、沟通偏好和最近 5 次 A/B/C/D 评价摘要。
原始 PDF 不落盘。

导出页每张反馈卡先展示程序核验，并按错误位置、影响和处理建议解释告警；随后展示学生档案复用的
历史趋势、本课事实、模型建议、家庭偏好、当日任务摘要和可编辑正文。出门测详情独立折叠，结构、
任务和附件折叠在高级区域。正文约 800ms 防抖自动保存，同时保留手动保存；
没有新修改时按钮显示“已保存”并禁用。已批准或已导出的条目只读，教师最终文本优先于模型原始输出。
默认完整导出会在存在未批准条目时阻断；需要先处理阻断项，或显式选择“仅导出已批准项”。部分导出
会写入 `FeedbackExportRun`，后续补导时以条目 ID 和最终文本哈希提示已导出内容。

教师明确选择“标记发送附件”后，文件复制到 `~/Library/Application Support/Student Track/feedback-attachments/`（可用 `STUDENT_TRACK_FEEDBACK_ATTACHMENTS_ROOT` 覆盖），目录与文件使用私有权限。数据库只保存文件显示名、MIME、大小、SHA-256 和受控相对定位符；当前 Excel 只导出附件清单，不自动发送。原始课堂 PDF 仍按既有规则只作证据，未被标记为附件时不会复制到该目录。

偏好候选必须在学生档案中由教师确认或拒绝；确认会使相关未批准反馈计划条目标记为 stale，历史已批准版本不变。教师任务在仪表盘和反馈计划中更新为 pending、completed 或 cancelled。

## 统一课后任务材料入口（1.2 Beta 3）

教师在默认 `/feedback` 选择课次后，可以把材料拖入页面、选择文件/文件夹，或放入固定收件箱：

```text
~/Library/Application Support/Student Track/feedback-inbox
```

也可以用 `STUDENT_TRACK_FEEDBACK_INBOX_ROOT` 指定本机目录。页面打开时自动扫描一次，按钮可重新扫描；系统不常驻监听、不移动或删除源文件。ZIP 仅支持本次解包的 `.xlsx`、STEP 文本和 PDF；加密、损坏或嵌套 ZIP 会列为异常，解包内容不持久化。临时投入单次上传上限为 100MB，超过时应改用固定收件箱再扫描。

扫描只整理班级、课次、日期和学生身份完全匹配的确定性候选，不写课堂事实。教师在“确认事实”阶段处理日期、身份、考勤冲突、重复 PDF 等异常后，服务用一个事务写入无冲突事实和已选事实；任一步失败全部回滚。确认共同课修订且当前课次已关联时会带入，创建 FeedbackPlan 时复制材料快照。扫描和确认都不会自动批准、导出或发送；需要逐学生微操时进入“高级工作台”。刷新可用 URL 中的 `intakeRunId` 恢复同一轮材料。

## WCG handoff 与只读花名册

WCG（WeComCatch GUI）是仓库外的独立工具。Student Track 不包含其源码，也不读取或启动其
CLI、配置、archive/gui SQLite、编译产物或备份。

推荐的跨应用交接使用本地文件协议。两端默认共享
`~/Library/Application Support/WCC Student Track Exchange`；如需改目录，
在 Student Track `.env` 设置 `STUDENT_TRACK_WCC_EXCHANGE_ROOT`，并在 WCG
设置相同位置的 `WECOMCATCH_ST_EXCHANGE_ROOT`。WCG 发布完成后可以退出，
Student Track 会独立校验 SHA-256、执行学生匹配与业务提取，并把不含正文和姓名的
回执写回共享目录。详细规则见 `docs/WECOM_FILE_HANDOFF.md`。

首次使用时，在“系统中心 → 集成与工具 → 企微家校工作区”阅读第三方工具使用须知并确认，左侧才显示“企微家校”入口。该确认只保存在当前浏览器本机，须知版本变化时需要重新确认；它不代表已经取得聊天参与者、学生或监护人的授权。隐藏入口不会删除数据库账本、已落盘 handoff 包或回执。

“企微家校”只保留“中转仓库”和“教师复核”。用户显式扫描后，服务依次校验路径、
大小、Schema、SHA-256、包身份和幂等性；唯一匹配学生后才运行二次提取。证据必须
落在同一上海日、学生当前班级且当天只有一个课次时才自动绑定，否则由教师选择。
教师确认草案后才写正式 `Communication`。

1.1 的目录响应声明 `handoff-revisions-v1`。修订包缺少 root、parent、草案或正式
沟通时只进入人工谱系处理；不得创建普通沟通。教师确认 correction 前后应核对差异，
拒绝必须保证原沟通完全不变。若需要回滚 Student Track，先停止 WCG 的修订发布。

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

### Zhuiver 产品版本分类

发布前先在版本记录中声明上一版本、本版本和 `PATCH`、`MINOR` 或 `MAJOR`，并说明用户产品
主张、核心工作流、领域模型、部署/数据所有权和协议契约是否变化。该分类遵循协议仓库
`Zhuiver.md`，不改变协议 `contractVersion`，也不替代本节的质量、隐私、迁移和真实使用
门禁。页面、文件和代码量不能单独决定版本级别。

先从 `docs/release-evidence/TEMPLATE.md` 复制记录，再运行：

```bash
npm run release:check-version -- docs/release-evidence/X.Y.Z.md
```

检查器通过只表示版本字段和证据结构完整；正式发布仍必须完成下面的 `verify:release`、
同一提交 CI 或适用的人工边界验收。

正式检查点按以下顺序执行：

```bash
git status --short
npm run db:backup
npm run db:verify-backup
npx prisma migrate status
npm run docs:generate
npm run verify:release
```

`verify:release` 包含完整 Git 历史隐私扫描、数据库升级演练和真实数据库未变化门禁；成功时只输出精简摘要，完整日志保存在 `.verification-logs/`；失败时按摘要指向的单个日志排查。也可以推送候选提交并等待同一提交的 CI `quality` 与 `browser` 全部通过，避免重复执行相同的全量验证。自动化通过后可以立即投入真实使用，不等待固定次数的人工课后流程。

人工冒烟只由变化边界触发：WCG Accessibility、会话定位或草稿填入变化时做一次真实“不发送”验证；破坏性 migration 先创建并验证备份，再检查迁移后的完整性、行数和领域不变量；安装、签名或进程托管变化在干净账户验证。没有变化的边界不重复执行人工流程。

验证通过后提交版本文件、创建带说明的 Git 标签并发布对应 GitHub Release。`package.json`、About 页使用的 `src/lib/product-changelog.ts`、标签和 Release 使用同一版本号；每次发布在 changelog 顶部追加简短的用户可感知变化。运行数据和数据库备份不提交 Git。

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

本地外部依赖需要单独确认：LLM 配置保存在本机运行配置中；音频转写依赖 `~/tools/funasr-diarize`；WCG 交付只依赖共享交换目录。核心学生数据以 `dev.db` 及通过验证的 `archives/` 备份为准。
