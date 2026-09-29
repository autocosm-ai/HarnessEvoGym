# Server API 与 Core Engine

这里是 HarnessEvoGym 的服务层边界。它不是前端，也不把 Solver、Updater 或候选代码搬进 HTTP 层。

## 两层职责

```text
Server API
  ├─ 创建 Run
  ├─ 查询状态
  ├─ Resume / Cancel / Refresh
  ├─ 读取运行事件
  └─ 读取 Candidate / Branch 版本摘要

Core Engine
  ├─ controller/src/cli.mjs
  ├─ Controller / Environment / Solver / Updater
  ├─ Population Store 与 Checkpoint
  └─ 受信的 experiment run / resume
```

`server/src/core-engine.mjs` 是一个传输无关的生命周期门面。它只接受仓库内的相对
Experiment 路径，校验 Experiment Bundle，然后启动现有 Controller CLI；它不会执行
HTTP 请求中传来的任意命令，也不会把 Provider 密钥写入 Run Descriptor。

`server/src/http-api.mjs` 使用 Node 内置 HTTP，当前提供：

- `GET /healthz`
- `GET /version`、`GET /v1/version`
- `POST /v1/runs`
- `POST /v1/runs/:runId/fork`，从 Parent Population 的 Checkpoint 创建新 Run（请求体可选 `runId`、`checkpoint`、`experimentPath`）
- `GET /v1/runs`、`GET /v1/runs/:runId`
- `POST /v1/runs/:runId/actions`，动作是 `refresh`、`resume`、`cancel`
- `GET /v1/runs/:runId/events`，可用 `Accept: text/event-stream` 获取 SSE
- `GET /v1/runs/:runId/versions`

当前 Run Worker 仍由同一 Node 进程启动受信 Controller CLI。下一步可以把
`CoreEngine.startProcess()` 换成独立 Worker/队列实现，HTTP 契约不需要改变。

## 本地启动

```bash
HARNESS_SERVER_PORT=8787 npm run server
```

API 默认只监听 `127.0.0.1`。仓库路径可通过 `HARNESS_REPOSITORY_ROOT` 指定；实验配置
仍必须是该仓库内的相对路径。当前 API 主要用于本地和受信控制平面，认证、租户隔离、
持久化数据库、消息队列和独立 Worker 属于后续服务化工作，不应把本入口直接暴露到公网。
