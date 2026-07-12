# Infrastructure 边界

## 目的
拥有 deployment definition、additive database migration、raw object storage configuration、queue/cache、monitoring 和本地开发编排。

## 目标方向
- PostgreSQL 与适当的时序能力保存 normalized observation。
- Object storage 保存 immutable raw payload 和 model artifact。
- Redis 仅用于有明确收益的 cache、session、lock 或短期协调。
- 不同环境使用最小权限的独立 credential。

## 当前状态
当前采集仍是 GitHub Actions + repository data files。完成 contract、backfill、dual-write comparison、cutover/rollback 标准前不进行基础设施切换。
