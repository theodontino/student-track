# WCC → Student Track 本地转交文件协议 v1

本协议自 WeComCatch v0.2.0 与 Student Track v0.21.1 起正式运行。WCC
负责发布完成包，Student Track 负责扫描、校验、业务提取并写回安全回执。
旧本机 API 保留为兼容回退，不再是默认交接方式。

## 目录与所有权

默认根目录为 `~/Library/Application Support/WCC Student Track Exchange`，
两端可分别通过 `WECOMCATCH_ST_EXCHANGE_ROOT` 和
`STUDENT_TRACK_WCC_EXCHANGE_ROOT` 指向同一绝对路径：

```text
<exchange-root>/v1/packages/<source-id>/<package-id>.json
<exchange-root>/v1/packages/<source-id>/<package-id>.sha256
<exchange-root>/v1/receipts/<source-id>/<package-id>/<receipt-id>.json
```

- WCC 只创建 `packages`；ST 只创建不可变 `receipts`。
- ST 不移动、覆盖或删除 WCC 包。
- 两端不得把交换目录纳入 Git。

## 写入与完整性

1. WCC 在同一目录写入隐藏临时 JSON，刷新文件后原子重命名为 `.json`。
2. 对最终 JSON 原始字节计算小写 SHA-256。
3. 最后原子写入只包含 `64 位哈希 + 换行` 的 `.sha256`。
4. `.sha256` 是包已完成的唯一标志；消费者忽略临时文件和孤立 JSON。

幂等键为 `source.id + packageId + 文件 SHA-256`。相同包和哈希是安全重复；
相同 `packageId` 但哈希不同是 `package_conflict`，不得猜测或覆盖。

## 数据边界

Package 只包含 WCC 已完成基础清洗的标准化消息片段和来源审计字段，不包含
Student Track 学生 ID、课次、评分、标签或正式沟通记录，也不得包含凭据、
绝对路径、数据库位置和模型原始响应。学生匹配、业务筛选、二次提取、课次
绑定和教师复核均属于后续 Student Track 消费端职责。

Receipt 只包含包标识、文件哈希、消费版本、结果和白名单错误码。不得写入聊天
正文、姓名、异常堆栈或模型输出。失败后通过新增回执表达新尝试，不覆盖旧回执。

## 契约文件

- `docs/contracts/wcc-student-track-file-v1.schema.json`
- `docs/contracts/student-track-receipt-v1.schema.json`
- `docs/contracts/examples/`

未知主版本、超过 80 条消息、重复消息 ID、非法时间、文件哈希不一致和 Schema
外字段必须安全拒绝。

## 当前操作流程

1. WCC 完成花名册门控和 LLM 筛选，在“中转仓库”点击“发布待转交项目”。
2. Student Track 在“企微家校 → 中转仓库”点击“扫描并接收新包”。
3. 唯一姓名匹配的包进入 ST 二次提取；无法唯一匹配的包停在人工匹配区。
4. 模型或服务暂时不可用的包可重试；无价值或明确放弃的包可丢弃。
5. ST 待复核候选仍需选择实际课次并由教师确认，才写入正式家校沟通。

WCC 关闭不影响第 2～5 步。任何一端都不会删除 WCC 原始归档。
