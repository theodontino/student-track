# WCC → Student Track 本地转交文件协议 v1

本协议只冻结文件边界。Student Track v0.21.0 不扫描交换目录，WeComCatch
也不会在本版本中被修改。当前本机 API 继续作为唯一运行中的交接方式。

## 目录与所有权

未来默认根目录位于 macOS 的中立 Application Support 目录，可由两端配置：

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
