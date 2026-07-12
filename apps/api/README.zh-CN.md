# API 应用边界

## 目的
提供 transport validation、身份/权限衔接、use-case orchestration 和 dependency injection。

## 边界
API 调用领域模块公共接口并返回版本化 contracts；不拥有 canonical mapping、质量规则、forecast 算法或 route score，不把数据库模型暴露给 Web。

## 当前状态
尚无正式产品 API。目标 FastAPI 入口必须在 contracts 和模块 use cases 就绪后引入。
