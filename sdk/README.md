# Harness EvoGym SDK

外部插件开发包，定义 Target、Environment、Algorithm、Strategy、Updater、Evaluator 的标准接口。

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
3. 本地测试：`harness plugin validate ./my-plugin`
4. 发布：npm 包或 Git 仓库
5. 安装：`harness plugin install <package-or-repo>`

## 设计原则

- **协议版本化**：接口破坏性变更时递增版本号
- **能力声明**：插件主动声明支持的功能，Controller 按需选择
- **信任边界**：Controller、Evaluator、隐藏任务属于信任根，不能放入 Candidate
- **可复现性**：插件版本、依赖、Docker 镜像全部锁定并记录到 ExecutionIdentity
