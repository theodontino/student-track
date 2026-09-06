# 发布与兼容性

本文件只维护**当前产品版本的跨组件兼容关系和发布边界**。产品版本唯一来源是根 `package.json`；版本历史、Zhuiver 分类理由和每次验证证据保存在 `docs/release-evidence/`、Git tag 与 GitHub Release 中，不在这里重复维护一份时间线。

## 当前发布基线

| 组件 | 版本 | 当前关系 |
|---|---:|---|
| Student Track | 1.3.0-beta.5 | Core / Full 共用同一业务数据与 Prisma Schema；当前预发布补齐 STEP V1/V2、大批量文件夹与文字型出门测导入，以一位小数 A 分和模块化教师冲突确认沉淀课堂事实。 |
| WCG（WeComCatch GUI） | 0.6.0 | 当前正式 WCG；与 ST 通过 `protocol-st-wcg` 管理的 handoff、receipt、已批准草稿包和只读花名册目录契约协作，并保持 no-send 边界。 |

Student Track 与 WCG 的业务交付以本地文件为主；唯一在线耦合是 WCG 用户显式刷新时调用 ST 的认证只读花名册 API。WCL（WeComCatch Legacy）只保留历史 OpenClaw 能力，不参与当前交付链。

跨仓字段、目录、哈希、错误码、capability、授权、no-send 与兼容矩阵的 canonical 来源是 `theodontino/protocol-st-wcg`。本仓 `docs/contracts/` 只保存同步快照，`WECOM_FILE_HANDOFF.md` 只说明 Student Track 适配行为。

## 当前联合验证边界

- **Student Track Core**：继续阻断全部录音转写与企微/WCG Full 集成；不得因为构建在 Windows 上而意外开放 Full 能力。
- **Student Track Full**：保持 WCG handoff、教师批准和 no-send 草稿边界；受限 Writer 只读取服务端披露输入，legacy 历史计划只读其生成记录且不再继续调用模型。
- **离线交付**：Windows Core 与 macOS Full 安装包不携带教学数据；卸载保留数据库和运行目录。macOS ZIP 在签名与公证完成前不称为 `.app` 正式安装包。
- **WCG**：联合验证聚焦 handoff 谱系、已批准反馈草稿不发送填入、会话定位、输入框安全复核和协议兼容性；WCG 自身 SwiftUI / FastAPI / Accessibility 内部接口不属于 ST 协议快照。

当前 Student Track 版本的完整发布证据必须存在于 `docs/release-evidence/<package version>.md`，并通过发布记录检查器；本文件不复制 CI job 数量、运行 URL 或一次性验收状态。

## STEP Bridge 的发布边界

ST ↔ STEP 当前桥接是 `experimental`，不属于 Student Track 当前稳定产品承诺，也不作为正式协议交付条件。现阶段只保证当前已验证的 ST + STEP 组合；实验文件格式可以随两端数据模型调整，旧实验格式不承诺长期兼容。

正式 `.stsession/.stlesson`、canonical Schema、revision/ledger、compatibility matrix 和联合 conformance 只有在 STEP 核心课堂模型与真实桥接需求稳定后，才由 `Protocol-of-sts` 重新建立 RFC。已长期延期的历史提案不作为当前实现蓝图。

实验期仍保持稳定安全边界：`studentId` 精确匹配、班级和目标课次一致、确定性课堂事实不由 LLM 改写或补分、模型失败不阻断教师复核、坐标和触控 UI 数据不进入 ST、教师确认前不写正式记录。

## 发布门禁

Student Track 的验证按影响范围分为 L0–L3。发布候选按 L3 运行当前实际支持的完整矩阵；所有 `verify:*` 命令自动确认真实 SQLite 主文件与 WAL 的 size、mtime、SHA-256 未变化。

CI 分别记录当前候选 `HEAD_SHA` 与最近完成产品验证的 `PRODUCT_VERIFIED_SHA`。只有后续累计改动严格属于 L0 且当前文档 gate 通过时，才允许继承产品证据；版本、产品、构建、平台、数据库或协议输入变化时必须重新完成对应验证。

人工冒烟只由相关边界变化触发，例如 WCG Accessibility/草稿填入、破坏性 migration、安装签名或进程托管。已经通过且输入未变化的范围不重复验收。

## 发布时的文档检查

每次发布至少确认：

- 根 `README.md` 展示的当前版本与 `package.json` 一致；
- 本文件的 Student Track 当前版本与 `package.json` 一致；
- `docs/release-evidence/<version>.md` 存在并记录该版本的 Zhuiver 与验证证据；
- `docs/WECOM_FILE_HANDOFF.md` 只描述 ST 适配行为，不重新声明协议或产品配对版本；
- `docs/ARCHITECTURE.md`、`docs/DOMAIN.md`、`docs/OPERATIONS.md` 仍与当前运行链路一致；
- 自动生成的路由和 Schema 文档没有漂移。

接口、已接受协议或数据迁移发生不兼容变化时，先更新 canonical 契约和测试，再发布实现。
