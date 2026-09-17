# Worktree

- Purpose: Mutualism + Claude Code / Sonnet 5 Updater 消融实验
- Branch: `exp/ablation-claude-mutualism`
- Status: active
- Key result: 在与 Codex 主线严格对齐的条件下验证 Claude Updater 能否完成最小候选交付
- Next step: 监控现有 N2-B16 的 Claude 首轮候选交付，完成训练后评测 8 道隐藏题。

## 2026-09-17 当前运行

- Run：`ablation2-claude-mutualism-retry7-20260917`；名字保留历史前缀，实际 totalBudget 为 16、两条 Branch 各 8。
- 配置：`experiments/cowork-msa-main16-claude-mutualism.json`。
- Solver：MSA + ZCloud gpt-5.6-terra / xhigh；Updater：Claude Code 2.1.274 + claude-sonnet-5。
- H0 已完成，两条 Branch 各 8 道训练题；当前在第一轮 feedback 阶段，尚不能宣称 Claude 已交出候选。
- 日志：`/tmp/ablation2-claude-mutualism-retry7.log`。
