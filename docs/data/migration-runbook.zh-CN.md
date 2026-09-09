# 数据存储迁移运行手册

> 独立备份与恢复演练手册：`docs/data/storage-backup-restore.zh-CN.md`。恢复演练、隔离 staging 验证与清理流程以该文档为准。

## 目标架构

```text
source API -> ingestion adapter -> immutable object storage (raw)
                              -> PostgreSQL (metadata/catalog/normalized)
                              -> FastAPI -> Next.js
```

Git CSV 在迁移完成前保留为 bootstrap fallback 和审计证据，不能继续扩展为永久存储。

## 阶段与检查点

1. **准备**：确认云区域、预算、数据库 URL、对象存储 bucket、备份策略和访问权限。
2. **Schema**：只添加新 migration；先 dry-run，再在 staging 应用。migration runner 必须记录版本并支持重复执行检查。**Checkpoint**：`npm.cmd run db:migrate` 成功且 migration ledger 与文件 checksum 匹配；随后按 `docs/data/storage-backup-restore.zh-CN.md` 执行一次隔离 staging 恢复演练，`npm.cmd run db:verify-restore` 必须通过。首次恢复演练由人工执行，hosted 凭证录入与首次恢复均为人工门禁。
3. **Raw 回放**：按 archive hash 上传 raw；重复运行不得产生重复 raw 记录。
4. **Normalized 回放**：使用目标 normalizer 重放所有历史日期，保留 raw lineage。
5. **Parity**：比较 raw/normalized 数量、hash、关闭/0 值语义、canonical identity、营业窗口和缺口。
6. **双写**：bootstrap collector 同时写 Git fallback 和 hosted storage，至少观察一个完整验证窗口。
7. **切换**：API 先从 PostgreSQL 读取；异常时只读 fallback，不回写伪造数据。
8. **回滚**：在接受 checkpoint 前保留 Git 读取路径和旧静态站点；通过 feature flag 恢复读取，不删除 raw。
9. **收尾**：确认备份、恢复演练、成本监控和健康检查后，才停止 Git 数据提交。

每个阶段必须生成机器可读结果，至少包含 `run_id`、输入快照、代码/schema 版本、计数、失败原因和下一步建议。Agent 可以自动重试幂等阶段，但遇到数据删除、生产切换或账单权限变更必须暂停。

## 当前阻塞

当前 normalized 历史只覆盖部分日期，不能跳过 replay/parity 直接切换。未通过 parity 的日期不能进入 forecast training set。

> 该阻塞在 Phase 2 checkpoint 中保持不变；checkpoint 只验证 schema 与恢复能力，不解除 replay/parity 前置条件。

## 密钥与权限

- 凭证只存在于本地 secret store、GitHub Environment secrets 或云端 secret manager。
- Workflow 优先使用 OIDC 短期凭证，不把长期云密钥写入仓库。
- staging 和 production 使用不同数据库、bucket 和最小权限角色。
- 公开仓库不得包含连接字符串、访问令牌、Cookie 或私人 endpoint。
