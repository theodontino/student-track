# 发布与兼容性

## 当前发布候选

| 组件 | 版本 | 与另一端的关系 |
|---|---:|---|
| Student Track | 1.0.0-beta.3 | 消费 `wcc.student-track-file.v1`，写入 receipt v1。 |
| WCG（WeComCatch GUI） | 0.4.0 | 发布 `wcc.student-track-file.v1`，只读 receipt v1。 |

两端的业务交付只使用本地 handoff 文件；唯一在线耦合是 WCG 用户显式刷新时调用 ST 的认证只读花名册 API。WCL（WeComCatch Legacy）只保留历史 OpenClaw 能力，不参与当前交付链。协议字段、目录结构、包写入顺序与 receipt v1 不随上述小版本变动。

## 发布时的文档检查

每次发布至少同步检查：

- 根 `README.md` 的功能描述与版本；
- `docs/WECOM_FILE_HANDOFF.md` 的兼容版本和协议边界；
- `docs/ARCHITECTURE.md`、`docs/DOMAIN.md`、`docs/OPERATIONS.md` 中的运行链路；
- 由脚本生成的路由和 Schema 文档。

接口、协议或数据迁移发生不兼容变化时，先更新契约和测试，再发布实现；仅小版本功能更新不改动 handoff v1。
