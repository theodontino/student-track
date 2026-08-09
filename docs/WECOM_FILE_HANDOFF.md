# WCG → Student Track 本地转交文件协议 v1

本协议稳定配对由 WCG（WeComCatch GUI）v0.4.0 与 Student Track v1.1.3 共同维护；Student Track 1.1.1 起与 WCG 0.5 beta 在完全保留 v1 字段、目录结构和原子写顺序的前提下增加不可变修订、反馈证据覆盖与不发送草稿填入。WCG
负责发布完成包，Student Track 负责扫描、校验、业务提取并写回安全回执。
旧候选 HTTP、CLI 和手工 JSON 集成已移除；业务交接只有本文件协议。

## 目录与所有权

默认根目录为 `~/Library/Application Support/WCC Student Track Exchange`，
两端可分别通过 `WECOMCATCH_ST_EXCHANGE_ROOT` 和
`STUDENT_TRACK_WCC_EXCHANGE_ROOT` 指向同一绝对路径：

```text
<exchange-root>/v1/packages/<source-id>/<package-id>.json
<exchange-root>/v1/packages/<source-id>/<package-id>.sha256
<exchange-root>/v1/receipts/<source-id>/<package-id>/<receipt-id>.json
```

- WCG 只创建 `packages`；ST 只创建不可变 `receipts`。
- ST 不移动、覆盖或删除 WCG 包。
- 两端不得把交换目录纳入 Git。

## 不可变修订

修订包仍是 handoff v1，ID 只在原包 ID 后追加 `.r2`、`.r3`。WCG 使用
`handoff-evidence-v1` 对规范化消息证据、会话、时间范围和分类计算指纹；生成时间、
生产者版本和包 ID 不参与指纹。已发布包和 receipt 永不覆盖或删除。

WCG 首次升级只为既有已发布包建立谱系基线。后续证据变化形成一个待确认候选；
候选再次变化时更新候选并要求重新确认，发布前指纹变化则拒绝。只有 Student Track
最近 24 小时目录快照声明 `handoff-revisions-v1` 时，WCG 才允许显式发布修订。

Student Track 按 root/parent/revision 解析谱系：待处理草案被 replacement 取代，
已拒绝草案得到关联 replacement，已确认沟通得到 correction。correction 只有在教师
确认事务中才保存 `CommunicationRevision` 并更新原沟通；拒绝或谱系不完整时原沟通
完全不变。`sourceKey` 始终保持原始沟通身份。

## 写入与完整性

1. WCG 在同一目录写入隐藏临时 JSON，刷新文件后原子重命名为 `.json`。
2. 对最终 JSON 原始字节计算小写 SHA-256。
3. 最后原子写入只包含 `64 位哈希 + 换行` 的 `.sha256`。
4. `.sha256` 是包已完成的唯一标志；消费者忽略临时文件和孤立 JSON。

幂等键为 `source.id + packageId + 文件 SHA-256`。相同包和哈希是安全重复；
相同 `packageId` 但哈希不同是 `package_conflict`，不得猜测或覆盖。

## 数据边界

Package 只包含 WCG 已完成基础清洗的标准化消息片段和来源审计字段，不包含
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

1. WCG 完成花名册门控和 LLM 筛选，在"中转仓库"点击"发布待转交项目"。
2. Student Track 在"企微家校 → 中转仓库"点击"扫描并接收新包"。
3. 唯一姓名匹配的包进入 ST 二次提取；无法唯一匹配的包停在人工匹配区。
4. 模型或服务暂时不可用的包可重试；无价值或明确放弃的包可丢弃。
5. ST 待复核候选仍需选择实际课次并由教师确认，才写入正式家校沟通。

WCG 关闭不影响第 2～5 步。任何一端都不会删除 WCG 原始归档。

## 课次绑定规则

ST 不允许 LLM 猜测课次。只有证据消息能够确定唯一课次时才自动绑定；其余候选
必须由教师在复核面板选择实际课次。具体规则：

1. **自动绑定：同日且唯一**
   - 按 `Asia/Shanghai` 将这条候选实际引用的证据消息归一为日期范围。
   - 仅当范围只有一天、学生当前班级在当天恰好一节课时，
     才写入 `sessionCode`。
   - LLM 仅负责学生匹配和事实摘要，不参与课次选择。
2. **一日多次课（少数情况）**
   - LLM 提取后该班的 `sessionCode` 仍可为空（同日多课或跨日消息），候选
     留在"中转仓库"列表里集中展示，由教师在下拉中手动挑选。
   - 不在协议层强约束"必须唯一一节"，以兼容现实里同日加课/补课场景。
   - 中转仓库面板为缺课次项提供"按 `occurredAt.min` 选最近一节"快捷按钮
     （`pickNearestWithinDistance`，30 天内），写入 `sessionOverrides` 后
     仍可手动下拉覆盖。
3. **找不到唯一课次时**
   - 候选仍会保留为待复核，不自动拒绝。教师可在面板下拉中选择，或主动使用
     "按日期选最近一节"的快捷建议；快捷建议不自动写入。
4. **课次信息标签（如每节课讲什么）**
   - 当前不实现，标记为可删占位；不进入 `ClassSession` 的契约字段，LLM 也
     不扫描课次详情作为上下文。
5. **跨日匹配（如分多天连续讨论同一学生）**
   - 当前不实现，列为待实现项。决策点：用最早一节 / 最晚一节 / 中位数 / 全部
     候选都建 draft，尚未定稿。引入前必须先和教师确认业务规则再改协议。

新建课次时（`SessionDialog`）要求教师手动填日期；若选中的日期该班级已有
课次，仅给非阻断提示（"本班当天已有 N 节课，仍将创建"），不强制单对单硬
绑定。

## 历史回执修复

`GET /api/wecom/handoff/receipt-repair` 只读校验缺少 `receiptId` 的历史台账：
包、marker、SHA-256 和终态均合法才列为可修复。已有合法回执只补关联；没有合法
回执才按既有终态创建新回执。缺包、冲突和非终态记录跳过。

实际执行 `POST` 前必须先查看预检结果，并提交确认文本
`REPAIR_HANDOFF_RECEIPTS`。服务会先创建和验证 `pre-handoff-receipt-repair`
数据库备份。数据库写入仅限原台账行的 `receiptId`，不修改状态、结果、草案、
正式沟通或包文件。
