# HarnessEvoGym lz-dev 开发主线工作区

- Purpose: 在真正的 `lz-dev` 上维护 HarnessEvoGym 的稳定开发主线、Office/HLE 评测环境和可移植 Runtime 配置。
- Branch: `lz-dev`
- Status: stable
- Key result: OfficeVal 与 HLE Text-only Math 是当前稳定环境；Runtime JSON 使用相对路径，加载时按配置位置解析并做隔离校验；`server/` 已提供 Server API / Core Engine 生命周期边界；CLI Updater 宿主路径通过环境变量注入，Harbor 等仍是实验性扩展。
- Next step: 在此基础上继续做认证、租户隔离、独立 Worker/队列和生产级持久化；不要直接启动大规模付费评测。
- Verification: `npm run check`、`npm run test:eval`、目标测试及全量 `npm test` 570/570 已通过；提交后推送 `origin/lz-dev`。
