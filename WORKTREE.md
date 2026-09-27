# HarnessEvoGym lz-dev 开发主线工作区

- Purpose: 在真正的 `lz-dev` 上维护 HarnessEvoGym 的稳定开发主线、Office/HLE 评测环境和可移植 Runtime 配置。
- Branch: `lz-dev`
- Status: stable
- Key result: OfficeVal 与 HLE Text-only Math 是当前稳定环境；Runtime JSON 使用相对路径，加载时按配置位置解析并做隔离校验；CLI Updater 宿主路径通过环境变量注入，Harbor 等仍是实验性扩展。
- Next step: 补充 CI 和 Office/HLE 离线端到端 Smoke；不要直接启动大规模付费评测。
- Verification: `npm run check`、`npm run test:eval` 14/14、`npm test` 549/549 已通过；提交后推送 `origin/lz-dev`。
