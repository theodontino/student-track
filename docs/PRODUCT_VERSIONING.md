# Student Track 产品版本（Zhuiver）

Student Track 的产品版本遵循外部治理仓库 `Protocol-of-sts/Zhuiver.md`。本文件只记录本仓库如何应用 Zhuiver，不复制版本历史，也不维护“当前基线”副本。

这里刻意不使用指向本机兄弟仓库的相对 Markdown 链接：GitHub Actions 只 checkout Student Track 自身，跨仓相对路径不是可移植的文档依赖。需要查阅规范时，以 `theodontino/Protocol-of-sts` 仓库中的 `Zhuiver.md` 为准。

## 版本来源

- `package.json` 的 `version` 是产品版本唯一来源；`package-lock.json` 的根版本必须同步。
- 根 `README.md` 和 [`RELEASES.md`](RELEASES.md) 可以展示当前产品版本，但只能作为可机器核对的展示副本，不能成为新的版本来源。
- `docs/release-evidence/<version>.md` 保存该版本的发布理由和验证证据；历史版本只在 release evidence、Git tag 与 GitHub Release 中保留。
- system health、版本 tag、GitHub Release 标题和产品版本必须与 `package.json` 一致。
- WCG、STEP 等跨仓协议的 `contractVersion`、URL 路径、协议快照 tag 和兼容矩阵不是 Student Track 产品版本来源。

## 发布 PR 必填内容

每个版本 PR 或发布记录必须写明：

- 上一版本、本版本和 `PATCH`、`MINOR` 或 `MAJOR`；
- 用户产品主张是否变化，以及工作流、领域模型和部署/数据所有权是否变化；
- 协议契约是否变化。若为 `yes`，必须先引用对应协议仓库 Issue/RFC 和协议 tag；
- `npm run verify:release` 或同一提交的 CI 质量/浏览器证据，以及迁移、隐私和回滚证据。

页面、文件、代码行数和实现重写不是版本分类依据。修复既有教学工作台承诺，即使新增页面或入口，也按 PATCH；新增独立业务对象或工作流且仍是同一产品，按 MINOR；改成机构、多角色、云同步等新的产品范式，才按 MAJOR。

## 可机器检查的记录

从模板复制发布记录后运行：

```bash
npm run release:check-version -- docs/release-evidence/X.Y.Z.md
```

发布记录检查器验证版本字段、分类和证据是否完整；文档语义检查还会确认 `package.json`、`package-lock.json`、根 README、当前兼容表和当前 release evidence 没有版本漂移。

这些检查不代替 `verify:release`、真实使用验收或协议联合契约测试。正式发布仍需遵守 [`OPERATIONS.md`](OPERATIONS.md) 的发布与封档流程。
