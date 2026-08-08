# 发布与兼容性

## 当前稳定版本

| 组件 | 版本 | 与另一端的关系 |
|---|---:|---|
| Student Track | 1.1.1 | FeedbackPlan 统一反馈流程与历史；继续消费 `wcc.student-track-file.v1`，写入 receipt v1。 |
| WCG（WeComCatch GUI） | 0.4.0 | 发布 `wcc.student-track-file.v1`，只读 receipt v1。 |

两端的业务交付只使用本地 handoff 文件；唯一在线耦合是 WCG 用户显式刷新时调用 ST 的认证只读花名册 API。WCL（WeComCatch Legacy）只保留历史 OpenClaw 能力，不参与当前交付链。协议字段、目录结构、包写入顺序与 receipt v1 不随上述小版本变动。

## 当前联合验证

| 组件 | 版本 | 联合验证范围 |
|---|---:|---|
| Student Track | 1.1.1 | FeedbackPlan 统一反馈流程与历史，数据库队列生成、持久计时、标准/快速生成、暂停恢复、失败重试、课程材料快照、教师最终文本自动保存和历史筛选；handoff v1 保持兼容。 |
| WCG | 0.5.0-beta.5 | handoff 谱系、已批准反馈草稿不发送填入、逐条实时会话定位、前 50→前 150 降级和输入框安全复核。 |

beta 转稳定版前必须完成三次真实课后反馈流程和一次隔离合成修订演练，且精确提交的双仓库 CI 全绿；测试前后的真实数据库 size、mtime 和 SHA-256 必须不变。发布顺序固定为先 Student Track、刷新 `handoff-revisions-v1` 能力目录，再发布 WCG。回滚 Student Track 前必须停止 WCG 修订发布。

## 发布时的文档检查

每次发布至少同步检查：

- 根 `README.md` 的功能描述与版本；
- `docs/WECOM_FILE_HANDOFF.md` 的兼容版本和协议边界；
- `docs/ARCHITECTURE.md`、`docs/DOMAIN.md`、`docs/OPERATIONS.md` 中的运行链路；
- 由脚本生成的路由和 Schema 文档。

接口、协议或数据迁移发生不兼容变化时，先更新契约和测试，再发布实现；仅小版本功能更新不改动 handoff v1。
