# 跨仓库协议快照

Student Track 与 WCG 的跨仓库协议由独立的 `student-track-wcg-protocols` 仓库统一维护。
本目录中下列文件是生成快照，不是本仓库的独立规范来源：

- `wcc-student-track-file-v1.schema.json`
- `student-track-receipt-v1.schema.json`
- `student-track-wecom-draft-package-v1.schema.json`
- 对应 `examples/` 合成示例

## 修改边界

任何改变跨仓字段、枚举、路径、文件名、原子写顺序、SHA-256、幂等身份、错误码、目录 API、
capability、授权、数据所有权、no-send 或联合发布顺序的 Feature，必须先在协议仓库建立并接受
Issue/RFC。协议发布后，使用协议仓库的 snapshot sync 更新本目录，再实现本仓适配代码。

不得在 Student Track PR 中手工修改生成快照后要求 WCG 追随。单仓 UI、内部重构和不改变跨仓
可观察行为的修复仍由 Student Track 自己管理。

## 当前迁移基线

本次治理迁移不改变协议。迁移时三个 Schema 和三个合成示例与协议仓库 canonical 文件逐字节
一致；当前目录 API 只有 observed spec，没有借迁移新增严格 Schema 或客户端校验。

联合检查从协议仓库运行：

```bash
python3 scripts/protocol_tool.py check --student-track ../student-track --wcg ../wecomcatch-gui
python3 scripts/protocol_tool.py conformance --student-track ../student-track --wcg ../wecomcatch-gui
```
