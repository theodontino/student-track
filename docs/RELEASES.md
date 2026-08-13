# 发布与兼容性

## 当前稳定版本

| 组件 | 版本 | 与另一端的关系 |
|---|---:|---|
| Student Track | 1.1.4 | 学生/班级双仪表、警告与教师待办优先级、稳定班级身份和学期上下文；保持 FeedbackPlan 与 handoff v1 稳定。 |
| WCG（WeComCatch GUI） | 0.6.0 | 原生 SwiftUI 正式版；发布 `wcc.student-track-file.v1`，只读 receipt v1，并保持不发送边界。 |

两端的业务交付只使用本地 handoff 文件；唯一在线耦合是 WCG 用户显式刷新时调用 ST 的认证只读花名册 API。WCL（WeComCatch Legacy）只保留历史 OpenClaw 能力，不参与当前交付链。协议字段、目录结构、包写入顺序与 receipt v1 不随上述小版本变动。

## 当前联合验证

| 组件 | 版本 | 联合验证范围 |
|---|---:|---|
| Student Track | 1.1.4 | 双仪表导航、任务分组与历史、同名班级排序、窄屏回归，以及既有 FeedbackPlan 统一反馈流程与历史；handoff v1 保持兼容。 |
| WCG | 0.6.0 | handoff 谱系、已批准反馈草稿不发送填入、逐条实时会话定位、前 50→前 150 降级和输入框安全复核；原生 SwiftUI 正式版。 |

## 当前开发 beta

| 组件 | 版本 | 联合验证范围 |
|---|---:|---|
| Student Track | 1.1.5-beta.2 | 在 1.1.5-beta 的基础上修复项目/运行数据目录迁移后的本地转写任务路径兼容性，并继续维护实验性的 STEP 人工桥；按 Zhuiver 归为 PATCH，不改变 handoff v1、receipt v1 或 WCG 发送边界。 |
| WCG（WeComCatch GUI） | 0.6.0 | 与当前稳定版相同；本 beta 不要求 WCG 变更。 |

### STEP Bridge 的发布边界

ST ↔ STEP 当前桥接是 `experimental`，不属于 Student Track 当前稳定产品承诺，也不作为 ST 1.2 的正式协议交付条件。现阶段只保证当前已验证的 ST + STEP 组合，实验文件格式可以随两端数据模型调整，旧实验格式不承诺长期兼容。

正式 `.stsession/.stlesson`、canonical Schema、revision/ledger、compatibility matrix 和联合 conformance 已延期到 STEP 核心课堂模型和真实桥接需求明显稳定后再由 `Protocol-of-sts` 收口。实验 bridge 的当前实现、测试和真实使用结果可以作为未来协议设计输入，但不登记为正式协议兼容证据。

实验期仍保持稳定安全边界：`studentId` 精确匹配、班级和目标课次一致、确定性课堂事实不由 LLM 改写或补分、模型失败不阻断教师复核、坐标和触控 UI 数据不进入 ST、教师确认前不写正式记录。

Student Track 的日常和稳定版门禁以自动化为准：普通改动通过 `verify:quick`，高风险与发布改动通过 `verify:release`，随后即可进入真实使用。所有 `verify:*` 命令自动确认真实 SQLite 主文件与 WAL 的 size、mtime、SHA-256 未变化；固定次数的真实课后流程和重复人工合成演练不再阻断发布。

版本级别遵循协议仓库 `Zhuiver.md`：当前 Student Track `1.1.4` 是 PATCH，表示稳定既有
教学工作台承诺；协议 v1 的版本身份和兼容矩阵独立维护。后续发布必须附带
`docs/release-evidence/` 中的 Zhuiver 记录，并通过 `npm run release:check-version`。

人工冒烟只在相关边界变化时触发：WCG Accessibility、会话定位或草稿填入变化时执行一次真实“不发送”验证；破坏性 migration、安装签名或进程托管按各自风险验证。涉及**已接受的正式跨仓协议**变化时仍使用精确提交的两端自动化；实验 STEP bridge 的当前 adapter 变化不触发正式 compatibility 流程。

## 发布时的文档检查

每次发布至少同步检查：

- 根 `README.md` 的功能描述与版本；
- `docs/WECOM_FILE_HANDOFF.md` 的兼容版本和协议边界；
- `docs/ARCHITECTURE.md`、`docs/DOMAIN.md`、`docs/OPERATIONS.md` 中的运行链路；
- 由脚本生成的路由和 Schema 文档。

接口、已接受协议或数据迁移发生不兼容变化时，先更新契约和测试，再发布实现；仅小版本功能更新不改动 handoff v1。实验性 STEP bridge 在正式协议收口前按当前两端组合维护，不承担长期旧格式兼容义务。
