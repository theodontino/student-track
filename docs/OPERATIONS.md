# 运维手册

## 初始化与升级

```bash
npm install
npx prisma migrate deploy
npm run db:seed
npm run dev
```

升级前先执行备份，再执行迁移：

```bash
npm run db:backup
npm run db:verify-backup
npx prisma migrate deploy
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

Chem-Track 调用本地转写时默认使用纯转写模式，不输出说话人标签和时间轴。每个任务会在自己的输出目录生成任务级热词文件，内容包括基础化学热词和当前数据库中的学生姓名；学生名单变化后，下一次转写会自动使用新名单。

录音、上传音频、转写结果和运行日志保存在 `data/diarize/`。该目录是运行数据，已被 Git 忽略；数据库备份不会替代这些音频和中间文件的归档需求。

浏览器现场录音依赖麦克风权限和浏览器 `MediaRecorder` 支持。权限被拒绝或浏览器不支持录音时，仍可上传已有音频文件。

## WeComCatch 手动入口

Chem-Track 通过固定 wrapper 调用本地 WeComCatch：

```bash
$HOME/.openclaw/skills/wecomcatch-archive/scripts/wecomcatch.sh
```

Web UI 只暴露状态、启动同步、同步状态和导出记录四类操作。同步不会自动运行；启动同步前应确认 Mac 已解锁，并理解企微会话切换可能改变未读状态。

企微导出文本可以在系统设置中交给当前 LLM 配置生成 Chem-Track 候选 JSON。候选 JSON 必须先经过预览导入；只有用户确认写入时，才会调用导入服务写入 `Communication`，并在写入前自动备份数据库。

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

本地外部依赖需要单独确认：LLM 配置保存在本机运行配置中；音频转写依赖 `~/tools/funasr-diarize`；企微同步依赖运维手册前述固定 WeComCatch wrapper。核心学生数据以 `dev.db` 及通过验证的 `archives/` 备份为准。
