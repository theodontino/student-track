# 发布与兼容性

## 当前稳定版本

| 组件 | 版本 | 与另一端的关系 |
|---|---:|---|
| Student Track | 1.1.2 | FeedbackPlan 统一流程保持稳定；增加版本化健康/能力契约、统一错误基线、可重定位数据目录和真实数据库指纹门禁。 |
| WCG（WeComCatch GUI） | 0.4.0 | 发布 `wcc.student-track-file.v1`，只读 receipt v1。 |

两端的业务交付只使用本地 handoff 文件；唯一在线耦合是 WCG 用户显式刷新时调用 ST 的认证只读花名册 API。WCL（WeComCatch Legacy）只保留历史 OpenClaw 能力，不参与当前交付链。协议字段、目录结构、包写入顺序与 receipt v1 不随上述小版本变动。

## 当前联合验证

| 组件 | 版本 | 联合验证范围 |
|---|---:|---|
| Student Track | 1.1.2 | FeedbackPlan 统一反馈流程与历史，数据库队列生成、持久计时、标准/快速生成、暂停恢复、失败重试、课程材料快照、教师最终文本自动保存和历史筛选；handoff v1 保持兼容。 |
| WCG | 0.5.0-beta.5 | handoff 谱系、已批准反馈草稿不发送填入、逐条实时会话定位、前 50→前 150 降级和输入框安全复核。 |

Student Track 的日常和稳定版门禁以自动化为准：普通改动通过 `verify:quick`，高风险与发布改动通过 `verify:release`，随后即可进入真实使用。所有 `verify:*` 命令自动确认真实 SQLite 主文件与 WAL 的 size、mtime、SHA-256 未变化；固定次数的真实课后流程和重复人工合成演练不再阻断发布。

人工冒烟只在相关边界变化时触发：WCG Accessibility、会话定位或草稿填入变化时执行一次真实“不发送”验证；破坏性 migration、安装签名或进程托管按各自风险验证。涉及跨仓协议变化时仍使用精确提交的两端自动化，并固定先发布 Student Track、刷新 `handoff-revisions-v1` 能力目录，再发布 WCG；回滚 Student Track 前停止 WCG 修订发布。

## 发布时的文档检查

每次发布至少同步检查：

- 根 `README.md` 的功能描述与版本；
- `docs/WECOM_FILE_HANDOFF.md` 的兼容版本和协议边界；
- `docs/ARCHITECTURE.md`、`docs/DOMAIN.md`、`docs/OPERATIONS.md` 中的运行链路；
- 由脚本生成的路由和 Schema 文档。

接口、协议或数据迁移发生不兼容变化时，先更新契约和测试，再发布实现；仅小版本功能更新不改动 handoff v1。
