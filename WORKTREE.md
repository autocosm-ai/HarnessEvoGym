# WORKTREE

- Purpose: Mutualism 的 L1+L2 与 L1 层级消融实验配置与验证
- Branch: `exp/ablation-mutualism-layers`
- Status: active
- Key result or expected output: 保持 Mutualism、N2、B16、数据与模型不变，仅限制可进化 Region
- Next step: 两组首轮均已完成，继续正式 N2-B16 进化，完成后评测 8 道隐藏题。

## 2026-09-17 正式运行

- 去掉 L3：`ablation16-mutualism-without-l3-retry-h0-20260917`
- 只留 L1：`ablation16-mutualism-without-l2-l3-retry-h0-20260917`
- 本机配置：`.rsi/experiments/ablation16-{without-l3,without-l2-l3}-shared-h0-20260917.json`
- 公共 H0：`.rsi/baseline-packs/shared-retry-h0-20260917.json`，摘要 `a189cdd52e90922318bd9483420459a192e74247e1cccf966d457120872ba90a`。
- H0 来自 without-l3 retry6 的 branch-001，训练 8 题均值 0.12788825757575756。包含请求级重试，不能冒充旧主表 H0。
- 两组正式运行均成功导入同一个 H0 与首轮反馈，不重复跑基线。
- 旧 B2 retry6 试跑在基线完成后主动停止，其已有结果原样保留；它们不是正式 B16 结果。
- 启动时旧 Docker 空网络耗尽网段；清理已停止试跑的空网络后，正式 run 已原地 resume。
- 日志：`/tmp/ablation16-without-l3-20260917.log`、`/tmp/ablation16-without-l2-l3-20260917.log`。
- 首轮已验证：两组各消耗 B2/16，两条 Branch 各完成 G1/8。L1+L2 的训练冠军为 0.188444，仅 L1 为 0.198280；均使用同一个公共 H0。
- 第二轮四个 Updater 均已交付候选。实际 MutationDiff 符合限制：L1+L2 只改 agent.py/profile/skills；仅 L1 只改 profile/skills。不能用训练分数代替隐藏测试成绩。
