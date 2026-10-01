# R2 normalized replay（04d4）

## 当前状态与安全边界

`r2-normalized-records.mjs` 提供注入式、离线可测的 R2 archive-to-normalized replay engine。当前没有 R2 inventory/getObject adapter、Neon target、经审核 catalog/access-mode input 或有效容量批准；全量 replay **blocked**。CLI 只有 `--check`，不会读取环境变量、连接网络/云、打开 PostgreSQL writer、应用 migration 或写数据；它不假装本地有 authoritative inputs，因此不提供本地 `--dry-run`（注入式 dry-run 只能由获批调用方通过 API 运行）。它目前会明确输出 `status: "blocked"` 及缺少的输入/gate；这表示安全检查完成，不代表 replay 可执行。

截至 2026-09-30，旧 validation branch 不可假定仍有效；预估 457,840 行也很可能超过 512 MiB Free-plan 名义余量。不得以 production 替代过期 target，不得升级 plan。只有另行批准当前 validation target、人工实测容量与保留余量、逐批 stop threshold 后，才可由获批调用方注入写入能力；本 CLI 不提供 hosted write mode。

## 输入端口

- `archives` 是明确选定的 immutable `raw-archive.v1` inventory descriptors，严格消费 contract 字段 `raw_archive_id`、`object_uri`、`sha256`、`byte_size`、`source_name` 和 `schema_version`；当前 R2 scope 仅接受 `s3://` URI 与 `raw-wait-observation.v1`，并要求 `raw_archive_id` 必须等于 `sha256`（内容寻址 descriptor），否则整个 descriptor 无效。
- 注入的 `r2.getObject(uri)` 返回完整 bytes、相同 URI、`immutable: true`、content length 和 metadata (`sha256`、`schema_version`)。适配器必须能证明 URI 指向不可变对象。Engine 先核对完整 payload SHA-256、metadata 与实际/声明 byte size；任何不匹配都在 CSV parse 前失败。
- catalog input 是显式 `{ status: "reviewed", catalog_version, reviewed_by, reviewed_at, entries }`；`entries` 每一项必须是 `catalog-entry.v1`，lifecycle version 一致，并经 catalog 公共 resolver 校验。当前 raw archive replay 只接受 Disneyland Park (`disneyland`) 与 DCA (`dca`) 行；多园区 catalog snapshot 本身可以存在，但不会扩张本 phase 的数据范围。Engine 不导入 bootstrap alias CSV，不产生或伪造官方证据；未知/冲突 identity 阻止整个选定 scope 的任何写入。若同一园区内两个生命周期重叠的 entry 会把同一 alias 解析到不同 canonical identity，预检以单一 `reviewed_catalog_snapshot_cross_entry_alias_ambiguity` blocker 阻止整个 scope，而不是让每一行重复产生 unresolved identity。
- access-mode input 是显式、同一 catalog version 的 reviewed mapping，键为 `(park_id, ride_id)`，值只能是 `standby`、`single_rider`、`virtual_queue` 或 `other`。不从 ride name、Single Rider suffix 或 legacy cleaned CSV 推断 mode；缺失项逐行计数并阻止整个 scope 的任何写入。

CSV header 不算 data row。第一条 parsed data record 的 ordinal 是 1，后续 ordinal 递增；`raw_observation_id = SHA-256(UTF-8 "${verified_archive_sha256}:${one_based_data_row_ordinal}")`。完整性核对/重试通过这个计算出的 ID 查询 `raw_archive_line_references` primary key；绝不按 `archive_sha256` 扫描整表或要求未经批准的宽索引。

## 预检、批次与事务

Dry-run 先完整读取并验证本次 invocation 选定的每个对象，再 parse/normalize 全部 data rows；报告 archive failures、unresolved identities、missing access modes 和 normalization failures。只要存在任何问题，整个 scope 在**第一笔 write 之前** fail-closed。Dry-run 使用注入的只读 raw-row count port，不调用 transaction/writer port。

`scope_id` 始终绑定完整有序的选定 archive inventory；resume 时预检与读取只覆盖 cursor 所在 archive 及其后的 archive，报告通过 `resume.archives_skipped_before_cursor` 与 `resume.archives_preflighted_this_invocation`（以及 `counts.archives_verified`）列出跳过清单与本次 invocation 的实际预检范围。任何 archive 输入变化都会因 scope 不匹配拒绝续跑。

获批 write API 要求显式 validation-only authorization、精确的 `neon-validation-branch-only` target label、有效容量测量和运行时 usage monitor。每次 invocation 的 batch size 最大 500、最多 20 batches（最多 10,000 rows）；每 batch 独立事务，并在事务前/后测容量。容量测量 `measuredAt` 不得晚于 invocation `generated_at`，且不得超过 24 小时最大年龄；过期或未来测量在打开写事务前 fail closed。触发 stop threshold 时返回绑定 archive 清单、catalog snapshot、access-mode mappings 和 transformation version 的 scope cursor；任何输入 scope 改变都会拒绝续跑。每次 commit 后 cursor 前移到已提交位置，second-pass 失败或中断返回绑定 `scope_id`、可继续的 cursor 与 stop reason。执行可人工暂停后重新预检并续跑；不会无限循环。

每个 transaction 按 catalog snapshot、archive-line reference、normalized v2、source-health 顺序通过 04d3 ports 写入同一个 caller transaction；失败回滚当前 batch。每批由 replay 比较 catalog 与 archive-line reference 的持久化返回值（真实持久化结果），差异回滚当前事务；normalized 与 source-health 的持久化冲突/不可变语义由 04d3 ports 在事务内强制执行（normalized 冲突 fail closed 并保留首次 `generated_at`，source-health 按 `(source_name, run_id)` upsert），replay 不比较 adapter 的输入回显。每批 source-health 的 `run_id` 由 replay scope 与该批首/末 archive+ordinal 派生，跨暂停、续跑与相同重试保持稳定且逐批唯一，绝不使用 per-invocation batch counter。每批 source-health digest 表示按行顺序排列的 raw observation ID manifest。Engine 不调用 raw archive/raw observation insert port；每次 invocation 前后只读比较 `ingestion.raw_wait_observations` 基线，变化则报告失败。

## 离线命令

```powershell
node scripts/replay-r2-archives-to-normalized.mjs --check
node --test tests/storage/r2-normalized-replay.test.mjs
```

CLI 只接受 `--check`；其他参数（包括 `--dry-run`）以退出码 2 拒绝并打印 usage，不打开任何网络/数据库连接。`r2-normalized-replay-report.v1` 的 JSON Schema 同时约束该离线报告与注入式 replay 报告（`oneOf` 两个 variant）；报告字段的 focused 断言保留在 `tests/storage/r2-normalized-replay.test.mjs`，不依赖外部 schema 包。当前 CLI 只输出阻塞原因，绝不假装有本地 authoritative inputs 或 capacity approval。Fake R2/database tests 覆盖 hash/metadata 校验、descriptor identity、明确 access mapping、跨 entry alias 歧义、全 scope fail-closed、原子 rollback、retry、bounded pause/resume、失败 second-pass cursor、source-health run_id 稳定性、resume 跳过既有 archive、容量测量新鲜度、报告 schema variant、baseline 不变和零 raw-row inserts。
