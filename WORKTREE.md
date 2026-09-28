# HarnessEvoGym lz-dev 开发主线工作区

- Purpose: 在真正的 `lz-dev` 上维护 HarnessEvoGym 的稳定开发主线、Office/HLE 评测环境和可移植 Runtime 配置。
- Branch: `lz-dev`
- Status: stable
- Key result: OfficeVal 与 HLE Text-only Math 是当前稳定环境；Runtime JSON 使用相对路径，加载时按配置位置解析并做隔离校验；`server/` 已提供 Server API / Core Engine 生命周期边界；CLI Updater 宿主路径通过环境变量注入，Harbor 等仍是实验性扩展。
- Next step: 把 `fork` 评测身份接到从 Checkpoint 创建新 Run 的 CLI/API 操作，再补充认证、租户隔离、CI 和 Office/HLE 离线端到端 Smoke；不要直接启动大规模付费评测。
- Verification: `npm run check`、目标评测测试、全量 `npm test` 561/561 已通过；提交后推送 `origin/lz-dev`。
