# Worktree

- Purpose: Mutualism + Claude Code / Sonnet 5 Updater 消融实验
- Branch: `exp/ablation-claude-mutualism`
- Status: active
- Key result: 在与 Codex 主线严格对齐的条件下验证 Claude Updater 能否完成最小候选交付
- Next step: 监控现有 N2-B16 的 Claude 首轮候选交付，完成训练后评测 8 道隐藏题。

## 2026-09-17 当前运行

- Run：`ablation16-claude-mutualism-retry8-shared-h0-20260917`；N2-B16，两条 Branch 各 8。
- 本机配置：`.rsi/experiments/ablation16-claude-mutualism-shared-h0-20260917.json`，来源为 `experiments/cowork-msa-main16-claude-mutualism.json`。
- Solver：MSA + ZCloud gpt-5.6-terra / xhigh；Updater：Claude Code 2.1.274 + claude-sonnet-5。
- 复用与两组层级消融相同的公共 H0 和首轮反馈；包摘要 `a189cdd52e90922318bd9483420459a192e74247e1cccf966d457120872ba90a`，启动已验证成功。
- 日志：`/tmp/ablation16-claude-retry8-20260917.log`；tmux：`ablation16-claude-retry8-20260917`。
- retry7 的两条 Branch 完成了 H0 及 feedback，但均因沙箱内映射 root 被 Claude CLI 拒绝启动。其 32 份答案和评分全部保留，未计为完成进化。
- `d89513e7ae` 修复沙箱用户映射、CLI 重复 /v1、beta 查询参数路由以及 Anthropic 根地址补 /v1。相关 40 项测试通过，包含真实 Bubblewrap UID/写入测试。
- 真实 Claude CLI 小验证已成功完成模型调用、工具读取、写入合法报告；正式候选的改进与评分需以实验产物为准。

## 2026-09-17 首轮实际验证

- branch-002 已交付 `g001-l3`：实际修改 `profiles/cowork.md` 和四个 `skills/cowork-*/SKILL.md`，MutationDiff 合法，无越界修改。
- 候选完成全部 8 道训练题，0 条 SolverFailure；均值 0.181944，高于公共 H0 的 0.12788825757575756，Controller 已将其晋升。
- 以上验证了真实 Claude 修改、Solver 解题、评分、晋升链路。2026-09-17 14:12 检查时 branch-001 仍处于 Updater 阶段，整组尚未完成首轮结算，更未完成 B16。
- 保持既有模型、Provider 和正式运行继续；完成训练后，测试应保留最终候选的 model.py，不能无条件用旧独立评测器覆盖潜在的 L3 改进。
