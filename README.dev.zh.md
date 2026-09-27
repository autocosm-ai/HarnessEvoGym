# HarnessEvoGym 开发日志

这份文件记录开发主线的工程进度、验证结果和已知边界。它不替代项目首页；首页只介绍当前可以使用的能力。

## 当前主线

| 项目 | 状态 |
| --- | --- |
| 本地分支 | `lz-dev` |
| 远端分支 | `origin/lz-dev` |
| 最新提交 | 以远端 `origin/lz-dev` 为准 |
| 工作树 | `.WorkTrees/origin--lz-dev--开发主线` |
| 工作树状态 | 干净，已与远端同步 |
| 项目定位 | Agent Harness 的 RSI 训练场研究预览版 |

## 已完成

### 控制平面

- Target、Environment、Updater、SearchStrategy、EvolutionRecipe 和 EvolutionAlgorithm 已拆成独立协议。
- 五种 Population Mode 已接入通用 Cowork 编排：`single`、`independent`、`mutualism`、`competition`、`combined`。
- Mutation Catalog、Mutation Plan、Mutation Lease 和完整 Diff Guard 已落地。
- Candidate 晋升、回退、冻结、审计和运行身份校验已接入 Controller。

### OfficeVal

- MSA Minimal Cowork 可以在 Office 镜像中执行任务并产出文件。
- Verifier 在独立容器中读取只读交付物并计算 Reward。
- 原始数据集不会直接作为可写工作区挂载。
- Provider 暂态错误、题目级 Checkpoint 和显式 Resume 已覆盖。
- 独立 OfficeVal 泛化评测工具支持候选、题目和模型配置，并能复用已经提交的题目结果。

### HLE

- HLE text-only Math 数据准备、分层抽样和固定 split 已实现。
- MSA Solver、Judge、validation feedback 和 sealed test Broker 已实现。
- HLE 的 Campaign 可使用五种 Population Mode，并支持暂停后的 Resume。
- HLE Runtime JSON 已改为相对路径；加载器在运行时按配置文件目录解析并执行目录隔离校验。

### Harbor 与 SDK

- Harbor Task v1 解析器、任务镜像、Verifier、artifact 检查和 Trial Checkpoint 已有实现与离线测试。
- 插件 SDK、Manifest 校验和 Fake Environment 示例已加入仓库。
- 这两部分目前属于实验性扩展，尚未列入稳定支持环境。

## 验证记录

最近一次路径可移植性和稳定环境整理后的验证结果：

```text
npm run check       通过
npm run test:eval   14/14 通过
npm test            549/549 通过
```

修改 Runtime 路径和文档后，需要重新执行：

```bash
npm run check
npm test
npm run test:eval
```

## 重要设计决定

- 仓库配置不写入机器专属的 `/mnt/...` 路径；Runtime 配置统一使用相对路径，加载时解析为当前机器路径。
- Controller、Evaluator、数据划分、凭据和 sealed test 属于信任根，Candidate 与 Updater 不得修改或读取它们。
- 基础设施故障暂停运行，不能被记成 Candidate 的真实零分。
- 已提交的逐题结果可以在 Resume 时复用；半成品必须归档后重新执行。
- HLE 的 test 结果不能影响 Candidate 晋升、回退、层级选择或停止。

## 待完成

- 为 HLE 和 Office 各补一个真实的小规模端到端 Smoke，并纳入 CI 级别的离线替身测试。
- 将 Environment 能力声明、Runtime 路径和错误分类进一步收敛到统一协议。
- 为外部插件提供独立进程沙箱和版本锁定流程。
- 为稳定发布补充 CI、版本策略、示例数据和最小可复现教程。
- Harbor、SWE-bench、PutnamBench 等扩展在完成独立隔离和端到端验证前，不列入稳定支持承诺。

## 分支说明

`lz-dev` 是当前开发主线。旧的 `dev/harness-evo-gym-platform` 工作树仍保留为备份，不承载最新主线代码。GitHub 默认分支仍是 `main`；发布前需要单独决定是否将 `lz-dev` 设为默认分支。
