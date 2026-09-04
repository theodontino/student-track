# WCG → Student Track 本地转交：ST 适配说明

WCG 与 Student Track 的跨仓协议由 `theodontino/protocol-st-wcg` 维护；本文件只说明 Student Track 如何消费该协议以及教师在 ST 内看到的行为，不重新定义字段、协议版本、哈希规则、目录结构或产品配对版本。

当前同步到本仓的 Schema 与合成示例见 [`contracts/`](contracts/README.md)。任何跨仓可观察行为变化都应先在协议仓库完成治理和 snapshot sync，再修改 Student Track 适配器。

## Student Track 的职责

Student Track 只消费 WCG 已完成发布的本地 handoff 包，并保持以下稳定边界：

- 只接受协议快照允许的完成包；不猜测未知字段、未知主版本或不完整文件。
- 不移动、覆盖或删除 WCG 已发布包，也不依赖 WCG 进程持续运行。
- 学生身份、学期归属、课次绑定和正式业务写入由 ST 自己确定；LLM 只产生候选事实，不能直接写正式沟通。
- 包身份、哈希、Schema、证据和业务范围任一校验失败时，不产生正式沟通。
- 处理结果通过不可变 receipt 表达；receipt 不写聊天正文、姓名、异常堆栈或模型原始输出。
- replacement / correction 等修订语义只在教师确认事务中影响正式沟通；拒绝或谱系不完整时原沟通保持不变。

本地交换目录的默认位置、环境变量与启动排障见 [`OPERATIONS.md`](OPERATIONS.md)。协议层的目录布局、原子写顺序、SHA-256、幂等身份、错误码和 capability 以 `protocol-st-wcg` 为准。

## 教师操作流程

1. 在 WCG 中完成花名册门控与筛选，并显式发布待转交项目。
2. 在 Student Track 的“企微家校 → 中转仓库”中扫描并接收新包。
3. 能唯一匹配到当前业务范围的候选进入 ST 二次提取；无法唯一匹配的候选停在人工处理区。
4. 模型或服务暂时不可用时可以重试；无价值或明确放弃的候选可以丢弃。
5. 待复核候选必须绑定实际课次并由教师确认，之后才写入正式家校沟通。

WCG 关闭不影响 Student Track 已接收包的后续处理。任何一端都不会因为 ST 消费成功而删除 WCG 原始归档。

## 课次绑定规则

ST 不允许 LLM 猜测课次。只有证据能够确定唯一课次时才自动绑定；其余情况由教师显式选择。

1. **同日且唯一时自动绑定**
   - 按 `Asia/Shanghai` 将候选实际引用的证据消息归一为日期范围。
   - 仅当范围只有一天，且学生当前班级当天恰好一节课时，才写入 `sessionCode`。
   - LLM 可参与学生匹配和事实摘要，但不参与课次选择。
2. **同日多课或证据跨日时保持未绑定**
   - 候选继续留在中转仓库，由教师通过下拉选择实际课次。
   - “按 `occurredAt.min` 选最近一节”只提供快捷建议；建议不能自动替代教师确认。
3. **找不到唯一课次时不自动拒绝**
   - 候选保持待复核，教师可以手动选择或主动采用快捷建议。
4. **不得为匹配方便补造课次信息**
   - LLM 不扫描或虚构课次详情来完成绑定。
   - 新建课次仍由教师显式填写日期；同班同日已有课次时只提示，不强制一日一课。

## 不可变修订在 ST 中的效果

协议中的修订谱系由 WCG 发布并由 ST 校验。Student Track 的产品侧处理原则是：

- 尚未确认的旧候选可以被合法 replacement 取代；
- 已拒绝候选可以保留与 replacement 的关联；
- 已确认沟通只有在合法 correction 经教师确认后才保存 `CommunicationRevision` 并更新正式沟通；
- 谱系冲突、证据不完整或教师拒绝 correction 时，既有正式沟通完全不变；
- `sourceKey` 始终保持原始沟通身份。

修订编号、指纹算法、发布前检查与 capability 约束属于协议规范，不在本文件复制。

## 历史回执修复

`GET /api/wecom/handoff/receipt-repair` 只读检查缺少 `receiptId` 的历史台账。只有包、完成标志、SHA-256 和既有终态都合法时才列为可修复：已有合法回执只补关联；没有合法回执才按既有终态创建新回执；缺包、冲突和非终态记录保持不变。

执行 `POST` 前必须先查看预检结果，并提交确认文本 `REPAIR_HANDOFF_RECEIPTS`。服务会先创建并验证 `pre-handoff-receipt-repair` 数据库备份。允许的数据库写入仅限原台账行的 `receiptId`，不得修改状态、结果、草案、正式沟通或包文件。

## 验证入口

- 本仓快照说明：[`contracts/README.md`](contracts/README.md)
- Student Track 运维与交换目录：[`OPERATIONS.md`](OPERATIONS.md)
- 长期设计边界：[`DECISIONS.md`](DECISIONS.md)
- 当前产品与 WCG 的发布兼容关系：[`RELEASES.md`](RELEASES.md)
- 跨仓 canonical、版本与联合 conformance：`theodontino/protocol-st-wcg`
