# HarnessEvoGym Harbor 执行修复工作区

- Purpose: 在真正的 `lz-dev` 上完成 Harbor 任务环境的可运行执行器、逐题断点和插件兼容修复。
- Branch: `lz-dev`
- Status: stable
- Base: `8349c4742cbf9fa5feb07ac7fce434601107a9b5`
- Key result: Harbor 已支持逐任务镜像、独立 verifier、资源传递、artifact 安全复制、Solver 故障分类和 Trial Checkpoint Resume；插件 SDK 清单校验与 Environment 能力接口已兼容。
- Next step: 用真实 Harbor 任务做小规模、明确授权的 dry-run；不要直接启动大规模付费评测。
- Verification: `npm run check` 通过；`npm run test:eval` 14/14；`npm test` 548/548；已推送 `origin/lz-dev`。
