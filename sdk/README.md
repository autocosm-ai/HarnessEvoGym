# Harness EvoGym SDK

外部插件开发包，定义 Target、Environment、Algorithm、Strategy、Updater、Evaluator 的标准接口。
其中 Algorithm v2 是不依赖 `PopulationStore` 的通用搜索协议，适合遗传算法、Beam Search、MCTS
等使用不同内部状态的实现；Population v1 仍作为现有 Cowork 训练的兼容协议保留。

## 目录结构

```
sdk/
├── README.md              # 本文件
├── package.json           # SDK 包定义
├── schema/                # Plugin Manifest JSON Schema
│   └── plugin-v1.schema.json
├── interfaces/            # TypeScript 接口定义（JSDoc 注释）
│   ├── environment.mjs
│   ├── solver.mjs
│   ├── updater.mjs
│   ├── algorithm.mjs
│   ├── algorithm-v2.mjs
│   └── evaluator.mjs
└── examples/              # 示例插件
    └── fake-environment/  # 无需 API Key 的示例 Environment
        ├── plugin.yaml
        └── index.mjs
```

## Plugin Manifest 规范

每个插件必须提供 `plugin.yaml` 文件，声明：

- **identity**: 插件名称、版本、作者
- **protocol**: 实现的协议名称和版本（如 `environment-v1`, `solver-v1`）
- **capabilities**: 插件能力声明（如 Environment 支持的分区类型）
- **runtime**: 运行时要求（Node 版本、依赖、Docker 镜像）
- **trust**: 信任模式（`trusted` 或 `sandbox`）

详见 `schema/plugin-v1.schema.json`。

## 开发流程

1. 创建插件目录，编写 `plugin.yaml`
2. 实现对应协议的接口（继承 SDK 提供的基类或直接实现）
3. 本地测试：使用 `node controller/src/plugin-loader.mjs` 的加载 API，或运行项目测试
4. 发布：npm 包或 Git 仓库
5. 当前版本不自动安装外部插件；请在受审查的启动脚本中显式调用 `autoRegisterPlugin()`，再交给 Controller 使用

## 设计原则

- **协议版本化**：接口破坏性变更时递增版本号
- **能力声明**：插件主动声明支持的功能，Controller 按需选择
- **信任边界**：Controller、Evaluator、隐藏任务属于信任根，不能放入 Candidate
- 当前 Node 插件加载器只执行 `trusted` 插件；`sandbox` 清单需要独立进程执行器，暂不会被自动加载
- **可复现性**：插件版本、依赖、Docker 镜像全部锁定并记录到 ExecutionIdentity

## Algorithm v2 最小契约

Algorithm v2 不要求插件暴露 Population 的 Branch 或 `PopulationStore`。插件只需要实现：

- `initialize(input)`：创建自己的初始状态；
- `step(input)`：`input` 包含当前 `state`、`context` 和 `store`，推进一个搜索步并返回新状态和可选的 `done`；
- `resume(input)`：从 Run Store 中恢复状态；
- `report(state)`：输出公开报告；
- `freezeBaseline(state)`：在需要时固化 Baseline；
- `store` 与 `checkpointCodec`：保存事件、状态和版本化 Checkpoint。

Controller 的通用 Host 只负责生命周期、步数上限、Checkpoint 和恢复，不理解算法内部状态。
因此遗传算法可以保存种群，Beam Search 可以保存 beam，MCTS 可以保存树，而不必伪装成
`PopulationStore`。插件仍必须在受信启动脚本中注册，当前版本不会自动安装或执行不受信代码。
