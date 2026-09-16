# Worktree

- Purpose: 为 MSA Minimal Solver 增加上游流式响应完整性检查和单次请求重试。
- Branch: `fix/msa-stream-retry`
- Status: active
- Key result or expected output: 半截 Responses SSE、空正文、429/5xx 或连接中断不会直接让整道题失败。
- Next step: 通过单元测试后，将修复同步到消融实验分支并重新启动实验。
