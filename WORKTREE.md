# 工作树说明

- Purpose: 基于既有 016 检查点执行预算消融评测
- Branch: `exp/ablation-budget-checkpoints`
- Status: active
- Key result or expected output: 生成按 mode、branch、candidate digest 区分的预算检查点评测结果
- Key result: 首轮 82/96 题成功；已补 HTTP 分块断流重试与按题续跑，成功的 0 分/负分均保留。
- Next step: 仅补跑 14 道未完成题；每题原子保存，完整候选才生成正式均值。
