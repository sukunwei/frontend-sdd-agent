# sdd-graph 本地仓库模式（就地工作）设计

日期：2026-10-31
状态：待评审（已过一轮 builder check，问题已收敛，见 §10）

## 1. 意图

`/sdd-graph:start` 应当在**业务代码仓库目录**里执行，产物（代码、需求文档、验证记录）直接落在业务仓库里；
sdd-graph 本体（`frontend-sdd-agent`）只做编排器，不再充当"另一个代码仓库"。

## 2. 现状与问题

插件安装本身是对的：`extraKnownMarketplaces.sdd-graph` 指向 `frontend-sdd-agent` 目录，
`sdd-graph@sdd-graph: true` 已启用，命令在任意 cwd 都可调用。

问题在插件的**工作目录模型**：`src/runtime/paths.ts` 把所有路径解析到 `getPluginRoot()`（agent 目录），
`start` 阶段 `cloneBranch()` 把目标仓库克隆到 `<插件根>/workspace/tasks/<task>/repo`，于是：

- 代码与 `docs/<task>/` 落在 agent 目录的 clone 里，不在业务仓库；
- checkpoint（`runtime/checkpoints.sqlite`）与分支锁（`runtime/branch-runtime-lock.json`）是**全局单例**，
  A 仓库跑任务会锁死 B 仓库，同名 task 在不同仓库会串 checkpoint；
- CLI 明明在业务目录运行（`process.cwd()` 就是业务目录），插件却完全不用它——只有 `figma-diff` 用了 cwd。

README 第 154 行写明这是有意设计（"圖在外掛的工作區裡 clone 那個 repo"）。本次要把它改成**默认就地工作**。

## 3. 目标 / 非目标 / 反目标

### 目标

1. `--repo` 缺省时取当前工作目录；在业务仓库目录执行 `/sdd-graph:start --task <name>` 即就地工作。
2. 本地模式下代码、需求文档、四道验证关卡全部作用于业务仓库本身。
3. checkpoint 与分支锁按仓库隔离，落在 `<业务仓库>/.sdd/`。
4. 保留远端克隆模式（`--repo <url>`），存量用法不失效。
5. `docs/<task>/`（需求文档、`workflow-state.json`、`timeline.md`）**进版本库**，跟代码一起提交。

### 非目标

- 不改图（graph）的阶段结构、不改工作单协议、不改各阶段节点的职责边界。
- **不引入自动 commit / push**（决策：等人工确认）。插件跑完把用户留在 `task/<name>` 分支上，
  带着未提交的产物，由人 review 后自己提交。
- **不在就地模式做任何自动回滚**（决策：失败就停在那儿让人手动收拾，见 §5.9）。
- 不改 `.claude-plugin/plugin.json` 的插件形态（agent 继续以 plugin 形式分发）。

### 反目标

- 不为了"就地"而牺牲隔离性到无法回退：就地模式下**禁止任何会丢掉用户已有改动的 git 操作**（见 §5.9）。
- 不做隐式行为：模式（就地 / 克隆）必须由参数与仓库形态**显式可判定**，出错时消息要说清楚落在哪。
- 插件不得**自动修改用户受版本控制的文件**（如 `.gitignore`）——只提示，不代劳。

## 4. 约束

- Node ≥ 20.11，ESM，TypeScript strict，`npm`。
- 测试：vitest（`npm test`），类型检查 `npm run typecheck`。
- 插件本体可从任意 cwd 调用。
- `SDD_GRAPH_WORKSPACE_BASE` 仍需生效（既有测试与老用户依赖它）。

## 5. 核心设计

### 5.1 运行上下文（RunContext）

新增 `src/runtime/run-context.ts`，把"这次运行发生在哪个仓库、哪种模式"变成一个显式对象：

```ts
export type RepoMode = 'local' | 'remote';

export interface RunContext {
  mode: RepoMode;
  /** local: 业务仓库根；remote: clone 出来的仓库目录 */
  repoRoot: string;
  /** 该仓库的运行时状态根（local 模式 = <repoRoot>/.sdd） */
  sddHome: string;
  /** remote 模式 = <插件根>/workspace/tasks；local 模式不使用 */
  workspaceBase: string;
}
```

模块级单例 + `setRunContext()` / `getRunContext()` / `resetRunContext()`。
**未设置时回退到旧的插件根行为**，这样既有测试与既有命令（`resume`/`status`/`stop`）一行不改也能跑。

### 5.2 路径解析（改 `src/runtime/paths.ts`）

| 函数 | local 模式 | remote 模式（不变） |
| --- | --- | --- |
| `getCheckpointPath()` | `<repoRoot>/.sdd/checkpoints.sqlite` | `<插件根>/runtime/checkpoints.sqlite` |
| `getLockFilePath()` | `<repoRoot>/.sdd/branch-lock.json` | `<插件根>/runtime/branch-runtime-lock.json` |
| `getWorkspaceBase()` | 不使用 | `<插件根>/workspace/tasks` |
| `getRepoDir(task)` | 不使用 | `<workspaceBase>/<task>/repo` |
| `getDocsDir(name, repoDir)` | `<repoDir>/docs/<name>`（**已支持显式 repoDir，不改**） | 同左 |

**环境变量作用域（澄清）**：

- `SDD_GRAPH_WORKSPACE_BASE` —— **只**覆盖 workspace base（remote 模式用），语义不变。
- `SDD_GRAPH_SDD_HOME`（新增）—— 覆盖 local 模式的 `.sdd` 根，默认 `<repoRoot>/.sdd`。
- 测试继续用 `RunCliOptions.checkpointPath` / `lockPath` 注入，既有测试结构不受影响。

`getDocsDir` / `ArtifactStore` 早就接受显式 `repoDir`，所有阶段节点都用 `state.repoPath`，
所以**就地模式下文档与代码自动落到业务仓库**，阶段节点零改动。

### 5.3 仓库解析（新增 `src/runtime/repo-resolver.ts`）

```ts
export interface ResolvedRepo {
  mode: RepoMode;
  /** local: 仓库真实根（git rev-parse --show-toplevel）；remote: clone 目标目录 */
  repoRoot: string;
  /** remote 模式的原始 URL；local 模式为 undefined */
  remoteUrl?: string;
}

export function resolveRepo(spec: string | undefined, cwd: string): ResolvedRepo
```

判定顺序（**必须确定性，不猜**）：

1. `spec` 缺省 → 用 `cwd`；
2. `spec` 命中 URL 形态（含 `://`、`git@`、以 `.git` 结尾）→ **remote**，原样交给 `cloneBranch`；
3. `spec` 是存在的路径 → **local**，再用 `git -C <path> rev-parse --show-toplevel` 取真实仓库根；
   路径不存在 → 报错 `validation_error`，消息里同时给出两种解释（路径写错 / URL 写错）。
4. 其余形态 → 报错 `validation_error`。

`validateRepoUrl` 只作用于 remote 模式；local 模式不受其字符黑名单约束。

**兼容性（行为变更，需在 README 显著标注）**：`cloneBranch` 过去能直接 `git clone <本地路径>`，
所以 `--repo ../other-repo` 曾经 = "克隆一份到插件 workspace"。新规则把它判成 local = **就地工作**，
这是静默的行为变更。要保留"从本地路径克隆"的旧用法，改用 `file://` 前缀（走 remote 模式）。

### 5.4 就地模式的分支准备（改 `src/runtime/git-branch-manager.ts`）

新增 `prepareLocalBranch(repoRoot, branchName)`：

**脏的口径（关键）**：只看**已跟踪文件的修改**——
`git -C <repoRoot> status --porcelain --untracked-files=no`。
未跟踪文件不算脏，因为切分支会把它们带过去，不会丢；而插件自己的 `.sdd/` 与上一轮遗留的
`docs/<other-task>/` 通常是未跟踪的，把它们算成脏会让闸门每次都触发，就地模式直接不可用。

1. 上面这条命令非空 → 工作区脏，**不自动 stash**（stash 是有副作用的动作），交给用户闸门（见 §5.5）。
2. 分支已存在 → `git checkout <branch>`；不存在 → `git checkout -b task/<name>`（沿用 `generateBranchName`）。
   分支已存在但 base 不同也直接 checkout（用户自己的同名分支，插件不替他判断）。
3. 分支被别的 worktree 占用 → git 自己会失败，包装成 `git_error`，消息说明"分支被另一个 worktree 占用"。
4. 返回 `{ repoRoot, branch, currentBranch }`；**不 push**（远端推送由人决定）。

### 5.5 bootstrap 的两种模式（改 `src/nodes/bootstrap.ts` + `src/commands/start-task.ts`）

`startTask()` 增加 `mode` 分支：

- **remote**：完全走现状（建 workspace → clone → 写 run-metadata）。
- **local**：
  1. 校验仓库存在且是 git 仓库；
  2. 检查工作区是否干净 → 脏则开一道 `audience: user` 的闸门，选项 `['proceed', 'abort']`；
  3. `prepareLocalBranch()`；
  4. **不建 workspace 目录**，run-metadata 改写到 `<repoRoot>/.sdd/runs/<task>/run-metadata.json`；
  5. `repoPath` = 业务仓库根。

**闸门的答案必须被记住（否则死循环）**：bootstrap 节点的 `interrupt()` 写在节点体内，
resume 时**整个节点从头重跑**（`bootstrap.ts:56-133`），而 `asked` 变量只在单次执行内有效。
`proceed` 不改变世界 → 第二次执行又检测到脏 → 又 interrupt → 无限循环。

解法：**复用既有的阶段台账**（`src/graph/state.ts` 的 `stageSteps` 通道：
`hasStageStep()` / `recordStageStep()`）。台账本来就是"这个阶段的哪一步已经走过"的账本，
而且**刻意不属于 1.1.0 镜像文档**（`workflow-state.json` 里看不到它）——正好适合放这个一次性决定：

- 读：`hasStageStep(state, 'bootstrap', 'dirty-worktree')` 为真 → 不再开闸门。
- 写：`recordStageStep('bootstrap', 'dirty-worktree', 'proceed')`。

**不新增 state 字段**，也就不会动 1.1.0 的 schema 与镜像文档。

- `proceed` 的语义：**不切分支**，在当前 HEAD 上工作。
  `state.branch` 记**当前分支名**（`git rev-parse --abbrev-ref HEAD`），run-metadata 同记。
- `abort` 的语义：**终止这一轮**——释放分支锁、结束 run、退出码 1，
  新增 error code `aborted`。checkpoint 保留（用户还能 `resume`），锁必须释放。

**阻塞判定语义随之改变**：`detectStartBlocker()` 现在的 `already_exists` 判据是"workspace 目录存在"，
local 模式下没有 workspace 了。**节点拿不到 checkpointer**（checkpoint 只能由 CLI 侧删），
所以判据退化为两个可从文件系统读到的信号：

- `<repoRoot>/.sdd/runs/<task>/run-metadata.json` 存在（这个 task 之前跑过），或
- 分支 `task/<name>` 已存在。

**reset 的删除范围（数据安全红线）**：local 模式下 `reset` **只删 `<repoRoot>/.sdd/` 下这个 task 的东西**
（run-metadata 等）。**绝不删**业务仓库里的 `docs/<task>/`、不删分支、不删代码。
reset 完在输出里提示用户自己处理那些产物。

### 5.6 CLI（改 `src/cli/index.ts`）

- `start`：`--repo` 由必填改为可选（缺省 = cwd）；`state.repoUrl` 改为携带解析结果。
- **checkpoint 查找链（保证 remote 模式与旧流程不破）**：`resume`/`complete`/`approve`/`status`/`stop`
  不新增参数，靠 cwd 判定模式。但"cwd 在业务仓库 + `--repo <url>` 走 remote"是 README 里的标准用法，
  若 remote 的 checkpoint 落在插件根、而 `resume` 按 cwd 去找 `<repo>/.sdd/`，旧流程会直接断。

  解法：**按候选路径顺序查找**——
  ① `<cwd>/.sdd/checkpoints.sqlite`（local）→ ② `<插件根>/runtime/checkpoints.sqlite`（remote/legacy）。
  找到**含有该 thread** 的那个就用它（用 `isEmptyState()` 判断"有没有这个 thread"）。
  两个都找不到才报 `no_checkpoint`，错误消息里列出查过的两个位置。
  写入永远落在 primary 路径（local → `<repo>/.sdd/`；remote → 插件根）。

- 新增 `migrate` 子命令（见 §5.7）。

### 5.7 迁移与向后兼容

`sdd-graph migrate --repo <path>`：把旧的全局库搬进 `<repo>/.sdd/`。

- **归属判据**：旧 state 里带 `repoUrl`。用业务仓库的 `remote.origin.url` 与旧 thread 的 `repoUrl` 比对，
  **匹配才搬**；不匹配的 thread 留在旧库，并在输出里列出（"这些 thread 属于别的仓库，没有迁移"）。
- **实现**：`SqliteSaver` 有 `list` / `getTuple` / `put` / `putWrites` / `deleteThread`，没有跨库搬一条 thread 的现成 API。
  做法：`list()` 枚举 → `getTuple()` 读 → `put()` 写进新库 → `putWrites()` 搬运 pending writes。
- 旧库先备份为 `checkpoints.sqlite.bak`，**不自动删除**旧库，由用户确认后手动清理。
- 旧锁文件是全局单例，可能属于别的仓库的 task → **不迁移锁**，只在输出里提示"旧锁仍指向 X，请先 stop"。

### 5.8 命令文档与业务仓库卫生

- `commands/start.md`（以及 `resume.md`）改写：
  - 用法：`/sdd-graph:start --task <name> [--repo <path|url>]`
  - 明确"**必须在业务仓库目录执行**"；
  - `--repo <url>` = 旧的克隆模式；省略或给本地路径 = 就地模式。
- **`.gitignore`：插件不自动改用户的文件。** local 模式首次启动时检测 `.sdd/` 未被忽略，
  在输出里给一行提示（`请把 /.sdd/ 加进 .gitignore`），不写文件。
- **插件的加载路径**：`sdd-graph` marketplace 是 **directory 源**
  （`~/.claude/plugins/known_marketplaces.json` 的 `installLocation` 直接指向源码目录），
  所以会话加载的就是源码目录里的 `commands/*.md` 与 `prompts/*.md`——
  **改完命令文档，重启会话即生效，不需要重装插件**。
  （曾经存在的一份陈旧缓存副本 `~/.claude/plugins/cache/sdd-graph/` 已于 2026-10-31 删除，
  它既不是加载路径，也没有独有内容。）

### 5.9 就地模式的安全边界（**最重要的一节**）

克隆模式里 workspace 是一次性的，`git reset --hard` 砸的是一次性的副本，无所谓。
就地模式下 `repoDir` = **用户的业务仓库**，同样的操作会直接毁掉用户的东西。

现状插件里确实有破坏性 git 操作：

- `src/runtime/git-tags.ts:106` — `resetToTaskStart()` 执行 `git reset --hard sdd/task/<id>/start`
- `src/runtime/git-tags.ts:51` — `tagTaskStart()` 在仓库里打 tag
- 调用点：`src/subgraphs/tdd.ts:162`（打 tag）与 `src/subgraphs/tdd.ts:566`（回滚）

**就地模式的处理（决策：禁用回滚，失败就停在那儿让人手动收拾）**：

1. **不执行任何回滚。** 不做 `git reset --hard`，也**不做路径级的部分回滚**——
   一旦开始"代替用户决定哪些改动该被撤销"，就是在替用户做价值判断。
   就地模式下任务失败两次，**坏代码原样留在用户的仓库里**，由用户自己收拾。
2. **不打 tag。** 没有回滚点就不需要 `sdd/task/<id>/start` 这个 tag（`src/subgraphs/tdd.ts:162` 跳过）。
   用户的仓库里不会多出插件的 ref。
3. **闸门必须把这件事说清楚。** 现有的 escalation 闸门已经带了 `rollback` 字段
   （`src/subgraphs/tdd.ts:380-395`），`skipped` 的语义本来就是"没有回滚，坏代码还在磁盘上，用户要知道"。
   就地模式复用这条路径：`rollbackOutcome()` 返回 `skipped`，并在闸门消息里明确写
   **"就地模式不做任何自动回滚，坏代码留在你的业务仓库里，请手动处理"**。
   `wait` / `skip` / `abort` 三个选项的语义不变。
4. **禁止 `git checkout -f` / `git clean -fd` / `git stash` / `git reset --hard`** 等一切会丢掉用户改动的操作。
5. **禁止自动 commit / push**（决策：等人工确认）。跑完之后用户的仓库**停在 `task/<name>` 分支、
   带着未提交的产物**——这是预期行为，命令文档与 README 要写明：用户 review 完自己 commit / merge。
6. **就地模式下 `eslint` 关卡不带 `--fix`**（2026-10-31 最终审查补的）：
   四道关卡里的 `npx eslint . --ext .ts,.tsx --fix` 会在**用户的仓库里改写他们的源码**——
   克隆模式里改的是一次性的副本（无所谓），就地模式里改的是用户自己写的代码。
   远端模式不变（副本上自动修没有风险）。
7. **分支归属只有一条规则**：就地模式的 run 属于 `task/<name>` 分支。
   `start` / `resume` / `proceed` 三条路径共用同一套判断（`planLocalBranch()` 唯读地决定
   `switch` / `stay` / `dirty` / `failed`，`applyLocalBranch()` 在拿到锁之后才写）。
   工作区脏的时候走同一道脏闸门问用户，不静默换分支；
   用户明确选"留在当前分支"时，那个决定记在台账里（`bootstrap/dirty-worktree = proceed`）。

## 6. 改动清单

| 文件 | 改动 |
| --- | --- |
| `src/runtime/run-context.ts` | **新增**：运行上下文单例 |
| `src/runtime/repo-resolver.ts` | **新增**：local / remote 判定 |
| `src/runtime/paths.ts` | checkpoint / lock 按上下文解析；新增 `SDD_GRAPH_SDD_HOME` |
| `src/runtime/git-branch-manager.ts` | 新增 `prepareLocalBranch()`（脏口径 = 已跟踪文件的修改） |
| `src/runtime/git-tags.ts` | 不改。local 模式**不调用** `tagTaskStart()` / `resetToTaskStart()` |
| `src/runtime/task-workspace.ts` | local 模式下 run-metadata 改落 `.sdd/runs/<task>/`；清理函数**只允许删 `.sdd/` 下的路径** |
| `src/commands/start-task.ts` | `startTask()` 分 local / remote；`detectStartBlocker()` 判据分模式 |
| `src/nodes/bootstrap.ts` | local 模式跳过 clone；脏工作区闸门 + `dirtyWorktreeAccepted` 记忆；`abort` 终止路径 |
| `src/subgraphs/tdd.ts` | local 模式跳过打 tag 与回滚；`rollbackOutcome()` 返回 `skipped` 并给出"就地模式不回滚"的人话 |
| `src/graph/state.ts` | **不改**：闸门答案记在既有的 `stageSteps` 台账里（`bootstrap/dirty-worktree`） |
| `src/cli/index.ts` | `--repo` 可选；checkpoint 查找链；新增 `migrate` 子命令 |
| `src/runtime/errors.ts` | 新增 error code `dirty_worktree` / `aborted` |
| `commands/start.md`、`commands/resume.md` | 用法与工作目录说明 |
| `README.md` | 工作区模型章节改写；本地模式、迁移、`.gitignore` 提示、兼容性变更说明 |
| `tests/` | 新增 `repo-resolver.test.ts`、`local-mode.test.ts`、`run-context.test.ts`、`local-rollback.test.ts`；既有 clone 测试保持全绿 |

## 7. 测试计划

- `resolveRepo()`：URL / 缺省 / 相对路径 / 绝对路径 / 子目录 / 不存在路径 / 非 git 目录 —— 逐个判定；
  `file://` 前缀走 remote。
- `prepareLocalBranch()`：临时 git 仓库里新建分支、已存在分支、**已跟踪文件被改**（脏 → 拒绝）、
  **只有未跟踪文件**（不脏 → 放行）。
- `startTask()` local 模式：**不产生任何 clone**，不创建 workspace 目录，`repoPath` == 仓库根。
- 路径解析：设置上下文后 checkpoint / lock 落在 `<repo>/.sdd/`；未设置上下文时保持旧行为。
- **回滚安全（回归红线）**：local 模式下任务连续失败两次 →
  断言**没有任何 destructive git 发生**：用户的未提交改动一字未动、
  仓库里**没有**新增 `sdd/task/*` tag、HEAD 没有被 reset。
  坏代码原样留在磁盘上，闸门消息里出现"就地模式不做任何自动回滚"。
- **闸门不死循环**：脏工作区 → interrupt → 用户答 `proceed` → 第二次执行**不再** interrupt。
- checkpoint 查找链：local 库没有该 thread → 回落到插件根库并找到。
- 端到端：local 模式下跑通到 `prd` 阶段，产物写进业务仓库的 `docs/<task>/`。
- 回归：`npm test`（既有 remote 模式用例全绿）、`npm run typecheck`。

## 8. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 就地模式直接改用户工作区 | 只改被授权路径；脏工作区必须过闸门；`.sdd/` 靠提示让用户忽略 |
| **回滚 `reset --hard` 毁掉用户改动** | **local 模式完全禁用回滚与打 tag（§5.9）+ 专门回归测试** |
| 闸门答案没记住导致死循环 | state 字段 `dirtyWorktreeAccepted` |
| 切分支影响用户当前工作 | 脏 → 闸门；干净 → 切 `task/<name>`；跑完停在分支上是文档写明的预期 |
| 多仓库同名 task 串状态 | checkpoint / lock 按仓库隔离（`.sdd/`） |
| remote 旧用法被新规则改变 | `--repo <本地路径>` 语义变更写进 README；`file://` 保留旧行为；查找链保证旧 checkpoint 仍可达 |
| `migrate` 搬错仓库的 thread | 按 `repoUrl` 匹配 `remote.origin.url`，不匹配的留在旧库并列出 |
| 插件缓存陈旧导致改了不生效 | 交付清单写明"重装插件"这一步 + 验证命令 |

## 9. 留给实现者的判断

- `RunContext` 用模块单例还是参数透传（倾向单例 + `resetRunContext()`：
  `paths.ts` 的函数被 10+ 处调用，参数透传会波及每个节点）；
- 闸门 payload 的 `type` 命名（建议 `dirty_worktree`，与 `already_exists` 同级）；
- `migrate` 子命令的参数名（建议 `--repo`，与 `start` 一致）；
- `.sdd/` 下除 `runs/<task>/run-metadata.json` 外的目录名；
- `resolveRepo()` 判定 URL 形态的具体正则（设计已给三种形态）。

## 10. builder check 收敛记录

一轮 builder check 提出 11 问，已全部落进本文：
#1 模式查找链 → §5.6；#2 脏的口径 → §5.4；#3 闸门死循环 → §5.5；
#4 already_exists 判据与 reset 删除范围 → §5.5；#5 destructive git → §5.9（新增章节）；
#6 migrate 归属与实现 → §5.7；#7 分支副作用与收尾 → §5.4 / §5.9；
#8 环境变量作用域 → §5.2；#9 repoUrl / run-metadata 取值 → §5.3（`remote.origin.url`，无则 `local:<目录名>`）；
#10 `.gitignore` 谁写 → §5.8（只提示不代劳）；#11 本地路径语义变更 → §5.3（README 显著标注）。

**人工决策（2026-10-31，用户拍板）**：

1. 就地模式**禁用回滚**——不做 hard reset，也不做路径级部分回滚；任务失败两次就停在那儿，
   坏代码留在业务仓库里，用户手动收拾（§5.9）。
2. **不自动 commit / push**，跑完停在 `task/<name>` 分支等人工确认（§3 非目标、§5.9）。
3. `docs/<task>/` **进版本库**，跟代码一起提交（§3 目标 5）。
   ⚠️ 实际落地时发现：没有任何 prompt 会 commit `docs/<task>/`（只有 `prompts/developer.md`
   让工人 commit 代码），所以 README 写明"需求文档要你自己 `git add docs/<name>/`"。

#### 最终整体审查补上的（2026-10-31）

- 就地模式下 `eslint` 关卡**不带 `--fix`**（§5.9 第 6 条）——否则会改写用户的源码。
- 分支归属收敛成一条规则（§5.9 第 7 条）。
- 脏闸门的承诺改口径：不再说"你的改动原封不动"（工人的 commit 会与你的未提交改动共处一个工作区），
  改成"工人只提交它自己写的那些文件"（`prompts/developer.md` 禁掉 `git add -A`）。
- 进版本库的镜像里**不带本机绝对路径**（`repoUrl` 用 `remote.origin.url`，`repoPath` 置空）。
- `migrate` 判归属前**规范化 repoUrl**（去 `.git` 后缀、`git@host:path` ↔ `https://host/path` 互转），
  否则同一个仓库的两种写法会被误判成"混了两个仓库"并永久跳过。
- `stop --force` **不再能抢别的 task 的锁**（锁现在是 per-repo 的，抢别的仓库的锁更危险）。
  这是对"remote 模式逐字不变"的**有意偏离**，已写进 README 的行为变更段。
- `SDD_GRAPH_SDD_HOME` 不得指向仓库根（否则清理会删 `<repo>/tasks/<task>` 与 `<repo>/runs/<task>`）。
