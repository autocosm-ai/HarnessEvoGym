# HarnessEvoGym 开发日志

这份文件是仓库唯一的开发进度入口，记录工程进度、验证结果和已知边界。它不替代项目首页；首页只介绍当前可以使用的能力。Agent 的阶段报告、临时任务清单和本地工作树说明不提交到仓库，统一保存在被忽略的 .local/development-reports/ 或当前工作树中。

## 当前主线

| 项目 | 状态 |
| --- | --- |
| 本地分支 | lz-dev |
| 远端分支 | origin/lz-dev |
| 最新代码提交 | 940a309d96（2026-10-10；本文件的文档提交紧随其后） |
| 工作树 | .worktrees/origin--lz-dev--开发主线 |
| 工作树状态 | 运行 git status --short 查询；本地清理改动不会写死在此处 |
| 项目定位 | Agent Harness 的 RSI 训练场研究预览版 |

## 2026-10-10：开源审查与死代码清理

本轮针对外部可复现性和仓库可信度做了一轮清理，重点修掉一个会让干净检出直接失败的缺陷。

| 问题                                                  | 处理                                                                                    | 结果                                                                              |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Candidate Seed 摘要被本地字节码缓存污染               | `snapshotTree` / `copyRegularTree` 增加可选 `exclude`，仅在 Seed 摘要与 Seed 覆盖处启用 | 干净 clone 与本地工作区得到同一摘要；mutation diff 仍看见全部路径                 |
| 流式解析在 `finish_reason` 处提前结束                 | 回退该改动                                                                              | 保留 `[DONE]` 语义与 `include_usage` 分块；`saw_terminator` 与 usage 统计不再丢失 |
| `performance-optimization.mjs` 未被任何生产代码引用   | 删除该模块及其两个测试                                                                  | 不再保留"已优化性能"的错误印象                                                    |
| `export-failure-report.mjs` 零引用                    | 删除                                                                                    | —                                                                                 |
| `docs/roadmap.html` 是 2025-01 的商业计划             | 删除                                                                                    | 不再被误读为当前能力说明                                                          |
| `docs/ci-cd-setup.md` 与 `ci-cd-guide.zh.md` 重复     | 合并为一份中文指南后删除英文版                                                          | 文档不再分叉                                                                      |
| CI `lint` job 实际空转                                | 移除该 job                                                                              | CI 不再声称做了没做的检查                                                         |
| `Harbor` 反馈同时写 `ctrf` 与 `verifierFeedback`      | 去掉重复字段                                                                            | 同一份 CTRF 摘要不再写两遍                                                        |
| `KernelBench` 把"宿主无 GPU 运行时"报成 CUDA 自检失败 | 区分两类错误                                                                            | 排查方向不再被误导                                                                |
| `--steps 0` 静默通过                                  | 下界改为 1                                                                              | 不再产出可被误读为"已搜索"的空报告                                                |
| `monitor.events` 无界增长                             | 上限 20k，总数仍保留在 `summary.events`                                                 | 长跑不再无界占用内存                                                              |
| HLE 受控数据可能进入构建上下文                        | `.dockerignore` 补充忽略                                                                | —                                                                                 |
| 中英文档章节结构分叉                                  | 对齐 search-strategy、putnambench-evolution、evaluation-modes 三对文档                  | 章节数一致，结论不再冲突                                                          |
| 多数 `docs/` 文档无入口、外部用户找不到               | 在 README 与 CONTRIBUTING 补齐文档索引并标注语言                                        | 11 篇此前无引用的文档已挂上入口                                                   |

## 2026-09-30：引擎复审与仓库收敛

本轮把前一阶段“功能已完成”的表述改成可验证的工程边界，并把开发报告从正式代码树中移出。

| 模块 | 当前结果 | 仍然不能承诺的事情 |
| --- | --- | --- |
| Server / Core Engine | 修复错误路径与关闭路径的竞态、终态事件和游标读取；Run 能稳定结束并保留事件 | 仍是单进程编排，不是带持久队列的分布式 Worker |
| Algorithm SDK v2 | 有版本化接口、CLI 插件入口、Checkpoint/Resume 身份校验和独立示例 | 还没有把任意算法完整接入标准 Recipe 与 Server API |
| Provider 错误处理 | 识别 524、429/5xx、SSE 截断等不同错误，并生成可诊断的失败报告 | 不能保证上游 Provider 永不超时或永不断流 |
| Environment 重试 | 普通任务支持有边界的整题重试；OfficeVal 有题目级 Checkpoint/Resume | 不同环境的能力尚未完全收敛到同一套协议；不应把重试当成无限重试 |
| Updater | 支持分层超时、P95 调整、Diff/结果校验和失败诊断 | 超时仍必须有上限，不能用“永不超时”掩盖卡死 |
| 并发与监控 | 有本地进程级并发许可、事件记录、Token/耗时统计 | 不是跨机器分布式锁，也没有生产级租户计费 |
| 评测 | OfficeVal 兼容评测和 HLE 受控流程都能复用统一的运行身份检查 | 独立评测工具不等于官方 sealed-final 审计链；真实 Provider/长任务未在 CI 中运行 |

本次仓库清理移出了 13 份根目录阶段报告、重复任务清单和 2 份旧审查记录。它们仍保留在本地被忽略目录 .local/development-reports/2026-09-30/，需要追溯时可从 Git 历史恢复；正式进度只维护在本文件。

## 已完成

### 控制平面

- Target、Environment、Updater、SearchStrategy、EvolutionRecipe 和 EvolutionAlgorithm 已拆成独立协议。
- server/ 已建立 Server API / Core Engine 边界：API 管 Run 生命周期，Core Engine 继续承载现有 Controller、Environment、Solver、Updater 与 Checkpoint。
- 五种 Population Mode 已接入通用 Cowork 编排：single、independent、mutualism、competition、combined。
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

### Harbor、KernelBench 与 SDK

- Harbor Task v1 解析器、任务镜像、Verifier、artifact 检查和 Trial Checkpoint 已有实现与离线测试。
- KernelBench GPU Smoke 已接入独立的 `kernelbench-gpu-v1` Environment，包含 ReLU/Sigmoid 两个 L1 题、GPU 资源限制、CUDA 正确性/速度评分和按题 Checkpoint；完整上游题库尚未纳入稳定支持。
- 插件 SDK、Manifest 校验和 Fake Environment 示例已加入仓库。
- 这三部分目前属于实验性扩展，尚未列入稳定支持环境。

## 验证记录

2026-10-10 在 940a309d96 上完成的本地验证结果：

    npm run check       通过（含可移植路径检查）
    npm run test:eval   全部通过
    npm test            683 项：680 通过，3 跳过，0 失败
    npm run test:docker Harbor Docker 冒烟通过（显式开启）

跳过的 3 项是需要真实 Docker、GPU 或 OfficeVal 数据集的端到端测试，默认不跑；没有把 Provider 调用、HLE 长任务或远程 CI 结果冒充成通过。

修改 Runtime 路径和文档后，需要重新执行：

    npm run check
    npm test
    npm run test:eval

## 重要设计决定

- 仓库配置不写入机器专属的本机绝对路径；Runtime 配置统一使用相对路径，加载时解析为当前机器路径。
- CLI Updater 的宿主安装目录通过 RSI_* 环境变量注入；仓库内 Adapter 不再写死某台机器的用户目录。
- 路径检查会阻止本机数据盘、用户目录和工作区路径进入源码或文档；/workspace、/candidate、/opt/harness-rsi 等是容器内部协议路径，不是宿主机路径，不能随意改成相对路径。
- Controller、Evaluator、数据划分、凭据和 sealed test 属于信任根，Candidate 与 Updater 不得修改或读取它们。
- 基础设施故障暂停运行，不能被记成 Candidate 的真实零分。
- 已提交的逐题结果可以在 Resume 时复用；半成品必须归档后重新执行。
- HLE 的 test 结果不能影响 Candidate 晋升、回退、层级选择或停止。
- Candidate Seed 摘要只覆盖源码内容，不覆盖本地运行缓存；排除规则必须显式传入，Candidate 工作区的 mutation diff 不做任何默认忽略。

## 待完成

- 将 Server API 的进程启动替换为可恢复的独立 Worker/队列，并补齐认证、租户隔离和持久化数据库。
- 为 HLE 和 Office 各补一个真实的小规模端到端 Smoke，并纳入 CI 级别的离线替身测试。
- 将 Environment 能力声明、Runtime 路径和错误分类进一步收敛到统一协议。
- 为外部插件提供独立进程沙箱和版本锁定流程。
- 为稳定发布补充 CI、版本策略、示例数据和最小可复现教程；当前仓库没有一条不依赖外网、模型或数据集的端到端示例。
- 归档一份正式实验的结果产物，作为论文和对外结论的可引用依据。
- 为外部算法插件补充独立进程沙箱、权限边界、版本锁定和失败恢复契约。
- 对 `docs/` 下仍只有中文版的参考文档，要么补英文，要么在文档表中显式标注；当前已在 README 中标注，补齐英文属于后续工作。
- Harbor、KernelBench、SWE-bench、PutnamBench 等扩展在完成独立隔离和端到端验证前，不列入稳定支持承诺。

## 分支说明

lz-dev 是当前开发主线。旧的 dev/harness-evo-gym-platform 工作树仍保留为备份，不承载最新主线代码。GitHub 默认分支仍是 main；发布前需要单独决定是否将 lz-dev 设为默认分支。
