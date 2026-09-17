# Worktree

- Purpose: 为 MSA Minimal Solver 增加上游流式响应完整性检查和单次请求重试。
- Branch: `fix/msa-stream-retry`
- Status: active
- Key result or expected output: 半截 Responses SSE、空正文、429/5xx 或连接中断不会直接让整道题失败。
- Key result: 网关支持最多 20 次额外重试，同一请求总访问上限随配置提高，退避 5/10/20/40/60 秒。
- Next step: 通过显式 `experiment resume --gateway-retries 20` 恢复 without-l3 正式实验并核验原失败题评分。

## 重试恢复

- 本分支执行恢复，实验数据仍保留在层级消融工作树原路径；本机 `.rsi/runs/populations` 链接到该目录，锁也共用。
- 不改写旧配置、执行身份、候选或成功评分。恢复补丁按 `recovery/gateway-retry-v1.json` 的逐文件摘要校验，并向 Run 的 `public/gateway-retry-recovery.json` 追加恢复记录。
- 新网关使用独立镜像标签 `harness-rsi/model-gateway:retry-recovery-v1-20`，不覆盖其他运行的网关镜像。
- 已验证：首次 + 10/20 次真实网关请求、总次数拦截、非法执行漂移拒绝、候选和预算恢复；故障分类 fixture 显式关闭模型自身重试，使它只测试分类，重试行为由专项测试覆盖。
- 冻结候选中的 model.py 保持 8 次重试不变；本次修复实际限制上游访问次数的 Gateway。已失败退出的那道题须重新执行，其他已完成题由 Controller 缓存复用。
