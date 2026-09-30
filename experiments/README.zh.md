# 示例实验配置指南

本目录包含各种场景的示例实验配置，帮助快速上手 HarnessEvoGym RSI。

## 快速开始

### 1. 选择适合你的示例

根据你的需求选择对应的示例配置：

- **Text Reasoning（文本推理）**：数学推理、逻辑推理等纯文本任务
- **Harbor（代码协作）**：多步骤代码任务
- **OmegaUse（Office 文档）**：Word/Excel 文档操作任务

### 2. 运行示例实验

```bash
# 使用 CLI 运行实验
npm run rsi -- run experiments/cowork-msa-smoke-single.json

# 或使用完整命令
node controller/src/cli.mjs run experiments/reasoning-msa-smoke-single.json
```

### 3. 查看结果

实验运行完成后，结果保存在：
- `runs/<run-id>/` - 运行目录
- `runs/<run-id>/task-failures.json` - 题目失败报告
- `runs/<run-id>/updater-failure-report.json` - Updater 失败报告

## 示例配置分类

### Text Reasoning（文本推理任务）

**基础示例**：
- `reasoning-msa-smoke-single.json` - 单 Branch 单代进化（最快）
- `reasoning-msa-smoke-combined.json` - 多 Branch 协同进化
- `reasoning-msa-smoke-l2-single.json` - L2 风险等级单 Branch

**适用场景**：
- 数学推理题（HLE Text Math Dataset）
- 逻辑推理题
- 纯文本输入输出任务

**关键配置**：
```json
{
  "adapters": {
    "target": "adapters/targets/msa-minimal-reasoning.yml",
    "environment": "environments/text-reasoning-smoke.yml"
  },
  "benchmark": "benchmarks/text-reasoning-smoke/benchmark.json",
  "policy": "evaluation/policies/text-reasoning-smoke.json"
}
```

### OmegaUse Office 文档任务

**基础示例**：
- `cowork-msa-smoke-single.json` - 单 Branch 单代进化（最快）
- `cowork-msa-smoke-combined.json` - 多 Branch 协同进化
- `cowork-omegause-dsh-l1.json` - L1 风险等级
- `cowork-omegause-dsh-l2.json` - L2 风险等级

**适用场景**：
- Word 文档操作
- Excel 表格处理
- 需要操作 Office 文件的任务

**关键配置**：
```json
{
  "adapters": {
    "target": "adapters/targets/msa-minimal.yml",
    "environment": "environments/omegause-officeval.yml"
  },
  "benchmark": "benchmarks/cowork-omegause-officeval-smoke/benchmark.json",
  "policy": "evaluation/policies/cowork-rsi-smoke.json"
}
```

**数据集要求**：
- 需要下载 OmegaUse-OfficeVal 数据集
- 设置环境变量：`RSI_OFFICEVAL_DATASET_ROOT=/path/to/dataset`

### Harbor 代码协作任务

**推荐配置**（规划中）：
- Harbor 端到端验证已完成（P0-6）
- 完整示例配置即将添加

## 进化策略对比

### Single（单 Branch）

**文件**：`*-smoke-single.json`

**特点**：
- 最简单、最快
- 适合快速验证
- 单线演进

**配置**：
```json
{
  "recipe": "recipes/population-smoke/single.yml"
}
```

### Combined（协同进化）

**文件**：`*-smoke-combined.json`

**特点**：
- 多 Branch 协同
- 相互学习、共享经验
- 收敛更快

**配置**：
```json
{
  "recipe": "recipes/population-smoke/combined.yml"
}
```

### Competition（竞争进化）

**文件**：`*-smoke-competition.json`

**特点**：
- Branch 之间竞争
- 促进多样性
- 探索更充分

### Mutualism（互惠进化）

**文件**：`*-smoke-mutualism.json`

**特点**：
- Branch 互相帮助
- 共同提升
- 适合协作任务

### Independent（独立进化）

**文件**：`*-smoke-independent.json`

**特点**：
- Branch 独立演进
- 无信息共享
- 对照基线

## 配置参数说明

### 基本结构

```json
{
  "apiVersion": "harness-rsi/v1alpha1",
  "kind": "EvolutionExperiment",
  "metadata": { "id": "实验ID" },
  "spec": {
    "recipe": "进化策略配方",
    "adapters": { "适配器配置" },
    "benchmark": "评测基准",
    "policy": "评测策略",
    "models": { "模型配置" },
    "evolution": { "进化参数" }
  }
}
```

### Models 配置

```json
{
  "models": {
    "solver": {
      "provider": "zcloud-openai",
      "model": "gpt-5.6-terra",
      "maxTokens": 4096
    },
    "updater": {
      "provider": "zcloud-openai",
      "model": "gpt-5.6-terra",
      "maxTokens": 4096
    }
  }
}
```

**常用模型**：
- `gpt-5.6-terra` - OpenAI GPT-4 系列
- `claude-opus-5-5` - Anthropic Claude Opus
- `claude-sonnet-5-5` - Anthropic Claude Sonnet

### Evolution 参数

```json
{
  "evolution": {
    "mutationLevel": "l1",      // 风险等级：l1（低）、l2（中）、l3（高）
    "generations": 1,            // 进化代数
    "trialsPerInstance": 1,      // 每道题运行次数
    "seeds": [20260826]          // 随机种子
  }
}
```

**Mutation Level 说明**：
- **L1**：只能修改提示词、few-shot 示例，不能改代码
- **L2**：可以修改工具函数、输入输出处理逻辑
- **L3**：可以修改核心算法、架构

## 环境变量

### 必需环境变量

```bash
# API Key（根据使用的 Provider）
export OPENAI_API_KEY="sk-..."
export ANTHROPIC_API_KEY="sk-ant-..."

# 数据集路径（Text Reasoning）
export RSI_HLE_TEXT_MATH_DATASET_ROOT="/path/to/hle-text-math"

# 数据集路径（OmegaUse）
export RSI_OFFICEVAL_DATASET_ROOT="/path/to/omegause-officeval"
```

### 可选环境变量

```bash
# 代理设置（如需要）
export HTTP_PROXY="http://127.0.0.1:7890"
export HTTPS_PROXY="http://127.0.0.1:7890"

# Docker 配置
export DOCKER_HOST="unix:///var/run/docker.sock"
```

## 自定义实验配置

### 1. 复制示例配置

```bash
cp experiments/cowork-msa-smoke-single.json experiments/my-experiment.json
```

### 2. 修改配置

```json
{
  "metadata": { "id": "my-experiment" },
  "spec": {
    "evolution": {
      "mutationLevel": "l2",
      "generations": 5,
      "trialsPerInstance": 3
    }
  }
}
```

### 3. 运行自定义实验

```bash
npm run rsi -- run experiments/my-experiment.json
```

## 常见问题

**Q: 如何选择合适的示例配置？**  
A: 从 `*-smoke-single.json` 开始，它最简单、最快。验证通过后再尝试其他策略。

**Q: 实验运行很慢怎么办？**  
A: Smoke 配置已经是最小数据集。可以减少 `generations` 或使用更快的模型。

**Q: 数据集在哪里下载？**  
A: 查看 `docs/troubleshooting.zh.md` 的"数据集问题"章节。

**Q: 如何对比不同策略的效果？**  
A: 运行多个配置，对比 `task-failures.json` 和最终 Champion 的评测结果。

**Q: 配置文件报错怎么办？**  
A: 运行 `npm run check` 检查语法，查看详细错误信息。

## 最佳实践

1. **从 Smoke 开始**：先用最小配置验证流程
2. **逐步增加复杂度**：从 single → combined → 其他策略
3. **固定随机种子**：便于复现结果
4. **记录实验参数**：每次实验记录配置和结果
5. **对比多次运行**：考虑随机性，运行 3-5 次取平均

## 参考资料

- [贡献者快速入门](../docs/contributor-quick-start.zh.md)
- [测试指南](../docs/testing-guide.zh.md)
- [故障排查](../docs/troubleshooting.zh.md)
- [CI/CD 配置](../docs/ci-cd-guide.zh.md)
