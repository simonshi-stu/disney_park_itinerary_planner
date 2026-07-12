# Planning 模块

## 目的
把 catalog、observations、forecasts、时间窗、步行约束和游客偏好转换为可执行并可重规划的单园单日行程。

## 拥有
偏好解释、feasibility、time window、walking graph use、route score、itinerary version、fallback 和 replan trigger。

## 不拥有
Vendor API、canonical mapping、观测清洗或 forecast training。

## 公共接口
目标接口包括 planning request、versioned itinerary、explanation、execution event 和 replanning request/result。

## 依赖与不变量
只依赖 catalog、observation、forecast、schedule 和 walking contracts。不得直接调用外部来源。当前一次规划只接受一个园区和一个服务日；输出包含生成时间、算法版本、输入 snapshot/version、feasibility/fallback；无解或来源失败必须测试降级行为。

## 当前状态与缺口
尚未实现 production planner。先建立规则 baseline、回放 fixture 和 evaluation metric，再引入 OR-Tools 或复杂优化。
