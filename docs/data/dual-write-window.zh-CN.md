# 双写验证窗口

## 目的

`source-health.v1` 保存每次 source-envelope 运行的派生健康状态。它可以通过 `(source_name, run_id)` 更新，不覆盖或修改 raw archive、raw observation 或 source envelope。`source_status=outage` 必须保留错误类型和错误消息；`stale` 是可见的降级状态。

`dual-write-window-report.v1` 比较一个完整窗口内的 expected runs、Git fallback runs、hosted runs 和 source-health records。报告只有在 expected runs 非空、Git/hosted 每个 run 都存在且写入成功、payload hash 与记录数一致时才会通过；source outage 失败，source stale 产生 warning。

## 只读报告

准备一个不含凭证的 JSON 输入文件：

```json
{
  "runId": "window-2026-09-21",
  "windowStart": "2026-09-21T00:00:00.000Z",
  "windowEnd": "2026-09-21T23:59:59.999Z",
  "expectedRuns": [{ "run_id": "collector-run-1", "observed_at": "2026-09-21T15:00:00.000Z" }],
  "gitRuns": [{ "run_id": "collector-run-1", "status": "written", "payload_sha256": "...", "record_count": 42, "observed_at": "2026-09-21T15:00:00.000Z" }],
  "hostedRuns": [{ "run_id": "collector-run-1", "status": "written", "payload_sha256": "...", "record_count": 42, "observed_at": "2026-09-21T15:00:00.000Z" }],
  "sourceHealthRecords": []
}
```

运行只读报告：

```powershell
node infra/report-dual-write-window.mjs .\work\dual-write-window-input.json
```

命令只读取输入并向 stdout 输出机器可读 JSON；`passed_with_warnings` 也返回非零退出码，必须经过人工确认后才能接受。它不连接数据库、不上传对象、不修改 Git fallback，也不会代替首次 hosted restore 人工门禁。

## 接受条件

- 至少覆盖一个完整的配置采集窗口，而不是只选成功样本。
- `status` 为 `passed` 或经人工确认的 `passed_with_warnings`。
- `failures` 为空，且 `complete=true`。
- source outage、missing hosted run、hash/count mismatch 均已解释并重新验证。
- 报告与输入快照、代码版本和 schema 版本一起留档。
