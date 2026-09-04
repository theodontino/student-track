# 运维手册

## 初始化与升级

使用 Node.js 24 LTS 和 npm 11。项目只支持本机运行，开发和生产命令均绑定 `127.0.0.1`。

```bash
npm install
npx prisma migrate deploy
# 仅用于空白开发库；实际教学数据禁止运行 db:seed
npm run db:seed
npm run dev
```

启动后访问 `http://127.0.0.1:3000`。

### Windows Core 安装与启动

#### 新 Windows 电脑（推荐）

Windows Core 没有 MSI/EXE。给同事安装时，发送 prerelease 附件
`StudentTrackCore-Windows-Installer.zip`；对方解压后双击其中的 `Install-StudentTrackCore.cmd` 即可。
这个双击入口会从当前 beta.2 prerelease 拉取安装器，并把失败信息留在命令窗口中。

它以当前用户身份下载便携版 Node.js 24 x64、beta.2 源码和 npm 依赖，不需要管理员权限，也不修改系统
Node.js。若企业聊天软件不允许直接发送 `.cmd`，发送 zip 附件即可。

也可以手动下载 `Install-StudentTrackCore.ps1` 后，在 PowerShell 中运行：

```powershell
$installer = Join-Path $env:TEMP "Install-StudentTrackCore.ps1"
Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/theodontino/student-track/releases/download/v1.3.0-beta.2/Install-StudentTrackCore.ps1" -OutFile $installer
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer
```

安装器只面向第一次安装：若检测到 `%LOCALAPPDATA%\Student Track\app`，会停止而不覆盖程序或数据。
它会在 `%LOCALAPPDATA%\Student Track\` 下安装程序和便携 Node，并创建桌面上的 **Student Track Core**
启动入口。以后双击该入口即可；服务仍只监听 `http://127.0.0.1:3000`。

#### 已有源码和 Node.js 的安装方式

Windows Core 源码安装仅支持 Windows 10/11 x64、Node.js 24 x64 和 npm 11。克隆仓库后，在
PowerShell 中依次运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\Prepare-StudentTrackCore.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\Start-StudentTrackCore.ps1
```

准备脚本可重复执行：它创建运行目录，执行 `npm ci`、Prisma Client 生成、`migrate deploy` 和 Core
生产构建。数据库不存在时先建立空 SQLite 文件；既有数据库会在迁移前创建并校验备份。脚本不会执行
测试数据 seed，也不会删除数据库、运行数据或已有 LLM 设置。显式配置的 `LLM_SETTINGS_PATH` 仍保持最高
优先级。启动脚本不重复安装或构建，只启动已准备好的生产服务并绑定
`http://127.0.0.1:3000`；PowerShell 窗口需要在使用期间保持运行。

Windows Core 的私有数据统一位于 `%LOCALAPPDATA%\Student Track\`：

- `database\student-track.db`：SQLite 数据库；
- `data\`：LLM 设置与操作缓存等运行数据；
- `feedback-attachments\`：教师明确标记的反馈附件；
- `feedback-inbox\`：教师主动扫描的材料收件箱；
- `archives\`：迁移前和手动创建的数据库备份。

Core 版不包含录音转写（包括本地 FunASR、通义听悟和阿里云 ASR）、企微/WCG、本地集成设置与工具状态。录音转写与企微家校在主导航和移动导航
保留为不可点击的 Full 功能；高级工具和系统配置不提供绕行入口，直达受限页面只显示不可用说明，
受限 API 返回 `404 feature_unavailable`。Windows 脚本不会探测、启动或调用仅供 Full 使用的
FunASR 等转写工具，也不会探测、启动或调用仅供 macOS Full 使用的 WCG。普通学生档案、课堂事实、反馈计划和已确认家校沟通仍可使用。
`pdftotext` 不是安装前置条件；未安装时只会提示暂时不能解析文字型 PDF，不阻断其他工作流。

### 运行目录

未配置运行根目录时，现有 macOS/开发环境继续使用项目 `data/`、`archives/` 和原有私有目录。由其他
本机进程启动后端、且工作目录不固定时，可以设置 `STUDENT_TRACK_RUNTIME_ROOT`；其下使用 `data/`、
`feedback-attachments/`、`feedback-inbox/` 和 `archives/`。也可以只设置 `STUDENT_TRACK_DATA_ROOT`
来重定位 LLM 设置、LLM 操作缓存和转写任务：

```bash
STUDENT_TRACK_RUNTIME_ROOT="$HOME/Library/Application Support/Student Track" npm run start
```

组件专用变量 `LLM_SETTINGS_PATH`、`LLM_CACHE_ROOT` 和 `DIARIZE_DATA_DIR` 的优先级高于统一根目录。
附件、收件箱和备份还可分别用 `STUDENT_TRACK_FEEDBACK_ATTACHMENTS_ROOT`、
`STUDENT_TRACK_FEEDBACK_INBOX_ROOT` 和 `STUDENT_TRACK_ARCHIVES_ROOT` 覆盖。数据库始终由标准
`file:` URL 形式的 `DATABASE_URL` 定位；Windows 脚本会自动生成该 URL。设置变量不会自动复制或
迁移旧文件，切换前应先停止 Student Track、备份并核对目标目录。WCG 交换目录继续使用自身配置。

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

默认课后工作台可创建单班反馈计划，也可在当前课次已关联共同课时创建班级组任务。共同课模式只投料、核对和设置一次，系统仍为每个真实班级课次保存独立材料运行与反馈计划，再由批次统一启动、暂停、恢复和导航。历史批次继续从当前任务或深链接打开、恢复、导出和归档。

“导出新增已批准”按学生条目补导，单班已经导出的条目仍可首次进入批次工作簿；“完整批次重导”要求所有条目批准，相同清单必须再次确认。批次导出只生成 Excel，不生成 WCG 草稿包且不发送。

生成失败只保存脱敏错误摘要，并将条目标为 `generation_failed`。已批准或已导出的正文不能原位
覆盖；教师修改后的最终文本是批准和 Excel/WCG 草稿导出的唯一权威。

成稿与审核模型只能检查反馈是否忠实于当前上下文，不能发现原始评分、考勤或沟通记录本身错误。如果生成背景不对，应先修正源记录，再重新生成。内部分析与最终输出会保存在当天的 `data/llm-cache/<上海日期>/feedback/` 操作目录中；内部分析不会进入导出的家长反馈。

## 测试隔离

`npm test`、`npm run test:coverage` 和 `npm run test:e2e` 会在系统临时目录中建立独立 SQLite 数据库，自动执行 migrations 并写入固定测试 fixture。运行器会拒绝使用项目 `dev.db`、`archives/` 或 `data/` 中的路径。

`npm run verify:quick`、`verify:quality`、`verify:browser` 和 `verify:release` 还会在整个验证前后自动比较真实 SQLite 主文件及 `-wal` 文件的 size、mtime 和 SHA-256。真实库原本不存在时，验证结束后也必须保持不存在；任何差异都会使验证失败。`-shm` 是 SQLite 运行期锁与共享内存文件，不作为业务内容指纹。生成指纹期间若仍有业务写入，验证会要求停止写入后重试。

E2E 使用独立应用副本、端口、LLM 配置和转写目录，不复用已运行的开发服务，也不连接真实 LLM。

需要验证一整个课程反馈周期时，运行：

```bash
npm run test:e2e:course-cycle
```

该命令按现有 migrations 从零建立一次性测试库，写入六讲、两个班级和固定合成学生，启动本机
OpenAI-compatible 固定响应服务，再用 WebKit 跑通班级组日常反馈、阶段趋势、结课总结、暂停恢复、
人工复核、单班与合并导出、no-send 草稿、归档和同材料重建。测试完成后会删除临时数据库、附件
目录和应用副本。它是按需运行的课程周期验收，不加入日常 `verify:quick`，避免重复消耗开发时间。

如果只需要验证教师全程操作页面的日常课后路径，运行：

```bash
npm run test:e2e:teacher-acceptance
```

这条 WebKit 用例不会用测试代码直接调用本仓 API 完成业务动作。教师的投料、异常选择、材料与事实确认、
范围与计划确认、生成、刷新恢复、正文保存、附件、批准、Excel/WCG 草稿下载、归档和历史查看全部通过页面
完成；测试结束前只使用只读请求核验最终快照。

需要在当前本机工作区人工验收课后材料匹配时，先备份并验证数据库，再安装固定合成班级组：

```bash
npm run db:backup
npm run db:verify-backup -- archives/<刚生成的备份>.db
DATABASE_URL=file:./dev.db npx tsx scripts/install-feedback-test-kit.ts
```

该脚本只创建 `test-feedback-kit-` 前缀的测试学期、两个班、六名 ACTIVE 学生、两讲共同课和四个真实课次；重复运行不会重复创建，不会自动投料、写课堂事实或建立反馈计划。测试完成后如需清理，先再次备份，再显式运行 `DATABASE_URL=file:./dev.db npx tsx scripts/remove-feedback-test-kit.ts`。清理脚本只接受固定测试学期 ID 和名称，不自动执行。

浏览器回归还覆盖响应式导航、系统中心、反馈三段流程、历史筛选恢复、URL 教学上下文、学生学期
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

1.2.0 的公共材料迁移只为 `ClassSession` 增加可空的 `commonMaterialSnapshot` 与 `commonMaterialConfirmedAt`。既有课次为空即表示没有独立快照；已关联共同课的反馈仍以共同课修订为准，不回填或改写历史课堂事实和反馈计划。

1.2.10 的命名计划迁移只为 `FeedbackPlan` 和 `FeedbackPlanBatch` 增加可空显示名称与可空来源关系。既有计划和批次保持未命名，页面使用兼容标题；既有状态、快照、正文、批准、导出和 IntakeRun 关联均不回填、不改写。迁移后须验证自关联外键、历史 V1 快照读取和新旧计划并存。

```bash
npm run db:verify-upgrade
```

## 备份

```bash
npm run db:backup
```

开发环境的备份默认保存在项目 `archives/`；配置 `STUDENT_TRACK_RUNTIME_ROOT` 后保存在运行根目录的
`archives/`，Windows Core 则保存在 `%LOCALAPPDATA%\Student Track\archives\`。每份备份包含：

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

反馈工作台批量读取文字型出门测 PDF 时可选依赖 Poppler 的 `pdftotext`。默认从系统 `PATH` 查找；如工具位于非标准目录，可用 `STUDENT_TRACK_PDFTOTEXT_PATH` 指定可执行文件。缺少该工具时页面只提示 PDF 暂不可解析，不影响其他功能。工作台支持浏览器文件夹选择；浏览器只把本次选中的文件交给 localhost 页面，不会授予长期目录访问权，刷新后如需重新解析应再次选择文件夹。原始 PDF 只通过进程内管道解析，不写入项目目录、数据库或当前标签页恢复存储；扫描件/OCR 暂不支持。

Student Track 调用本地转写时默认使用纯转写模式，不输出说话人标签和时间轴。每个任务会在自己的输出目录生成任务级热词文件，内容包括基础化学热词和当前数据库中的学生姓名；学生名单变化后，下一次转写会自动使用新名单。

录音、上传音频、转写结果和运行日志保存在 `data/diarize/`。该目录是运行数据，已被 Git 忽略；数据库备份不会替代这些音频和中间文件的归档需求。

浏览器现场录音依赖麦克风权限和浏览器 `MediaRecorder` 支持。权限被拒绝或浏览器不支持录音时，仍可上传已有音频文件。

## 反馈计划与附件

课后工作台的反馈计划支持班级公共、事件微反馈、阶段趋势和结课教学总结四类类型。教师进入规划后
即创建有名称的可恢复草稿，范围、总体反馈要求和对象约 800ms 自动保存，也可点击保存或按
`Command-S`。开始生成后配置冻结；重新生成不同方案应点击“修正计划”并命名新计划，原计划的正文、
批准和导出保持不变。每个计划保存版本化课程材料、事实与录入来源快照；公共课程材料只作为教学背景，
不能作为学生个人表现证据。个人条目保存本课事实、个人测评/练习证据、沟通偏好和最近 5 次 A/B/C/D 评价摘要。
原始 PDF 不落盘。

导出页每张反馈卡先展示程序核验，并按错误位置、影响和处理建议解释告警；随后展示学生档案复用的
历史趋势、本课事实、模型建议、家庭偏好、当日任务摘要和可编辑正文。出门测详情独立折叠，结构、
任务和附件折叠在高级区域。正文约 800ms 防抖自动保存，同时保留手动保存；
没有新修改时按钮显示“已保存”并禁用。已批准或已导出的条目只读，教师最终文本优先于模型原始输出。
默认完整导出会在存在未批准条目时阻断；需要先处理阻断项，或显式选择“仅导出已批准项”。部分导出
会写入 `FeedbackExportRun`，后续补导时以条目 ID 和最终文本哈希提示已导出内容。

教师明确选择“标记发送附件”后，macOS 默认把文件复制到 `~/Library/Application Support/Student Track/feedback-attachments/`；Windows Core 使用 `%LOCALAPPDATA%\Student Track\feedback-attachments\`。也可用 `STUDENT_TRACK_FEEDBACK_ATTACHMENTS_ROOT` 覆盖。目录与文件使用私有权限。数据库只保存文件显示名、MIME、大小、SHA-256 和受控相对定位符；当前 Excel 只导出附件清单，不自动发送。原始课堂 PDF 仍按既有规则只作证据，未被标记为附件时不会复制到该目录。

偏好候选必须在学生档案中由教师确认或拒绝；确认会使相关未批准反馈计划条目标记为 stale，历史已批准版本不变。教师任务在仪表盘和反馈计划中更新为 pending、completed 或 cancelled。

## 统一课后任务材料入口（1.2 Beta 3）

教师在默认 `/feedback` 选择课次后，可以选择处理“本班”或已关联的“共同课”，再把材料拖入页面、选择文件/文件夹，或放入固定收件箱：

```text
~/Library/Application Support/Student Track/feedback-inbox
```

Windows Core 对应 `%LOCALAPPDATA%\Student Track\feedback-inbox\`。也可以用
`STUDENT_TRACK_FEEDBACK_INBOX_ROOT` 指定本机目录。只有教师点击“扫描收件箱”时才会读取；系统不常驻监听、不移动或删除源文件。ZIP 仅支持本次解包的 `.xlsx`、STEP 文本和 PDF；加密、损坏或嵌套 ZIP 会列为异常，解包内容不持久化。临时投入单次上传上限为 100MB，超过时应改用固定收件箱再扫描。

扫描只整理候选事实，不写课堂事实。单班材料直接进入当前课次；共同课材料先按班级和组内花名册路由，再为每个真实课次形成独立运行。个人 PDF 只有在组内能唯一确定学生及所属真实课次时才自动绑定，否则列为待核对材料。教师在第一页按来源处理日期、课次、身份和确定性冲突，再用“确认材料并进入下一步”一次写入各班事实；部分班级失败时停留第一页并列出失败班级。第二页按“班级组默认、班级例外、学生例外”设置命名计划；计划草稿与启动生成分开，启动失败仍进入工作室重试。第三页使用统一计划工作室，班级组先显示跨班学生清单，学生批准和正文仍归属自己的班级计划。

三步导航在计划执行期间始终可用，当前视图由 `view=intake|plan|studio` 恢复。打开已有计划后，“录入”显示冻结的事实、材料来源、异常处理和确认时间，“规划”显示冻结的范围与配置；它们不是修改事实或回退运行状态的入口。“继续录入事实”建立独立录入，若要采用新增事实，需从录入页明确按当前事实建立新计划。普通“修正计划”则沿用原计划冻结事实。浏览器关闭前若草稿仍有未保存修改会提示。

活动计划工具显示全部未归档 Plan/Batch，并优先展示名称。归档批次会在事务中同时归档子计划；相同 IntakeRun 可以成为多份计划的来源，因此归档不再是创建修订计划的前置条件。1.2.9 的 `/api/feedback/tasks` 创建并立即启动入口只作兼容，新工作台直接使用 Plan/Batch 的创建、草稿保存和启动接口。

## 班级组共同进度（1.2.9，取代 Beta 4 自动规则）

新建或编辑班级组时必须指定成员班中的进度基准班（历史字段名为 `leadClass`）。它只用于形成进度建议，不再触发隐式自动关联。给组内班级新建真实课次时，创建对话框必须先展示班级组、建议讲次和选择原因，教师再明确选择以下一项：

- 按当前建议关联；
- 指定其他可用的共同讲次；
- 建立独立课次。

建议以该班已关联的最高讲次为起点，只向后推进，不回头补第 1 讲等历史缺口。该班尚无共同进度但组已开课、所选日期早于该班最近课次、该班最近一次为独立课次，或其他班尚没有可跟进的下一讲时，系统不代替教师猜测。进度基准班只在教师选择“按当前建议”且没有可用讲次时建立下一讲草稿。

学期详情的班级组管理台按“共同讲次 × 成员班”展示真实课次。表格空格可关联该班已有课次，已关联单元格可解除；下方单独列出组内未关联的真实课次，可手工指定到任一合法讲次。这些纠错只改共同进度关系，不移动评分、考勤或事件。已关联真实课次的讲次不能改序号，但仍可改标题和材料；没有关联、确认修订或反馈引用的误建草稿可删除。

班级离组、换组或更换进度基准班只影响后续建议。打开已有关联的历史课次时，系统以该条 `GroupLessonSession` 还原原班级组；可保持原关联或在同一历史组内调整，不得因当前成员关系而改挂到新组。

反馈页选择组内课次后会显示班级组、进度基准班、讲次和材料确认状态。整理课程材料时会写入当前共同课草稿；本班当前 FeedbackPlan 可使用本次材料快照，同组其他班只有在教师点击确认修订后才读取。既有班级组需补选进度基准班才能得到后续讲次建议，但补选不会自动建课、关联课次或重新解释历史。

## 学期公共材料与主反馈（1.2）

学期详情中的“学期公共材料”是唯一管理入口，并提供 `#semester-common-materials` 稳定锚点。先下载无真实数据的 `.xlsx` 模板；必填列为“课次、群反馈、全对的私反馈、有错误的私反馈”，可选列为“课程主题、统一测评说明、备注”。一个学期只保留一套规范化材料：首次导入直接保存，已有库必须再次确认后整体替换；任一解析错误都会保留旧库。数据库不保存原工作簿、上传路径或文件名。

教师明确建立第 N 讲共同课时，系统自动把材料库第 N 课的主题、群反馈、测评说明、两类私反馈模板及来源复制为草稿，主题作为默认标题；草稿仍须教师确认后才形成共享修订。没有同号材料时保持空白。材料库整体替换不会回写已有共同讲次；需要更新时在讲次上明确选择“重新套用同号材料”，已有内容会要求再次确认。重新套用只改变当前草稿，教师自定义标题、确认修订、真实课次材料和反馈计划快照不变。其他班明确选择已开始的同一 `GroupLesson` 后复用确认材料，不重新录入。独立课次可在三段式反馈第一阶段选择一条材料并明确保存为本课快照。

创建计划时必须明确材料模式：当前共同课确认修订、独立课次快照或不使用。材料只作为课程背景复制进计划快照；后续库更新、共同课草稿修改或课次快照变化不影响既有计划。没有新上传文件时，只要当前课次已有确认课堂事实或明确公共材料，仍可以继续创建计划。

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

## 回收站与事实清理

班级和学期删除后保留 30 天。`predev`、`prestart` 及学期管理页会幂等调用到期清理；没有到期范围时不创建备份。存在到期范围时，系统先使用现有数据库备份服务建立并校验一份快照，任何备份或校验失败都会保留回收站数据，等待下次重试。恢复学期只恢复学期自身；此前单独删除的班级需要再次恢复。

清空课次事实与回收站永久清除都是破坏性操作，但入口行为不同：前者保留课次、沟通、材料、共同课和所有计划结果，并为当前评价追加 `clear` 历史；后者在恢复期结束后删除整个学术范围及受影响的完整多班计划。两个操作都必须先成功创建并校验备份。运行中计划在范围进入回收站前先转为安全暂停请求。

升级到 1.3.0-beta.1 后运行 `npx prisma migrate deploy`。迁移只增加 `Semester.deletedAt`、`Class.deletedAt` 和 `DraftRecord.intakeRunId`；旧数据默认仍可用，历史录入草案继续通过 `feedback-intake:<runId>` 识别，新草案直接记录 `intakeRunId`。

1.3.0-beta.2 不新增 Schema 或 migration，Core 与 Full 共用上述数据库。升级仍执行 `npx prisma migrate deploy` 以确认数据库已追平；Windows 准备脚本会在既有数据库迁移前自动创建并校验备份。

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
