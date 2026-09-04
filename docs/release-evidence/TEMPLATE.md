# Student Track Zhuiver 发布记录

复制本文件为 `docs/release-evidence/X.Y.Z.md`，填写完毕后运行
`npm run release:check-version -- docs/release-evidence/X.Y.Z.md`。

- Previous Student Track version: TBD
- Student Track version: TBD
- Zhuiver level: PATCH | MINOR | MAJOR
- Zhuiver rationale: TBD
- Product claim changed: yes | no
- Core workflow changed: yes | no
- Domain model changed: yes | no
- Protocol contract changed: yes | no
- Protocol issue/tag (if applicable): not applicable
- Compatibility records: TBD
- CI gate run (records `HEAD_SHA`): TBD
- `PRODUCT_VERIFIED_SHA`: TBD
- CI level/scopes: L3 / TBD
- Verification evidence: TBD

## Evidence

- [ ] 已记录当前 CI gate；其摘要中的 `HEAD_SHA` 与发布候选一致，且全部 in-scope job 通过
- [ ] `HEAD_SHA` 与 `PRODUCT_VERIFIED_SHA` 一致，或两者之间只有已通过文档门禁的严格 L0 改动
- [ ] 迁移、备份、隐私和回滚证据已记录
- [ ] 若涉及跨仓协议，协议 Issue/RFC、tag 和联合契约测试已记录
- [ ] 版本文件、tag 和 Release 标题一致
