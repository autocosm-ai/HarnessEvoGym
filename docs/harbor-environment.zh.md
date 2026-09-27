# Harbor Task v1 Environment

Harbor 适配器把一个 Harbor 任务目录接到 HarnessEvoGym 的 Environment 接口。它目前支持本仓库定义的 `harbor-task-v1` 子集：每个任务必须有 `instruction.md`、`task.toml`、`environment/Dockerfile`、`tests/Dockerfile` 和 `tests/test.sh`，并在 `task.toml` 中声明位于 `/app` 工作区内的 artifacts。

运行时边界如下：

- 每道题单独构建 environment 镜像，再构建 Solver 镜像；不会复用第一道题的镜像。
- Solver 工作区先从 environment 镜像复制到宿主 scratch 目录，再挂载进 Solver；不会用空 bind mount 把镜像内预置文件遮掉。
- `tests/` 只作为 verifier 的构建上下文，不会进入 Solver 镜像。
- Solver 只拿到题目工作区、Candidate 只读目录、环境资源目录和输出目录；Verifier 使用独立镜像、只读 submission 和 `network=none`。
- 每个 seed 都单独落盘。题目完成后原子写入 Trial Checkpoint；重新运行时只复用身份一致的已完成题。
- Provider/Verifier 基础设施错误不会伪装成 Candidate 的零分。只有结构化、可证明的 Candidate 终态才会记录为 0 分并继续。

当前适配器明确不支持：GPU 题目、`allow_internet=true`、共享 verifier、自动安装不受信任插件，以及 Harbor 隐藏题目录的自动发现。需要这些能力时，应新增版本化协议，不要静默扩大 `harbor-task-v1` 的含义。

正式运行前必须通过 `EnvironmentAdapter` 的 source digest、资源和路径校验；不要把真实 API Key 写进任务目录或 Candidate 工作区。
