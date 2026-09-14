# 共享 H0 的最终评测

一个 H0 + 五个 Population 的冻结冠军，分别评测同一套隐藏题；不是重新训练。
H0 来源必须在评测前通过 `baselineFrom` 固定，不能根据哪个基线分数低再选。
五份最终报告引用同一份 H0 结果摘要，直接比较平均 Reward 和配对差值。

```bash
npm run rsi -- experiment finalize-suite \
  --config experiments/shared-final-main16-train8-test8-20260914.json
# 同一套冻结代码、配置、题目、Candidate、Runtime 和模型下恢复：
npm run rsi -- experiment finalize-suite \
  --config experiments/shared-final-main16-train8-test8-20260914.json --resume
```

单个 Controller 进程并发调度六份评测，各自仍需要 Solver/Verifier 容器。
实际解题并发由原 Environment 和 `RSI_GLOBAL_SOLVER_CONCURRENCY` 限制。
`maximumConcurrentTrialsPerEntry` 默认 1，让每个版本同时做一道题；可以降低但不能
突破冻结 Environment 的上限。`--validate-only` 校验全部输入和 Runtime，不请求模型、
不领取 Final Suite Claim；需要的本地镜像不存在时会执行正常构建。
各模式的标签只用于报告，不调用 Population 算法或 Updater，不消耗新的进化 Budget。

## 冻结与恢复

- 入口核对 Population 已关闭、Best/Branch/Manifest/Digest 一致，并重算 Candidate 内容。
- 共享条件包括 H0 内容、Target、Benchmark/Split、Verifier、模型/Provider、Seed、
  步骤与资源配置、Runtime 镜像身份。任一不一致都拒绝共享。
- Suite Claim 固定 Controller 执行内容、配置和六份评测身份；每个 Population 另写
  `final-suite-adoption.json`，不能更换 Suite ID 反复评测，也不能同时运行旧 finalize。
- 旧 Final 已中断时必须显式使用 `supersedeInterrupted: true`。原 Claim、日志、逐题记录
  不删除、不改写，另存新 Suite 及它与旧 Attempt 的关系。已有完整 Final 报告不能重测。
- 这次旧评测切换到新协议时保留旧文件，但**不混入新分数**：新协议增加了统一的
  空正文兼容策略；H0 固定取 Single 的原始代码，从同一套 8 题开始一次新的公共评测。
- 新 Suite 内 Resume 复用已提交题（包括 0 分），只处理尚未完成题；已完成整份结果
  丢失/摘要不同、题目身份漂移时直接失败，不重新采样。半成品归档后从干净工作区执行。
- 每题首次尝试 + 最多五次追加尝试；尝试计数在题目工作区外持久化，Resume 不清零。
  进程中断时已经开始的尝试也计入预算；耗尽后不能继续 Resume 增加机会。

## 空正文兼容

默认保持旧规则。`retryReasoningOnly: true` 只接受网关完整记录的
HTTP 200、正常结束、只有 reasoning、正文为空，且无拒答/tool_calls/截断的响应。
这是一项显式评测兼容策略，**不是把模型输出问题称作断网**。H0 和所有冠军统一启用，
不修改其 model.py，也不拿思考字段冒充答案。鉴权失败、拒答、工具不匹配、正常零分
和 Verifier 故障仍不因此重试。内部模型请求重试与外层题目尝试是两层不同预算。

## 结果与边界

`.rsi/runs/final-suites/<id>/plan.json` 记录六份任务和结果位置，`jobs/` 是进度，
`completed/` 是不可变完成记录，`reports/` 是共用 H0 的五份报告，`summary.json` 是总表。
这些文件是可信评测侧产物，不放入训练 Feedback 或 Updater 沙箱。
任一任务失败不影响其余任务继续；缺失的结果显示 incomplete，不记成 0。
最终测试结果不能用于选择新的冠军或指导 Updater 修改后再测同一批隐藏题。

旧 `experiment finalize` 的一次性规则不变；跨进程恢复是新 `finalize-suite` 的能力。
自动化测试使用本地 HTTP 网关和真实 MSA Python 调用，Office 评分使用 fixture；
测试通过不等于 ZCloud 实测或正式 Benchmark 结果已经完成。
