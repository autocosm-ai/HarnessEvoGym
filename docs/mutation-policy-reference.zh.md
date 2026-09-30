# Mutation Policy 快速参考

Mutation Policy 定义 Updater 可以修改的文件范围和语义约束。

──────────────────────────────────────────

## 基本结构

```yaml
apiVersion: harness-rsi/v1alpha1
kind: MutationPolicy

metadata:
  level: l1              # 风险层级：l1 | l2 | l3
  regions:               # 包含的 Regions
    - prompt-system-message

spec:
  writable:              # 可写路径（glob patterns）
    - "prompts/**/*.md"
    - "skills/*/manifest.json"
  
  readOnly:              # 只读路径（可读但不可写）
    - "skills/**/*.py"
    - "targets/**/*.yml"
  
  extensions:            # 允许的文件扩展名
    - ".md"
    - ".json"
    - ".txt"
  
  semanticConstraints:   # 语义约束（Target 特定）
    skillsCatalogValid: true
    presetIntegrityCheck: true
  
  limits:
    maximumChangedFiles: 10      # 最多改动文件数
    maximumChangedBytes: 524288  # 最多改动字节数（512 KiB）
```

──────────────────────────────────────────

## Writable vs ReadOnly

**writable**：Updater 可以读、写、创建、删除的路径

示例：
```yaml
writable:
  - "prompts/**/*.md"           # 所有 prompts 下的 .md 文件
  - "skills/*/manifest.json"    # 每个 skill 的 manifest.json
  - "!skills/deprecated/**"     # 排除 deprecated 目录
```

**readOnly**：Updater 可以读但不能修改的路径

示例：
```yaml
readOnly:
  - "skills/**/*.py"            # 所有 Python 工具函数（可读取但不可修改）
  - "targets/**/*.yml"          # Target 配置（供参考）
  - "benchmarks/**/*.json"      # Benchmark 数据
```

**路径匹配规则**：
- `*` 匹配单个目录层级内的任意字符
- `**` 匹配任意深度的目录
- `!pattern` 排除匹配的路径

──────────────────────────────────────────

## Semantic Constraints

语义约束确保 Updater 不会破坏 Target 的内部结构。

### Skills Catalog

`skillsCatalogValid: true` 要求：
- `skills/catalog.json` 结构正确
- 每个列出的 skill 都有对应的目录
- 每个 skill 的 `manifest.json` 符合规范

### Preset Integrity

`presetIntegrityCheck: true` 要求：
- Preset 文件结构完整
- 必需字段存在且类型正确
- 引用的资源路径有效

──────────────────────────────────────────

## 风险层级差异

| 层级 | 可修改范围 | 典型用途 |
|------|-----------|---------|
| **L1** | Prompts、配置参数 | 调整引导语、修改超参数 |
| **L2** | L1 + 工具函数、Skills | 优化工具实现、新增 Skill |
| **L3** | L2 + 核心算法、架构 | 重写核心逻辑、架构重构 |

**示例**：

L1 Policy（只能修改 prompts）：
```yaml
writable:
  - "prompts/**/*.md"
readOnly:
  - "skills/**"
  - "algorithms/**"
```

L2 Policy（可以修改 prompts 和 skills）：
```yaml
writable:
  - "prompts/**/*.md"
  - "skills/**/*.py"
  - "skills/*/manifest.json"
readOnly:
  - "algorithms/**"
```

L3 Policy（几乎可以修改所有代码）：
```yaml
writable:
  - "prompts/**/*.md"
  - "skills/**/*.py"
  - "algorithms/**/*.py"
  - "config/**/*.json"
readOnly:
  - "targets/**/*.yml"          # Target 定义不可修改
  - "benchmarks/**/*.json"      # Benchmark 数据不可修改
```

──────────────────────────────────────────

## 限制参数

### maximumChangedFiles

单次 Mutation 最多改动的文件数。

**建议值**：
- L1: 5-10 个文件
- L2: 10-20 个文件
- L3: 20-50 个文件

**用途**：防止 Updater 产生过于激进的改动，保持 Mutation 的可解释性。

### maximumChangedBytes

单次 Mutation 改动的总字节数上限。

**建议值**：
- L1: 256 KiB
- L2: 512 KiB
- L3: 1 MiB

**用途**：控制单次改动规模，避免全盘重写。

──────────────────────────────────────────

## 依赖与冲突

Mutation Region 之间可以有依赖和冲突关系。

### Requires（依赖）

Region A requires Region B 表示"选中 A 时必须同时选中 B"。

**示例 1**：高级功能依赖基础功能

```yaml
- id: advanced-tool-chaining
  requires: [basic-tool-calling]
```

**示例 2**：配置文件依赖代码实现

```yaml
- id: enable-caching-config
  requires: [implement-caching-logic]
```

### Conflicts（冲突）

Region A conflicts with Region B 表示"A 和 B 不能同时选中"。

**示例 1**：互斥的搜索策略

```yaml
- id: greedy-search
  conflicts: [beam-search, random-search]
```

**示例 2**：不兼容的优化方式

```yaml
- id: prompt-compression
  conflicts: [prompt-expansion]
```

──────────────────────────────────────────

## 最佳实践

### 1. 最小权限原则

只给 Updater 完成任务所需的最小权限。

**DO**：
```yaml
writable:
  - "prompts/solver-system.md"    # 只允许修改特定文件
```

**DON'T**：
```yaml
writable:
  - "**/*"                        # 过于宽松
```

### 2. 明确排除危险路径

即使在高风险层也要保护关键文件。

```yaml
writable:
  - "**/*.py"
  - "!targets/**"                 # 排除 Target 定义
  - "!benchmarks/**"              # 排除 Benchmark 数据
  - "!.git/**"                    # 排除 Git 元数据
```

### 3. 合理设置限制

根据 Region 的预期改动规模设置限制。

**Prompt 修改（L1）**：
```yaml
limits:
  maximumChangedFiles: 3
  maximumChangedBytes: 102400    # 100 KiB
```

**代码重构（L3）**：
```yaml
limits:
  maximumChangedFiles: 30
  maximumChangedBytes: 1048576   # 1 MiB
```

### 4. 使用语义约束

为 Target 定义特定的语义检查，确保结构完整性。

```yaml
semanticConstraints:
  skillsCatalogValid: true
  presetIntegrityCheck: true
  noCircularDependencies: true
```

──────────────────────────────────────────

## 验证工具

检查 Mutation Policy 是否合法：

```bash
node controller/src/cli.mjs validate-policy path/to/policy.yml
```

验证项：
- ✅ writable 和 readOnly 路径格式正确
- ✅ extensions 包含有效的扩展名
- ✅ limits 在合理范围内
- ✅ semanticConstraints 字段合法

──────────────────────────────────────────

## 示例：Text Reasoning Target

完整示例参考：`targets/text-reasoning/mutation-catalog.yml`

```yaml
regions:
  - id: prompt-system-message
    description: "修改 system message 引导推理"
    riskLevel: l1
    writable:
      - "prompts/solver-system.md"
    readOnly:
      - "skills/**/*.py"
    limits:
      maximumChangedFiles: 1
      maximumChangedBytes: 51200    # 50 KiB
  
  - id: tool-function-refine
    description: "优化工具函数实现"
    riskLevel: l2
    writable:
      - "skills/**/*.py"
      - "skills/*/manifest.json"
    readOnly:
      - "prompts/**"
    limits:
      maximumChangedFiles: 5
      maximumChangedBytes: 262144   # 256 KiB
  
  - id: core-algorithm-rewrite
    description: "重写核心推理算法"
    riskLevel: l3
    writable:
      - "algorithms/**/*.py"
      - "prompts/**/*.md"
    readOnly:
      - "targets/**/*.yml"
    limits:
      maximumChangedFiles: 20
      maximumChangedBytes: 1048576  # 1 MiB
```

──────────────────────────────────────────

**版本**：v2.0  
**更新时间**：2025-01-29
