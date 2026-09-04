# 跨仓库协议快照

Student Track 与 WCG 的跨仓库协议由独立的 `theodontino/protocol-st-wcg` 仓库统一维护。该仓库是协议文档、版本规则、Schema、合成示例、测试向量、快照清单和兼容矩阵的唯一规范来源。

本目录中的文件是 canonical 协议的生成快照，不是 Student Track 自己维护的第二套规范：

- `wcc-student-track-file-v1.schema.json`
- `student-track-receipt-v1.schema.json`
- `student-track-wecom-draft-package-v1.schema.json`
- 对应 `examples/` 合成示例

## 修改边界

任何改变跨仓字段、枚举、路径、文件名、原子写顺序、SHA-256、幂等身份、错误码、目录 API、capability、授权、数据所有权、no-send 或联合发布顺序的 Feature，必须先在 `protocol-st-wcg` 建立并接受 Issue/RFC。

协议发布后，从协议仓库执行 snapshot sync 更新本目录，再实现 Student Track 适配代码。不得在 Student Track PR 中手工修改生成快照后要求 WCG 追随。单仓 UI、内部重构和不改变跨仓可观察行为的修复仍由 Student Track 自己管理。

## 同步与联合验证

从 `protocol-st-wcg` 仓库运行：

```bash
# 检查 canonical 文件、manifest 与相邻产品仓库快照
python3 scripts/protocol_tool.py check

# 显式同步 canonical 快照
python3 scripts/protocol_tool.py sync --write \
  --student-track ../student-track \
  --wcg ../wecomcatch-gui

# 使用两端现有验证器运行合成联合契约测试
python3 scripts/protocol_tool.py conformance
```

Student Track 只登记同步后的快照和本仓适配行为；协议版本历史、兼容矩阵与 canonical hash 均回到 `protocol-st-wcg` 维护。
