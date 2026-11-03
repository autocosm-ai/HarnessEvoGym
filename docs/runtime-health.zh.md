# 启动检查与 Updater 自动恢复

## 开跑前检查

```bash
npm run rsi -- doctor --config experiments/cowork-msa-acceptance.json
```

此命令检查 Linux 普通用户、Node、Python、Git、工作区权限、磁盘余量、Docker、
任务数据、固定源码、所选 Updater 的运行时和 Provider 配置。
不创建实验、不自动安装依赖、不构建镜像，也不调用模型。CLI 返回 JSON：
每项都有 `pass`、`warn` 或 `fail`，失败项提供原因及处理建议；有失败时退出码为 2。
尚未准备的镜像会产生 warning，仍需在真实运行前按对应环境手册构建。
固定源码的检查要求工作区先提交，未提交的执行代码会被报告为不可运行。

显式增加 `--probe-models` 后，会在运行时读取凭据，并分别向 Solver、Updater 的实际
Provider 和模型发送一次小请求。这会产生 API 费用；响应正文和 Key 不写入报告。
不加该选项时不会执行本机 Codex 的凭据 helper，所以报告中的凭据可能显示为尚未验证。

```bash
npm run rsi -- doctor --config experiments/cowork-msa-acceptance.json --probe-models
```

Ubuntu/Debian 的 CLI 沙箱依赖可通过系统包安装；项目操作仍使用普通用户：

```bash
sudo apt-get update
sudo apt-get install --no-install-recommends -y bubblewrap util-linux
```

## 自动监测与有界重试

标准 Experiment 的 DSH Docker、Codex CLI 和 Claude Code CLI Updater 均在运行器外层监测。
原生 Agent 不被修改。监测区分以下情况：

- 连续输出大量相同长文本，包括工具调用参数：中止该次 Updater，并记录 `updater-repetitive-output`。
- 持续没有可观察的模型进展：记录 `updater-idle-timeout`。SSE keepalive 不算有效进展。
- 监测接口连续三次不可用：记录 `updater-monitor-unavailable`，不能把失去监测当作运行正常。
- 原有整次运行超时仍保留。启动失败、超时等可重试故障可以重试；非法提案继续走原候选拒绝流程。

重复检测按单次模型请求、不同输出字段分别处理，保留有界内存窗口；只有至少 4096 个字符的
长片段连续重复至少八次才会判定。短模板重复、不同请求输出相同内容不会因此被停止。
这不是所有死循环的通用检测器；其他卡死仍依靠无进展超时和总时限处理。

可在 Updater Adapter 的 `spec` 中配置：

```yaml
supervision:
  maximumRetries: 2
  idleTimeoutSeconds: 600
  retryDelayMs: 1000
```

以上为默认值。`maximumRetries` 可为 0..5；2 表示首次失败后最多再试两次。
`idleTimeoutSeconds` 可为 30..3600，涵盖等待模型和执行长工具的时间，长工具任务应适当调大。
`retryDelayMs` 可为 0..60000。它们属于冻结实验配置，不能修改后直接冒充原实验 Resume。

每次重试都从同一父候选重新复制工作区，不继承半写入的失败修改；反馈任务结果继续复用。
失败尝试不消耗新的 Candidate 预算，但其模型用量仍由原用量系统累计。
如果进程崩溃导致部分用量没有可靠落盘，恢复后的用量会标为不完整，不当成零消耗。
失败工作区、原生会话及重试记录保存在 `updater-attempts/<candidate-id>/`，不会删除。
已经完成的 Updater 结果在摘要一致时复用；成功后发生的 Solver 故障不会让 Updater 重新执行。

达到重试上限后实验明确暂停。重试计数持久化，反复执行 Resume 不会绕过上限。
应先解决故障，再新建实验或从已有 Checkpoint 创建 Fork；不要删除重试记录来无限重跑。

上述自动恢复覆盖标准 Experiment 路径，旧 HLE Campaign 保持原有独立运行时协议。
