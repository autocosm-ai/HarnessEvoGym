# 工作树说明

- Purpose: 基于既有 016 检查点执行预算消融评测
- Branch: `exp/ablation-budget-checkpoints`
- Status: stable
- Key result or expected output: 生成按 mode、branch、candidate digest 区分的预算检查点评测结果
- Key result: 首轮 82/96 题成功；已补 HTTP 分块断流重试与按题续跑，成功的 0 分/负分均保留。
- Key result: 2026-09-17 已完成 96/96 题，当前 0 失败；原 82 条成功记录完全未变，14 道失败题补齐。逐题分数及候选身份已归档至 `eval/archive/budget-ablation-20260917/`。
- Next step: 等层级/Updater 消融完成后统一整理；预算结果沿用旧独立评测器，未显式设置 reasoning_effort，比较时必须注明。
