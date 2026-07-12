# Bootstrap 行为表征测试

这些测试在现有 Node.js bootstrap 数据链路被拆分到领域模块之前，锁定它的可观察输入和输出。测试会把真实 CLI 入口复制到临时目录，用小型、确定性的 fixtures 执行，因此不会修改仓库里的生成数据，也不依赖实时乐园 API。

## 当前覆盖

- **采集窗口：**锁定开园前 30 分钟的采集边界。假设 09:00 开园，08:30:00 已进入窗口，08:29:59 尚未进入。这里的“一秒”是相对于采集窗口边界，不是相对于开园时间。
- **CSV 规范化：**验证 UTF-8 BOM、双引号包裹的逗号字段，以及旧 CSV 缺失的园区本地日期、时间和时区字段可以被正确处理。
- **Canonical mapping：**验证同一设施的不同名称、季节版本和 Single Rider 基础名称映射到稳定的 `canonical_attraction_id`。
- **Closed / zero：**关闭项目原始值即使为零，也不产生真实的零分钟等待观测；开放项目的零分钟仍保留为有效观测。
- **Single Rider：**验证 Single Rider 是独立的 `access_mode`。出现过可信正等待值的队列可作为 optimizer reference，不与 standby 数据混合。
- **Optimizer-ready selection：**同一 canonical attraction 存在多个候选时，验证当前脚本优先选择新鲜、符合使用条件的记录，并输出候选数量和选择原因。
- **闭园边界：**锁定闭园后 60 分钟仍属于采集窗口，而下一秒已经离开窗口。
- **API/cache fallback：**schedule API 失败时读取每个园区的本地 schedule cache；queue API 返回错误时采集命令明确失败，而不是生成空的成功快照。
- **Stale source：**超过阈值的来源记录保留审计字段，但标记为 `stale_source` 并从等待时间训练及 optimizer 选择中排除。
- **重复与 canonical conflict：**分别报告同一快照中的同名重复来源行，以及映射到同一 canonical attraction 的多个候选。
- **缺失等待值的当前行为：**当前脚本会把开放项目的空字符串经 `Number("")` 转换为零，并当作 `open_zero`。测试刻意记录这个遗留行为；它不是目标语义，后续修改必须作为明确的 observations 行为变更处理。

## 为什么采用这种实现

测试通过子进程运行真实的 `scripts/collect-wait-times.mjs` 和 `scripts/analyze-wait-times.mjs`，而不是直接测试复制出来的内部函数。这样可以同时覆盖命令行参数、文件读取、CSV 解析、清洗规则和最终输出。固定时间和 mock API 只用于移除网络及当前时间带来的随机性。

fixture 只包含能表达业务边界的少量记录，不复制生产历史。每个测试都在独立临时目录中执行，所以可以安全并行运行，也不会改写 `data/`、`outputs/` 或 cache。

## 运行

```powershell
npm run test:characterization
```

或作为全部检查的一部分运行：

```powershell
npm run check
```

这些是迁移兼容测试，不是未来正式 contract。当 bootstrap 逻辑迁入 `ingestion`、`catalog` 和 `observations` 后，相同 fixture 的关键结果应该保持稳定。只有经过明确的公共行为或 contract 变更，才能同步更新这些预期。
