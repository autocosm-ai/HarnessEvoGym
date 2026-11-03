# 独立任务与 Beam Search 示例

这个示例组合两个受信插件：任务插件检查一段仿射表达式的输出，算法插件用 Beam Search
修改候选 `.mjs` 文件。变异器是确定性枚举，不调用模型，不代表真实 Agent 的能力提升。
任务评分、候选代码、Beam 私有状态、检查点和测试分区结果都分别保存。

在主仓执行第一步，再用另一个进程恢复：

```bash
npm run rsi -- algorithm run \
  --plugins sdk/examples/affine-search/plugins.json \
  --algorithm affine-beam-search-v2 --run-root .rsi/affine-example --steps 1

npm run rsi -- algorithm run \
  --plugins sdk/examples/affine-search/plugins.json \
  --algorithm affine-beam-search-v2 --run-root .rsi/affine-example --steps 6 --resume
```

也可以复制本目录到主仓外面的独立目录，使用 `--plugins ../my-plugins/plugins.json`。
目录没有对 Controller 内部文件的相对 import，算法从宿主注入的 `createPluginDriver` 创建任务环境。
`PluginSet.plugins` 的路径相对清单文件，不要求与主仓共用目录。Run 仍保存到主仓内的 `.rsi/`。

算法的 `beam` 状态无需转换成 PopulationStore。可以通过 `--configuration config.json`
设置 `{"width":2,"limit":6}`，任务参数可以通过 `--context context.json` 传入。
源码、依赖文件、配置或 Context 改变后必须创建新 Run；旧版没有插件身份记录的 Run
应使用其原版 CLI 恢复，不能用新代码冒充原实验续跑。

这是 `trusted` 插件，会在 Controller 进程内运行，具有该进程的权限。
只加载自己审查过的插件；清单里的 permissions 不是 OS 沙箱。
示例评分器只解析固定格式的算术表达式，不执行任意候选 JavaScript。
它演示接口和恢复，不代替正式隔离环境的安全验收。
