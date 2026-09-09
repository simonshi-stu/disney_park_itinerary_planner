# 存储备份与恢复运行手册（中文）

本文档描述 PostgreSQL 与 S3 兼容对象存储的备份、隔离 staging 恢复、只读验证与清理流程。所有命令均为 provider-neutral 示例，使用环境变量和占位符，不包含任何凭据或私有端点。provider 选择是可选的；当前推荐 provider 及官方引用另行交付。

> **安全声明**：本手册中的命令不会自动执行破坏性操作。生产恢复、资源创建、密钥录入和破坏性清理均需人工审批门禁。

## 1. 适用范围

- PostgreSQL 数据库：使用 `pg_dump` 自定义格式备份，`pg_restore` 恢复到新建的隔离 staging 数据库。
- S3 兼容对象存储：raw 归档以 SHA-256 寻址，备份与采样均不修改对象。
- 验证：恢复后运行 `npm.cmd run db:verify-restore`，raw 采样通过本地 SHA-256 与 `ingestion.raw_archives.sha256` 比较。

## 2. 环境变量与占位符

所有命令使用以下环境变量或占位符，实际值由运维人员提供，不得硬编码或提交到仓库。

| 变量/占位符 | 说明 |
| --- | --- |
| `PROD_DATABASE_URL` | 生产 PostgreSQL 连接 URL（仅用于备份，不用于恢复目标） |
| `STAGING_DATABASE_URL` | 新建的隔离 staging 数据库连接 URL |
| `BACKUP_FILE` | 备份文件路径（如 `C:\backups\2025-01-15.dump`） |
| `OBJECT_STORAGE_ENDPOINT` | S3 兼容对象存储端点（不含凭据） |
| `SAMPLE_OUTPUT_DIR` | 采样下载目录（默认 `C:\tmp\restore-sample`） |

> 所有 URL 中的用户名、密码和查询参数仅用于连接，不写入文档或日志。

## 3. 备份（人工门禁：备份前确认生产连接）

### 3.1 备份前检查

1. 确认 `PROD_DATABASE_URL` 指向生产数据库。
2. 确认备份文件路径有足够磁盘空间。
3. 确认对象存储桶存在且可读（备份不写入对象存储，但采样需要）。

### 3.2 执行备份

`pg_dump` 使用一致性快照，通常无需停止应用写入。运维人员仍应选择低负载窗口，并监控备份时长和成本。

```powershell
# 使用 pg_dump 自定义格式，包含 schema 和数据
pg_dump --format=custom --file="$env:BACKUP_FILE" "$env:PROD_DATABASE_URL"
```

备份文件应存储在受控位置，并记录备份时间、文件 SHA-256 和来源数据库标识（不包含凭据）。

### 3.3 对象存储备份责任与可选端点

PostgreSQL 备份仅覆盖数据库内容。对象存储中的 raw 归档依赖存储桶的版本控制、生命周期策略或独立复制机制，不在本手册的 `pg_dump` 范围内。运维人员应确认对象存储的保留策略满足恢复目标。

## 4. 隔离 staging 恢复（人工门禁：创建资源与恢复）

### 4.1 创建隔离 staging 数据库

创建隔离 staging 数据库属于资源创建，必须由人工在 provider 控制台完成，或通过本地编排文件（`infra/compose.yaml`）进行本地演练。本手册不提供可执行的 `CREATE DATABASE` SQL。

> **门禁**：创建数据库属于资源创建，必须由人工确认目标集群和名称，防止误建或覆盖。角色和连接 URL 由 provider 控制台或 secret manager 创建和提供，不在本手册中展示密码或内联 SQL。

### 4.2 执行恢复

```powershell
# 使用 pg_restore 恢复到新建的 staging 数据库
pg_restore --dbname="$env:STAGING_DATABASE_URL" --no-owner --no-privileges "$env:BACKUP_FILE"
```

恢复后应检查日志无错误，并记录恢复时间。

### 4.3 验证恢复目标安全

运行验证脚本前，确认 `RESTORE_DATABASE_URL` 与 `DATABASE_URL` 指向不同数据库。脚本会拒绝相同目标。

```powershell
$env:DATABASE_URL = "$env:PROD_DATABASE_URL"
$env:RESTORE_DATABASE_URL = "$env:STAGING_DATABASE_URL"
npm.cmd run db:verify-restore
```

该命令执行只读验证，包括：

- 必需表存在（catalog、ingestion、observations、infrastructure）。
- migration ledger 与文件 checksum 匹配。
- raw 不可变触发器存在。
- normalized 行无 lineage orphan。
- closed 行无 observed wait。
- raw archive 和 observation 计数为正。

### 4.4 验证命令退出码

验证脚本失败时设置非零退出码。运维人员应检查 `$LASTEXITCODE`：

```powershell
npm.cmd run db:verify-restore
if ($LASTEXITCODE -ne 0) { Write-Error "验证失败，退出码 $LASTEXITCODE"; exit $LASTEXITCODE }
```

## 5. 只读 raw hash sampling（人工门禁：选择采样对象）

本节为只读操作：从 `ingestion.raw_archives` 选择 manifest 行，下载对应对象，计算本地 SHA-256，并与 manifest 中的 `sha256` 比较。**绝不更新 manifest 或对象。**

### 5.1 选择采样行

使用只读 SQL 查询选择 5 行 manifest。示例：

```sql
SELECT raw_archive_id, object_uri, sha256, byte_size, source_name, archived_at
FROM ingestion.raw_archives
ORDER BY archived_at DESC
LIMIT 5;
```

将结果保存为 CSV 或 JSON 文件（不含凭据）。

### 5.2 下载对象并计算 SHA-256

使用 S3 兼容 CLI（如 `aws s3`、`mc` 或 `rclone`）下载对象。`object_uri` 是完整的 `s3://bucket/key` 地址，直接作为 CLI 参数。以下为 PowerShell 示例：

```powershell
New-Item -ItemType Directory -Force -Path "$env:SAMPLE_OUTPUT_DIR"

$manifest = Get-Content -Raw "sample_manifest.json" | ConvertFrom-Json
foreach ($row in $manifest) {
  $localFile = Join-Path $env:SAMPLE_OUTPUT_DIR $row.source_name
  $endpointArg = @()
  if ($env:OBJECT_STORAGE_ENDPOINT) { $endpointArg = @("--endpoint-url", "$env:OBJECT_STORAGE_ENDPOINT") }
  aws s3 cp $row.object_uri $localFile @endpointArg
  if ($LASTEXITCODE -ne 0) { Write-Error "下载失败: $($row.object_uri)"; exit $LASTEXITCODE }
  $actualSha = (Get-FileHash -Algorithm SHA256 -Path $localFile).Hash.ToLower()
  $expectedSha = $row.sha256.ToLower()
  if ($actualSha -ne $expectedSha) {
    Write-Error "MISMATCH: $($row.object_uri)"
    exit 1
  }
  Write-Host "OK: $($row.source_name)"
}
```

所有匹配则采样通过；任何不匹配需报告并调查，不自动修复。

## 6. 清理（人工门禁：破坏性操作）

清理操作仅作为示例，必须由人工显式确认目标后才能执行。以下命令不会自动运行。

### 6.1 删除 staging 数据库

删除数据库前，必须执行以下确认步骤：

1. 使用 `psql -l` 或 cloud provider 控制台查看数据库列表，确认目标数据库名称与预期完全一致。
2. 确认该名称不是生产数据库。
3. 确认备份已验证且不再需要该 staging 数据库。

> **门禁**：删除数据库是破坏性操作，必须由人工在 provider 控制台或通过管理员会话执行，确认目标为精确的隔离数据库名称，且不是生产数据库。本手册不提供可执行的 `DROP DATABASE` 命令。

### 6.2 删除采样下载文件

删除采样文件前，必须使用 `Resolve-Path` 确认目标目录存在且为临时目录：

```powershell
# 确认目标目录
Resolve-Path "$env:SAMPLE_OUTPUT_DIR"

# 仅当人工确认目录为临时采样目录后，手动删除文件（不自动递归删除）
# Remove-Item -Path "$env:SAMPLE_OUTPUT_DIR\*" -Force
```

> **门禁**：确认 `$env:SAMPLE_OUTPUT_DIR` 是临时目录，不包含其他重要文件。删除操作必须由人工手动执行，不提供自动递归删除命令。

### 6.3 删除备份文件（可选）

```powershell
# 确认文件路径
Resolve-Path "$env:BACKUP_FILE"

# 仅当人工确认备份已安全归档或不再需要时执行
# Remove-Item -Path "$env:BACKUP_FILE" -Force
```

> **门禁**：仅在确认备份已安全归档或不再需要时执行。

## 7. 人工审批门禁汇总

| 操作 | 门禁类型 | 说明 |
| --- | --- | --- |
| 备份 | 确认生产连接 | 防止误备份到 staging |
| 创建 staging 数据库 | 资源创建 | 需人工确认集群和名称 |
| 恢复 | 确认目标为新建 staging | 绝不覆盖生产 |
| 采样对象选择 | 只读确认 | 仅选择少量 manifest 行 |
| 清理（删库/删文件） | 破坏性操作 | 必须显式确认目标 |

## 8. 故障排查

- 恢复失败：检查备份文件完整性、staging 数据库连接、权限。
- 验证失败：查看 `npm.cmd run db:verify-restore` 输出中的 `failures` 列表。
- SHA-256 不匹配：确认对象键、下载完整性、manifest 数据是否被意外修改。

## 9. 相关文档

- `docs/adr/0006-postgresql-and-object-storage-backfill.md`
- `infra/restore/verify-restored-storage.mjs`
- `packages/contracts/README.zh-CN.md`
