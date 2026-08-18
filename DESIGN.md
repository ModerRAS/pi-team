# Pi Team Plugin 设计草案

## 状态

本文记录当前讨论形成的产品方案。它用于防止后续实现或技术审计把原始目标改写成普通的 `Main -> Subagent` 或静态 workflow。

- 已确定的产品语义用“必须”描述。
- 尚未确认的选择用“建议”或“未决”描述。
- workflow 只曾用于本次外部需求审计，不属于目标系统。

## 原始问题

用户输入新要求的速度可能长期高于单个 coding agent 的输出速度。当前单会话会把不同工作压入一条串行队列，导致：

- 无关工作互相等待。
- 用户只能等当前 Agent 结束，或另开窗口并重复上下文。
- 普通 subagent/workflow 只能处理预先定义的一批工作，无法持续接收、纠正和取消后续要求。
- 并行 Agent 的结果通常要等全体结束后汇总，最慢任务拖住其他结果。

目标是在一个 Pi 项目和一个 TUI 中，持续接收用户输入，并横向扩展需求分析、监督和执行能力。

## 核心模型

```text
用户 / 甲方
    |
    | 快速连续提出要求；可查看全部正式群聊和全部执行细节
    v
Boss（可并发存在多个）
    |
    | 理解一段累积的线性项目上下文，管理全局方向
    v
Department Lead / 部门主管
    |
    | 持续监督、纠偏、协调和汇总本部门员工
    v
Worker（每个主管可并发管理多个）
      执行调查、实现、测试和其他具体工作
```

插件内部还有一个不属于上述组织层级的 `Supervisor`：

```text
Supervisor（控制面，不参与需求分析）
  - 身份与权限
  - RPC 子进程生命周期
  - 共享事件日志的唯一写入
  - 消息投递
  - 配额与取消
  - 主群聊与 Inspector UI
```

部门主管用于替 Boss 承担持续协调和验收，使 Boss 不必消费所有 Worker 的过程消息。Boss 不直接实现项目任务，也不越级安排 Worker；一个连贯工作流通常交给一个主管，主管再把连贯执行任务交给一个 Worker。只有真正独立的领域或并行任务才增加角色。

## 一个共享大群

所有正式消息进入同一个只追加、带全局序号的事件日志。所有角色属于同一个大群，但上下文投影不同。

| 参与者 | UI/存储可见性 | 默认进入其 Agent 上下文的内容 |
| --- | --- | --- |
| 用户 | 能查看全部正式消息；可在 Inspector 查看任意角色的完整执行过程 | 不适用 |
| Boss | 有权主动下钻读取全部 | 用户发给自己的要求、主管汇报、跨部门冲突、全局决策、风险与取消 |
| 部门主管 | 可见所属部门的全部正式消息 | 本部门全部消息、Boss 指令、跨部门依赖 |
| Worker | 正式日志中可被用户查看 | 明确 `@自己` 的消息、自己的任务、直属主管指令、必要依赖和强制取消 |

必须区分：

1. 消息存在于共享事件日志。
2. 消息是否显示在用户当前 UI 视图。
3. 消息是否注入某个 Agent 的模型上下文。

用户看见所有内容，不代表所有内容都会进入 Boss 或 Worker 的上下文。

Boss 默认看主管汇报，不默认吞下全部员工消息。Boss 可主动读取某部门、线程或员工的历史，并把读取结果加入自己的下一轮上下文。

Supervisor 为每个角色持久化独立事件游标。每次 `prompt` 或 `steer` 唤醒角色时，会自动注入该游标之后、截至本次投递快照的全部可见正式事件，然后推进游标。Boss 唤醒主管时，主管因此会拿到期间全部直属 Worker 消息和生命周期事件，不依赖模型主动调用读取工具。

Worker `agent_settled` 必定产生直属主管通知。主管正在运行时用 `steer` 合入当前 loop，主管 idle 时用 `prompt` 启动新 loop；短时间内多个子角色报告会批量合并。运行中的 Worker 每 10 分钟重复产生一次巡检通知，直到 settled、被移除或进程退出；没有新 assistant 文本时也明确报告仍在运行。

## 线性上下文上的并发 Boss

共享正式上下文是一条线性、只追加的事件日志。每条事件同时进入可由 `/resume` 发现的 Supervisor 主 Session，并逐条写入项目内的 `events.jsonl`；Team 快照另以原子 `state.json` 保存。多个 Boss 是这条日志不同前缀上的并发分叉，而不是互不相关的新聊天。

```text
E1 用户要求
E2 用户补充
   `- Boss-1 基于 snapshotSeq=2 启动

E3 用户提出另一要求
   `- Boss-2 基于 snapshotSeq=3 启动

E4 Boss-2 发布正式阶段结论
E5 用户继续补充
   `- Boss-3 基于 snapshotSeq=5 启动
```

因此 Boss-3 的正式共享上下文语义上包含 `E1..E5`，包括此前角色明确发布的内容，但不包括它们未发布的私有推理或工具噪声。各角色的模型上下文按 Pi 原生机制正常压缩；共享大群的完整历史独立保留，供用户浏览和角色按需回查。

用户显式决定何时启动新 Boss。新输入不会自动更换负责人：

- `/boss <任务>`：创建新 Boss。
- `/to <agent-id> <消息>`：一次性定向补充或纠正，不改变默认接收者。
- `/focus <boss-id>`：改变后续普通用户输入的默认 Boss。
- `/cancel <agent-or-task-id>`：请求停止指定工作。

停止或纠正旧工作由用户完成：用户切换或定向到原 Boss 后直接发送停止/修改要求，Supervisor 据此调用该 Boss 的 RPC `steer` 或 `abort`。新 Boss 不拥有自动停止旧 Boss 的权限，也不负责推断另一条工作是否已经失效。

## 独立 Pi RPC Session

Boss、部门主管和 Worker 都是独立的持久 Pi Session，使用当前项目的 Pi 默认 Session 目录并以 `Pi Team <agent-id>: ...` 命名，因此可由原生 `/resume` 搜索。旧版自定义目录中的角色 Session 在首次恢复时迁移到原生目录；进程崩溃和 Team 恢复直接续写同一个 Session 文件，不为每次恢复复制新文件。Supervisor 在宿主 `--no-session` 时创建的原生锚点路径随 Team 快照持久化，后续恢复打开同一个锚点。

每个角色必须拥有：

- 不可复用的稳定 `agentId`。
- 独立 `sessionId` 和 session 文件。
- `processEpoch`，用于区分同一 Agent 的重启实例。
- 明确的 `role`、`parentId`、`departmentId` 和 `taskId`。
- 独立 RPC stdin/stdout 和事件订阅。

禁止多个 Pi 进程共同写同一个 Pi Session 文件。共享正式上下文由 Team 插件自己的事件日志提供，不由任何一个角色的 Pi Session 充当。

每个角色在每次 `message_end` 事件时用事件自带的 usage 增量累计输入、输出、缓存读写和费用，随快照持久化；settled 时再读 Session 文件全量对账，把对账差值补进累计，弥补 compaction/branch summary 等不经过消息事件的用量。另外 Team 快照顶层维护一份按 identity（六档内置 + 其他）累计的 `identityUsage`，与角色累计同步更新，角色被移除后仍保留，面板最底部一行展示整个会话的模型开销。面板行使用 `tier in/out/cache $cost` 的紧凑格式并只列有消耗的档位，非 TUI widget 行再做宽度截断，避免长行顶出面板。统计只读 Session 文件，不写回，也不影响角色进程。

RPC 提供：

- `prompt`：空闲时的新要求。
- `steer`：当前 turn 工具批次结束后的普通补充。
- `follow_up`：Agent 完全结束当前工作后的后续任务。
- `abort`：尽力停止当前 agent operation。
- `get_state`、`get_entries(since)`：状态和恢复。
- `message_update`、`tool_execution_*`、`queue_update`、`agent_settled`：观察和生命周期事件。

`abort` 不等于回滚。已经发生的文件、进程、网络、部署或设备副作用需要单独处理。

## 一个独立 Team 插件，按实例角色运行

`pi-team` 是仓库中的独立插件包，与 `goal`、`infinite-retry` 分开安装。Team 包内部使用一个 Pi extension 入口和共享模块：

```text
extensions/pi-team/
  index.ts             唯一 Pi extension 入口
  shared.ts            RPC、事件、身份和公共类型
  package.json         独立安装边界
```

子 Pi 默认正常加载用户已经安装的全局/项目插件、skills、配置和工具。Supervisor 创建角色 RPC Pi 时继续加载同一个 Team 插件，并注入：

- 对应的 Boss、Department Lead 或 Worker role prompt。
- 不可复用的 `agentId + processEpoch + instanceToken` 实例配置。
- 该角色创建时需要的初始共享上下文投影。

```text
主 Pi（无 team instance 配置） -> Supervisor 逻辑
Boss RPC Pi                   -> 同一入口 + Boss 实例配置/prompt
Department Lead RPC Pi        -> 同一入口 + Lead 实例配置/prompt
Worker RPC Pi                 -> 同一入口 + Worker 实例配置/prompt
```

插件根据 Supervisor 显式传入的实例配置注册相应角色逻辑。角色行为由启动时注入的 prompt 定义；IPC 身份由不可复用的实例参数定义。Supervisor 必须验证 `agentId + processEpoch + instanceToken`，普通子进程即使知道角色名称也不能成为团队 Agent。

角色能力：

```text
Boss
  - 请求创建/停止主管
  - 给主管派工
  - 读取主管汇报
  - 主动下钻部门或员工记录
  - 面向用户发布正式回复

Department Lead
  - 请求创建/停止 Worker
  - 查看整个部门
  - 监督、纠正和重新派工
  - 汇总后向 Boss 汇报

Worker
  - 执行自己的任务
  - 向同一 Team 的任意角色提问或发布阶段结果
  - 不得创建其他 Agent
```

真正的进程创建、登记、取消和日志写入只有 Supervisor 可以执行。Boss/主管调用的是结构化请求工具，不能自行 `spawn` 团队角色。

## 消息与事件

Supervisor 是共享事件日志的唯一写入者。角色通过受认证的本机 IPC 向 Supervisor 提交事件请求，Supervisor 分配 `seq` 后串行追加 NDJSON。

建议的最小事件字段：

```ts
type TeamEvent = {
  v: 1;
  teamId: string;
  seq: number;
  eventId: string;
  actorId: string;
  actorEpoch: string;
  type: string;
  targetIds: string[];
  departmentId?: string;
  taskId?: string;
  generation?: number;
  basedOnSeq: number;
  causationId?: string;
  timestamp: string;
  payload: unknown;
};
```

`seq` 只表示 Supervisor 的提交顺序，不等于真实因果顺序、消息处理顺序或结果有效性。结果是否有效由 `taskId + generation + causationId + disposition` 判断。

正式事件至少包括：

- 用户原话和定向消息。
- 角色创建、派工、状态和取消。
- Boss、部门主管和 Worker 的正常 assistant 文本输出。
- 决策、冲突、风险和 artifact 引用。

角色工作时的正常解释、计划和阶段结论默认上屏，不要求模型额外记得调用 `team_publish`。流式文本可以先在对应角色区域实时显示，并在 `message_end` 后作为正式消息落盘。工具调用、工具结果、原始命令输出和模型私有过程不进入正式大群，只进入 Inspector。

## 主 transcript 与 Inspector

UI 把所有正常聊天和执行细节分流：

```text
+--------------------------------+--------------------------+
| 所有角色的正式正常文本         | 被动团队状态 / Inspector |
| 线性进入主 transcript          | 不抢占主输入焦点         |
+--------------------------------+--------------------------+
| 状态栏与主输入框（始终可输入）                            |
+-----------------------------------------------------------+
```

用户始终在主 transcript 看到 Boss、主管和 Worker 的正常文本。底部被动面板只显示角色运行状态；选择角色后显示不含 prompt、回复正文和完整参数的工具生命周期与 RPC 状态。这样不会把正式聊天藏进状态框，也不会让长文本拖累 TUI 渲染。

### 主 transcript

所有角色的 `message_end` 文本作为正式事件按全局序号显示。`/view [limit]` 可查看最近正式事件，`/to <agent-id> <message>` 和完整层级路径都可用于定向消息；这些操作不改变角色权限或上下文投影。

### Agent Inspector

底部 Team 状态按 Boss → Lead → Worker 三层树展示，Lead 行显示直属 Worker 数量。`/cancel` 完成后，目标子树从活动 registry、持久快照、角色列表和该树中移除；角色独立 Session 与正式事件日志继续保留用于审计。选择角色后显示：

- 角色运行状态。
- 工具调用生命周期。
- 命令、测试、diff、文件变化和错误。
- 队列、未读消息和取消状态。

Inspector 内容不自动写入主聊天，也不自动进入任何 Boss 的模型上下文。用户关闭 Inspector 后仍能继续与 focused Boss 对话。

## 建议的初始容量

这些是实现起点，不是已经确认的产品上限：

```yaml
maxBosses: 3
maxLeadsPerBoss: 4
maxWorkersPerLead: 4
maxAgentDepth: 3
```

每个父角色最多有 4 个直接子角色，这是防止失控扩张的安全上限，不是默认数量或利用率目标。一个连贯工作流通常只创建一个 Lead，一个连贯执行任务通常只创建一个 Worker；只有可独立推进且确实缩短关键路径的工作才增加并行角色。首版不为供应商限流增加复杂调度；遇到实际 429 或本机资源问题后再处理。

## 插件命令与角色工具

建议的用户命令：

```text
/team
/boss <任务>
/to <agent-id> <消息>
/focus <boss-id>
/cancel <agent-or-task-id>
/agents
/inspect <agent-id>
/view ...
```

首版的自由文本正文不自动解析任意 `@mention`，避免代码块、邮箱和普通文本误触发路由。角色通过 `team_send` 的结构化 target 寻址：支持稳定 agent id、完整层级路径、这些形式前加 `@`，以及唯一显示名；歧义显示名必须改用 id 或完整路径。普通消息可在同一 Supervisor 所属 Team registry 的任意两个不同成员之间投递。

建议的内部工具：

```text
team_publish
team_send
team_delegate
team_cancel_request
team_read_department
team_read_agent
team_read_events
team_list
```

## 取消与迟到结果

取消分为物理停止、活动组织移除和历史审计：

1. Supervisor 先增加任务 generation 或标记当前 attempt 无效。
2. 禁止该 attempt 的后续结果改变正式状态。
3. 向相关 RPC Pi 发送 `abort`，并按组织关系传播给下属。
4. 等待 `agent_settled` 或进程退出；超时后执行进程树终止。
5. 从活动 registry、持久快照、角色列表和底部树移除目标角色及其后代。
6. 保留独立 Session 和正式事件日志，且后续 `agentId` 不复用。迟到消息仍写入审计记录，但标记为 stale/superseded，默认不上正式主聊天。

采用旧结果必须通过单独的 `result_adopted` 事件，不允许“最后写入者自动获胜”。

## 已接受的运行风险与剩余验证项

### 1. 多 Agent 直接共享工作区

所有角色直接使用当前项目工作区，插件不实现文件 lease、worktree、patch staging 或自动合并。并发读写是明确接受的运行风险；冲突通常会表现为文件内容变化、编辑匹配失败、命令失败、构建/测试失败或 Git diff 异常，由正在工作的 Agent 发现并协调处理。

这意味着插件不保证并发写入的事务性，也不尝试回滚已发生的改动。其职责是提供通信和可观察性，让角色能够发现“另一个 Agent 正在修改这里”并规避后续冲突。

### 2. 模型上下文压缩与群聊留存

各角色的 Pi Session 正常使用 Pi 原生上下文压缩。完整大群历史不必全部留在每个模型 context window 中，但始终保存在 Team 日志中供用户查看，也允许角色主动回查。因此这里不再需要独立设计一套新的上下文压缩算法。

上下文缓存遵循追加式前缀：角色 system prompt、工具集合和既有 Session 历史在同一角色内保持稳定，事件游标只把新正式事件附加到最新 user message，Supervisor 的 `custom` 状态 entry 不进入模型上下文。消息正文只在 `Formal Team events` 注入一次，wake signal 不再重复 Worker report 或定向消息正文。首次 Agent 请求、不同模型档位与角色工具集合、供应商缓存 TTL，以及每轮新增的大段 Worker 输出仍会降低全 Team 汇总命中率，但插件不会主动改写既有前缀。

### 3. 旧 Boss 的停止由用户控制

不实现“新 Boss 自动判断并停止旧 Boss”。用户切换或定向到旧 Boss 后发送停止/修改要求即可；Supervisor 只执行明确控制消息。这样不会产生 Boss 之间的抢权和隐式 supersede 语义。

### 4. 正常文本自动上屏

Boss、主管和 Worker 的正常 assistant 文本默认进入正式大群并显示。工具调用和工具结果不进入群聊，只进入 Inspector。因此不依赖角色额外调用发布工具；内部 `team_publish` 只用于结构化状态、定向消息或需要特殊元数据的事件。

### 5. 主 transcript 与被动侧栏已经实测

所有角色正常文本进入主 transcript。右侧固定状态 widget 和非抢焦点 Inspector 只承载状态与实现细节；真实 ConPTY smoke 已验证窄/宽终端 resize、Inspector 可见时持续输入以及角色消息实时显示。

### 6. RPC 子进程和第三方插件兼容

子 Pi 默认继承用户安装的插件。潜在不兼容项在实际遇到后处理，不作为首版前置阻碍。RPC 客户端仍应正确处理标准 `extension_ui_request`，并把非 JSONL stdout 视为明确错误而不是静默吞掉。

### 7. Windows 进程生命周期

Supervisor 使用 Windows Job Object 管理全部 Boss、主管、Worker 及其后代进程，确保主 Pi 退出或崩溃时统一终止。Node 运行时使用 libuv 为非 detached 子进程提供的进程级 `KILL_ON_JOB_CLOSE` Job；Bun 运行时通过 `bun:ffi` 调用 `kernel32` 创建并绑定等价 Job。真实 smoke 已验证 `pi.cmd`/Node 启动、UTF-8 LF JSONL、正常级联取消，以及只强杀 Supervisor PID 后角色进程自动消失。持久 Session 的 `/resume`、`/fork` 和 crash-recovery 语义仍需继续扩展回归覆盖。

### 8. 角色通过实例配置和 prompt 注入确定

角色 Agent 只由 Supervisor 创建。Supervisor 启动独立 RPC Pi 时加载同一个 Team 插件，并注入 Boss、Lead 或 Worker 的实例配置、role prompt、身份和初始上下文。普通 shell 子进程没有有效实例配置，因此不会错误成为团队角色。

### 9. IPC 身份与权限

Team 插件自行完成 loopback IPC 的随机实例凭据、actor/epoch 校验、消息大小限制和 fail-closed 行为。每个 Supervisor 只持有一个 Team 的 agent registry；普通消息目标必须在该 registry 中唯一解析，跨 Team actor 也无法通过本 server 的 token/epoch 认证。消息权限不会改变委派、取消、状态控制或角色上下文投影。这是实现职责，不是用户侧未决需求。

### 10. 遵循 Pi 原生会话导航语义

团队状态随主 Pi 会话一起遵循原生行为：Team 使用带 `Pi Team: ...` 名称的 Supervisor 主 Session，因此可由 `/resume` 发现；恢复后重建正式群聊、组织结构、上次 focused Boss 和各角色 Session。若宿主使用 `--no-session`，插件创建只承载 Team 快照与正式事件的原生 Session 锚点，避免 Team 成为不可恢复的内存状态。`/reload` 重新加载 Supervisor 和所有角色的 Team 插件逻辑；`/resume` 恢复 Team；`/fork` 复制 Team 前缀；`/new` 创建空 Team。独立 `state.json` 与 `events.jsonl` 在主 Session 缺失或旧版崩溃遗留时提供恢复兜底。

### 11. Inspector 使用非抢焦点 overlay

Inspector 作为 `nonCapturing` overlay，不手工把焦点设为 `null`。真实 TUI smoke 覆盖高频刷新、窄终端 resize、主 transcript 同时更新和 Inspector 可见时持续输入。

### 12. 组织层级会产生协调成本

三层结构能降低 Boss 的监督负担，但每次派工、汇总和转述都会消耗 token 和时间。Boss 和主管处理一次外部事件后必须 settled/idle，不得为了保持活跃而发明工作。相邻子角色报告先合并；正在运行的父角色用 `steer` 接收，idle 父角色才启动新 loop。持久化 `runCount` 只在 RPC `agent_start` 时递增，用于观察真实 loop 数，而不是把一轮内多条 assistant 消息误算为多轮。

### 13. 供应商吞吐

模型供应商和本机资源的吞吐限制客观存在，但不改变本插件的产品设计，首版不为此增加复杂调度。遇到实际 429 或资源争用后再按证据处理。

### 14. 异常退出后主动恢复

团队结构、正式群聊、角色关系和各自 Pi Session 都必须恢复。Supervisor 检测到 Boss、主管或 Worker RPC 进程异常退出、stdout 断开或失去心跳后，应主动执行进程级恢复，而不是只标记中断等待用户处理：

1. 将角色状态标记为 `recovering`，记录旧 `processEpoch` 和最后确认的 Session/event 游标。
2. 使用同一个 `agentId`、同一个持久 Session 和新的 `processEpoch + instanceToken` 重启角色 Pi。
3. 恢复 Team 插件桥接、mailbox 游标和所属任务关系。
4. 向恢复后的角色发送恢复 prompt，说明异常发生、原任务、最后已知正式事件和当前工作区状态。
5. 角色先检查 Session 尾部、文件/Git 状态、已启动进程及任务产物，判断上一次模型/工具调用已经完成、部分完成还是没有发生。
6. 基于检查结果继续未完成目标，并避免盲目重复具有外部副作用的操作。

已安装的重试插件继续负责**进程仍存活时**的模型请求失败、限流和瞬时错误重试；Team 插件负责**RPC 进程级**异常退出和断线恢复。两者职责互补。若重试插件在 RPC 模式下实际不兼容，Team 插件的进程级恢复仍必须独立成立。

单次模型流无法从同一个 token 原地续传，单次工具进程也未必能从原指令位置续跑，但这不妨碍角色自动检查现实状态后继续同一个任务。只有达到有限恢复次数仍反复失败，或无法安全判断副作用时，才将任务标记为 `needs-attention` 并上屏请求用户处理。

## 模型档位池（按业务选模型的中间件）

档位池是给 Boss/Lead 委派时查的“档位 → 模型”选型表，按是否支持视觉 × 高中低共 6 档，只决定新角色用什么模型（价格/能力），不注入任何提示词。映射由用户在项目 `.pi/pi-team/identities.json` 或全局 `~/.pi/agent/pi-team-identities.json` 配置（项目优先，旧 `models.json` 兼容）。不传 `identity` 时新角色默认使用主对话当前模型（所有角色同一模型）；传了才从档位池解析并传 `--model <pattern>` 给子 Pi；未知档位拒绝。档位随 AgentRecord 持久化，恢复时重新解析。目标：规划/审查用深度推理档，简单操作用低价档，视觉调试用视觉档，降低整体 token 用量。

## 建议的实现顺序

1. RPC smoke test：Windows 启动、插件继承、严格 JSONL、独立 Session、steer/abort/settled、父进程清理。
2. Team 插件实例模式：分别验证同一入口在 Supervisor、Boss、Lead、Worker 实例配置下注册正确能力。
3. Supervisor 单写事件日志、身份、IPC、严格 `/to` 和状态恢复。
4. 主聊天正式 entry 与不抢焦点 Inspector 的协议分流。
5. 一个 Boss、一个主管、四个并发 Worker 的完整共享工作区闭环。
6. 多 Boss 在线性上下文不同前缀上的创建、定向纠正和用户控制的停止。
7. 原生 `/reload`、`/resume`、`/fork`、`/new` 团队生命周期，以及角色 RPC 异常退出后的自动重启和任务恢复验证。

## 第一阶段验收

- 用户在一个 Pi TUI 中能持续输入，不被任何单个 Boss/主管/Worker 的运行阻塞。
- 至少一个主管能同时管理 4 个真正并发运行的 Worker，无全局等待屏障。
- 用户能看全部正式群聊，并能在 Inspector 查看任意角色的实现细节而不失去主聊天输入焦点。
- Boss 默认只收到主管汇报，但可主动下钻；主管每次被唤醒时自动收到事件游标之后的完整部门快照。
- Worker 默认只收到定向消息和必要任务内容；Worker settled、crash 和恢复结果必定通知主管，长时间运行时每 10 分钟重复巡检。
- Boss 与主管的实质执行分别委派给最少必要的 Lead 与 Worker；容量上限不会被当作目标填满。
- `/to` 能定向纠正原角色；新 Boss 不会自动抢走或停止旧任务。
- 用户明确停止后，目标角色及其下属收到 RPC abort；已经产生的外部副作用不承诺回滚。
- 每个角色有独立 Pi Session，且继承用户正常安装的插件能力。
- Supervisor 退出时由 Job Object 清理团队子进程；Supervisor/主 Pi 恢复后重建团队结构并主动恢复尚未完成的角色任务。
- 角色 RPC 进程异常退出后使用同一 Session 自动重启，先核对现实状态再继续目标；反复失败或副作用不明时才请求用户介入。
