# Final 评测容错

本文描述旧 `experiment finalize` 入口。多 Mode 共用 H0 和按题跨进程恢复请使用
新增的 [finalize-suite 入口](shared-final-suite.zh.md)，不通过删除旧 Claim 来恢复。

## 不改变什么

修复只在 Controller 的评测执行层。Provider、模型、思考深度、题目、
Seed、单次解题步骤上限、Verifier/Rubric、H0 与最终 Champion 都保持冻结。
不调用 Updater，不重新训练，不凭测试成绩重新选择冠军。

## 使用方式

```bash
npm run rsi -- experiment finalize --run <population-run> \
  --final-only --infrastructure-retries 5
```

省略 `--final-only` 时保持旧的「feedback 回放 + final」流程。
加上它则仅测 final；报告不填本次未测的 feedback，也不计算训练—测试提升差距。
如需展示历史训练成绩，应另列原始记录来源，不能把它冒充本次回放成绩。

过去那次 Final 若**尚未接触隐藏题**就失败，仍可走已有的
`--recover-infrastructure` 一次性恢复入口；它会核对冻结实验、候选与前后
Controller 版本。修改后的 Controller 信任根必须先提交才能运行。
原 Claim、失败记录及历史产物都保留，不手工改 hash、不删除 Claim。

## 具体重试规则

- 仅 OmegaUse 支持；进化阶段默认不启用新增的整题自动重试。
- 默认首次失败后最多追加 5 次（总共最多 6 次）；通过 Final 配置最多可追加 10 次。退避为 5/10/20/40/60 秒。
- 只依据可信网关记录：暂态 HTTP 429/500/502/503/504、连接中断，
  或旧分类器记为 `upstream-contract-unproven` 的 HTTP 200 流内 error。
- 明确的 HTTP 400/401/403/404/422、网关权限/预算限制、Verifier 故障、
  Candidate 错误、正常拒答/空回答/tool_calls，以及有效的零分都不自动重试。
- 重试单位是一道尚未提交结果的题。该题有多个 seed/trial 时，它们作为一个
  原子题目记录一起重新执行，不能把重试理解成给每题额外采样再挑最高分。
- 半成品和失败诊断移入 `recovery/trial-attempts/`，重试从干净题目工作区开始。
  其他题的 `committed-result.json`（包括 0 分）不覆盖、不重复执行。
- 失败调用仍进入网关/Driver 的用量累计；缺少 usage 时保持未知，不补成 0。
  逐题分数和耗时描述成功提交的那次尝试，历史失败与等待另看恢复归档，
  不应将逐题成功耗时当成包含重试的端到端总耗时。
- Final Claim、状态及最终报告记录评测分区和重试策略；公共重试日志不输出隐藏题
  ID、题面、逐题得分、上游错误原文或凭据。

## 边界

这些重试发生在同一个存活的 Final 进程、同一次 Claim 内。重试耗尽时保留已完成
题和失败证据，Final 仍标记失败，不产生完整分数。**这次没有新增跨进程 Final
Resume**：一旦接触隐藏题，退出后仍禁止重新解封；若需要该能力，必须另行设计
固定 Candidate/题目/资源与不可变逐题记录的恢复协议，不能简单循环执行 finalize。

本地测试覆盖真实 HTTP 网关、MSA Python 模型调用、错误分类、Environment、按题断点
与重试归档。模型服务和 Office 评分使用可控 fixture，不代表真实 ZCloud 或正式
OfficeVal 隐藏测试已完成。
