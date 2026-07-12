# 治理与迁移路线

## Phase 0：治理基础（已完成）

项目规则、模块边界、ADR、测试/CI 骨架已建立，现有 runtime 行为保持不变。

## Phase 1：表征测试（迁移基线已完成）

已锁定采集窗口、CSV、API/cache fallback、失败行为、canonical mapping、closed/zero、stale、缺失等待值当前语义、Single Rider、重复/冲突和 optimizer selection。新发现的提取风险继续追加小型 fixture。

## Phase 2：提取当前模块

- 从 collector 提取来源 adapter 和纯转换。
- 从分析脚本提取 catalog resolution、observation quality、optimizer projection。
- 从浏览器入口分离 API/cache 与 rendering。
- CLI 命令和输出格式保持稳定，所有表征测试继续通过。

## Phase 3：存储迁移

- 引入 raw object storage 和 PostgreSQL/时序 schema。
- 通过版本化 contract 回填仓库历史。
- 对比文件与数据库输出。
- 验证切换后停止向应用分支提交 live/derived data。

## Phase 4：产品 API 与 Web

- 为 catalog/observations 引入 FastAPI use cases。
- 从 contracts 生成 web types。
- 静态体验逐步迁移到 PWA。
- Web 停止直连 vendor API。

## Phase 5：Forecasting 与 Planning

- 先建立可复现历史基线，再加入 ML。
- 输出版本化 forecast 和 backtest。
- 先实现规则 planner/evaluation baseline，再引入 OR-Tools。
- 加入带降级测试的滚动重规划。
