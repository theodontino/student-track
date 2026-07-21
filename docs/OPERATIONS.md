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

浏览器回归还覆盖响应式导航、系统中心、旧路由重定向、URL 教学上下文、学生学期汇总、AI 工作流和独立班级日报。1.0 前继续保留旧路由；未来删除前应先检查书签、工作历史和外部链接。

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
npm run db:verify-backup -- archives/chem-track_<timestamp>.db
```

建议每次重要迁移后至少验证最新备份。

## 恢复数据库

1. 停止开发或生产服务。
2. 执行恢复命令：

```bash
npm run db:restore -- archives/chem-track_<timestamp>.db
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

Chem-Track 的录音转写页面调用项目根目录 `diarize.sh`。该入口默认使用外部工具目录 `~/tools/funasr-diarize`，可通过环境变量 `CHEM_TRACK_DIARIZE_TOOL_DIR` 指向其他位置。

本地转写依赖：

- 外部 FunASR 工具脚本 `diarize.sh`
- 工具目录中的 Python 虚拟环境
- FunASR/SeACo 模型缓存
- 基础热词文件 `hotwords_active.txt`

`auto` 模式保持现有“通义听悟 → 本地 FunASR → 阿里云 ASR”的尝试顺序，因此音频可能上传到云端。需要确保纯本地时，显式选择 `local` 引擎。设置页的“本地工具状态”只执行路径与可执行文件检查，不会自动安装或启动任务。

Chem-Track 调用本地转写时默认使用纯转写模式，不输出说话人标签和时间轴。每个任务会在自己的输出目录生成任务级热词文件，内容包括基础化学热词和当前数据库中的学生姓名；学生名单变化后，下一次转写会自动使用新名单。

录音、上传音频、转写结果和运行日志保存在 `data/diarize/`。该目录是运行数据，已被 Git 忽略；数据库备份不会替代这些音频和中间文件的归档需求。

浏览器现场录音依赖麦克风权限和浏览器 `MediaRecorder` 支持。权限被拒绝或浏览器不支持录音时，仍可上传已有音频文件。

## WeComCatch 手动入口

WeComCatch 是仓库外的可选本地工具，Chem-Track 不包含或分发它的源码、运行数据、本地配置、编译产物或备份。使用前必须在 `.env` 中配置 `WECOMCATCH_PROJECT_ROOT` 或 `WECOMCATCH_CLI_PATH`。

`WECOMCATCH_RUNTIME_DIR` 和 `WECOMCATCH_CONFIG_PATH` 可分别指向外部运行目录和本地配置，`WECOMCATCH_BUILD_DIR` 用于单独覆盖编译产物目录。未配置外部工具时，相关状态和同步功能应保持不可用，不影响 Chem-Track 核心功能。

系统中心的“一键同步并导入”会依次执行企微同步、导出、LLM 分段提取和数据库导入，页面按消息回执显示可恢复进度。首次运行默认查看近 30 天；之后由成功水位、短重叠窗口和消息回执决定增量范围。处理期间应保持 Mac 解锁并避免操作企微窗口；同时只能运行一个任务。页面刷新后会重新读取后台状态；可请求安全停止或停止并回滚。运行心跳超过 15 分钟未更新时可恢复为中断任务。

消息回执区分已写入、无有效内容、待复核、失败、明确忽略和已回滚。待复核候选只在保留期内暂存于本地数据库，可从“维护与日志 → 企微导入记录与回滚”重新校验、重新提取、确认忽略或在更换企微提取模型后重试；成功后候选正文立即清空。系统不会把全体学生的历史沟通发送给 LLM，手动入口只发送聊天正文中本地匹配到的学生基本信息，自动入口只发送当前唯一候选学生的必要上下文。

企微提取模型在“系统中心 → LLM 配置 → 模型角色分工”单独指定。兼容性顺序固定为 `json_schema + reasoning_effort:none`、保留 Schema 并去掉不兼容的推理参数、再尝试 `json_object`；不允许降级到普通文本。自动提取使用 `wecom-grounded-v4`：模型必须返回消息 ID、事实摘要和 1–3 条原文短句，短句逐字核验失败即进入复核且不自动重试。网络错误只重试一次；连续 3 个证据失败，或前 20 批累计 5 个证据失败时暂停剩余批次。

联系人消息先按上海日期变化或超过 6 小时的间隔拆为连续交流段，每段最多 30 条和 8000 字符。单条超过 8000 字符时独立成段；超过 20000 字符时不截断、不自动写库，直接等待人工处理。`finish_reason=length` 的多消息段会二分，单条仍截断时暂停。

Web UI 同时保留状态、启动同步、同步状态和导出记录四类手动操作作为故障排查入口。一键流程和手动同步都只会在用户确认后启动；实际使用前还应确认符合企业微信协议、所在组织的数据规则和适用的个人信息保护要求。

手动流程仍可生成候选 JSON 后预览确认。一键流程只自动写入唯一学生、高置信度、原文证据逐字匹配且课次可确定的事实摘要；沟通对象统一写“家长”，沟通时间由支撑消息确定，企微自动导入不创建学生关注标签。任何越界、低置信度、证据或课次问题都会转入待复核。

企微导入回滚可以按一次运行、单个内部批次或上海本地日期执行，也可在活动任务到达安全点后自动回滚。整次回滚会恢复该运行全部消息回执，包括此前标记为“无有效事实”的消息，使新版提示词能够重跑。回滚前会创建并校验 `pre-wecom-rollback_*.db` 安全备份；最多保留最近 3 份。

## LLM 本机缓存

企微提取、课堂解析、反馈生成和班级日报的模型调用按一次用户操作写入 `data/llm-cache/<上海日期>/<任务类型>/<操作 ID>/`。操作清单和顺序编号的调用目录会保存请求正文、模型正文、可获得的推理内容、结束原因和 token 用量；不保存 API Key、Authorization、Cookie 或原始异常对象。目录权限为 `0700`，文件权限为 `0600`，写入使用临时文件加原子改名。

某任务类型下一次完整成功后，只保留该次成功缓存并清理该类型更早缓存；失败时保留当天记录。跨日首次运行清除旧日期，总容量默认限制为 256MB，运行中的操作不会被自动或手动删除。“维护与日志 → LLM 本机缓存”只展示任务类型、时间、状态、调用次数和大小，并可在确认后清理非活动缓存；接口不会返回提示词、聊天正文、模型正文或推理内容。

Chem-Track 不管理或删除 LM Studio 自身日志。LM Studio 的开发日志可能包含提示词和响应，并可能快速占用磁盘；需要在 LM Studio 中关闭不必要的开发日志或按其运维方式定期检查和清理，清理前确认没有仍需排障的记录。

## 发布与封档

正式检查点按以下顺序执行：

```bash
git status --short
npm run db:backup
npm run db:verify-backup
npx prisma migrate status
npm run docs:generate
npm run docs:check
npm test
npm run test:coverage
npm run test:e2e
npx tsc --noEmit
npm run lint
npm run build
```

确认页面和只读接口正常后，再提交版本文件并创建带说明的 Git 标签。`package.json` 与标签使用同一版本号；运行数据和数据库备份不提交 Git。

```bash
git commit -m "Archive vX.Y.Z"
git tag -a vX.Y.Z -m "Chem-Track vX.Y.Z"
```

封档完成后至少保留：可校验的数据库备份、干净工作区、通过的迁移状态、最新生成文档、发布提交和版本标签。

## 后续接手开发

新任务开始前按顺序阅读 `AGENTS.md`、`docs/DOMAIN.md`、`docs/ARCHITECTURE.md` 和与任务相关的代码。随后执行：

```bash
git status --short
git log -5 --oneline
npm run docs:check
npx prisma migrate status
npm test
```

本地外部依赖需要单独确认：LLM 配置保存在本机运行配置中；音频转写依赖 `~/tools/funasr-diarize`；企微同步依赖仓库外 WeComCatch CLI 与显式配置的运行目录。核心学生数据以 `dev.db` 及通过验证的 `archives/` 备份为准。
