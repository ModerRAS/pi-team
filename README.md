# Pi Team

> 在一个 Pi TUI 中管理多个独立、持久的 RPC Session，按「Boss → Department Lead → Worker」三层组织并行协作。

用户输入新要求的速度可能长期高于单个 coding agent 的输出速度。Pi Team 在一个项目中横向扩展需求分析、监督与执行能力：多个 Boss 并行承接任务，每个 Boss 下挂多个 Department Lead 持续监督和汇总，每个 Lead 下再挂多个 Worker 执行具体工作——全部共享同一个正式群聊，互不阻塞。

## 特性

- **三层角色模型**：Boss（最多 3 个，硬上限）→ Department Lead（每个 Boss 建议 4 个）→ Worker（每个 Lead 建议 4 个），所有角色由同一个插件入口实现；Lead/Worker 的 4 是软限制，超出只回一条容量提醒，不阻断委派。
- **独立且持久**：每个角色是独立的 `pi --mode rpc` 进程和 Session，随 Team 快照恢复，旧 Session 自动迁移。
- **一个共享大群**：所有正式消息进入同一个只追加事件日志，各角色按自己的上下文投影消费。
- **模型档位池**：委派时按「是否视觉 × 高中低」6 档选模型，只决定价格/能力，不注入额外提示词。
- **持续监督**：Worker 每 10 分钟触发 Lead 巡检，直到 settled；事件游标让 Lead 无需轮询即可拿到增量消息。
- **token 计量与对账**：每个角色的 token 用量随每次 LLM 调用实时统计，settled 时与 Session 文件对账，随 Team 状态持久化。
- **上下文友好**：system prompt、工具集和历史 Session 追加式保持稳定，定向消息正文只在正式事件中保留一份。
- **状态查询不重复 brief**：`team_list` 默认只返回状态（id、角色、状态、档位、最后活动时间、任务首行摘要），需要完整 brief 时才用 `mode: "full"`；一次状态轮询的开销不再随 brief 长度增长。
- **交付面可观测**：派发返回事件序号，唤醒时列出「已发出但对方还没有后续动作」的消息；点名了下级却没调用派发工具会被记录；`team_require_artifact` 声明必须落盘的产物，settle 时缺失按硬失败上报；`team_escalate` 让 Lead/Worker 结构化请求缺失的能力。

## 架构

```text
用户
  -> Boss（最多 3 个）
     -> Department Lead（每个 Boss 建议 4 个，软限制）
        -> Worker（每个 Lead 建议 4 个，软限制）
```

插件内部还有一个不属于组织层级的 **Supervisor**（控制面）：负责角色身份与权限、RPC 子进程生命周期、共享事件日志的唯一写入、消息投递、配额与取消，以及主群聊与 Inspector UI。

Supervisor 启动子 Pi 时注入内部实例配置；用户不需要也不应该单独安装角色扩展。完整协议、状态模型与设计取舍见 [DESIGN.md](./DESIGN.md)。

## 安装

```bash
pi install git:github.com/ModerRAS/pi-team
```

也可以用本地路径安装：`pi install /absolute/path/to/ModerPiPlugins/extensions/pi-team`。

安装 `pi-team` 不会安装或加载同仓库的 `goal` 与 `infinite-retry`。

## 快速开始

```text
/boss 实现登录页               <- 创建并聚焦一个新 Boss，现有 Boss 继续运行
/agents                        <- 查看角色状态
/to <agent-id> 这里改一下       <- 定向纠正或补充，不改变当前焦点
/focus <boss-id>               <- 把普通输入路由到指定 Boss
/cancel <agent-id>             <- 停止角色及其下属
/team                          <- Team 摘要、可恢复 Session 路径和内部 IPC 地址
```

Boss 使用 `team_delegate` 创建 Lead，Lead 使用同一工具创建 Worker；两者还可使用 `team_send`、`team_read`、`team_list` 和 `team_cancel`。`team_list` 默认返回状态行（`mode: "status"`），只有显式传 `mode: "full"` 才包含每个角色的完整 brief。`team_cancel` 只能移除直属下属，并级联移除其后代。Worker 完整继承 Pi 的实现工具，在 Team 工具上只保留 `team_send`、`team_models`、`team_read`、`team_list`、`team_escalate` 和 `team_require_artifact`，不能继续委派或移除其他角色。Lead 和 Worker 都能用 `team_escalate` 报告被挡住的能力，用 `team_require_artifact` 声明本轮必须产出的文件。

## 命令一览

| 命令 | 作用 |
| --- | --- |
| `/boss <task>` | 创建并聚焦一个新 Boss |
| `/to <agent-id> <message>` | 定向纠正或补充，不改变当前焦点 |
| `/focus <boss-id>` | 把普通输入路由到指定 Boss |
| `/cancel <agent-id>` | 停止角色及其下属，并从活动 Team、列表和底部面板中移除；独立 Session 与正式事件日志保留用于审计 |
| `/team-restore [storageId] [force]` | 采用工作区持久化的 Team（默认注册表，可指定 storage 目录）并重启其角色，不依赖 pi 原生会话链；Team 还被另一个 Supervisor 持有时默认拒绝，加 `force` 会终止那个 Supervisor 再接管 |
| `/agents` | 查看角色状态 |
| `/view [limit]` | 查看最近正式群聊事件 |
| `/inspect <agent-id>` | 让底部 Inspector 持续显示该角色的运行状态和工具生命周期；`/inspect off` 返回团队状态 |
| `/identities` | 查看当前档位池 |
| `/team` | 查看 Team 摘要、当前注册表目录、可恢复 Session 路径、内部 IPC 地址和可恢复的旧 Team |

`/new`、`/resume`、`/fork` 是 pi 核心 Session 命令，插件会响应其会话缘由：`/resume`、`/reload` 和树分支切换按「当前会话快照 → 工作区注册表」重建同一个 Team；`/new` 的新会话本身没有 Team，会接管工作区注册表中的活动 Team（同一 workspace 只维护一个活动 Team），需要一份干净 Team 时先 `/cancel` 掉现有角色；`/fork` 复制 Team 前缀并分配新 `teamId`。上面两种自动接管都受 24 小时活跃窗口和 `/alive` 探测限制；`/team-restore` 可在任何时候显式接管注册表里的 Team。

`team_send` 的普通消息可发给同一 Pi Team 中任意其他 Boss、Lead 或 Worker。目标支持稳定 agent id、完整层级路径、这些形式前加 `@`，以及唯一显示名；显示名歧义、未知目标和 self-message 都会拒绝。该放宽只适用于消息，不改变委派、取消、角色列表或事件上下文的原有权限。

## 配置：模型档位池

模型档位池是给 Boss/Lead 委派时看的一张「档位 → 模型」选型表：按是否支持视觉 × 高中低共 6 档，委派时选一个档位，只决定新角色用什么模型（价格/能力），不注入任何额外提示词。配置在项目 `.pi/pi-team/identities.json`（`.pi/` 已 gitignore，只在本机生效）：

```json
{
  "text-high": "opencode-go/deepseek-v4-pro",
  "text-medium": "opencode-go/deepseek-v4-flash",
  "text-low": "opencode-go/deepseek-v4-flash",
  "vision-high": "opencode-go/gpt-5.6-luna",
  "vision-medium": "opencode-go/kimi-k2.7-code",
  "vision-low": "opencode-go/mimo-v2.5"
}
```

6 个档位即 6 种工作角色，建议用途：

| 档位 | 建议用途 |
| --- | --- |
| `text-high` | 规划/审查（深度推理） |
| `text-medium` | 常规执行与 CLI/TUI 调试 |
| `text-low` | git 等简单操作 |
| `vision-high` | 复杂 GUI 视觉调试 |
| `vision-medium` | 常规视觉调试 |
| `vision-low` | 简单视觉任务 |

- **配置位置**：项目 `.pi/pi-team/identities.json` 优先，其次 `.pi/pi-team/models.json`（旧格式），再次全局 `~/.pi/agent/pi-team-identities.json`；都没有时只有内置档位 `inherited` 可用。
- **内置档位 `inherited`**：永远可用，表示「主对话当前模型」。不配置档位池时，`team_models` 只返回这一行（带主模型 pattern），委派时传 `identity: "inherited"` 与不传 `identity` 完全等价——两者都会用主模型 spawn，只是前者是显式、可写入记录的写法。只需要一个模型时不要写六个相同档位，留空用 `inherited` 即可；如果所有档位都指向同一个模型，`team_models` 会提示改用 `inherited`。显式在档位池里定义 `inherited` 会覆盖内置含义。
- **默认模型**：不传 `identity` 时，新角色直接使用主对话当前模型（所有角色默认同一模型）；传了 `identity` 才从档位池解析模型，未知档位拒绝（错误会提示可用的 `inherited`）。
- `/boss --identity <档位> <任务>` 可给 Boss 自己指定档位。
- Lead 创建 Worker 前先调用 `team_models`。普通实现、调查和测试优先 medium，简单、边界明确、低风险任务选 low，只有复杂推理或高难执行才选 high；每个档位中，需要视觉证据时选 vision，否则选 text。Lead 通常选 high（`vision-high` 或 `text-high`）。
- 只能传 `team_models` 实际返回的档位；不要臆造不存在的 identity。`inherited` 虽然不来自档位池配置，但始终有效，且 `team_models` 会把它列出来。
- 模型 pattern 格式与 `pi --model` 一致（`provider/id` 或 `provider/id:thinking`）。档位随 AgentRecord 持久化，重启恢复后重新解析池。

## 设计细节

### 会话与恢复

- **自持 Team 注册表**：`<项目>/.pi/pi-team/latest.json` 是一份完整的 Team 快照（`storageId`、`teamId`、`focusedBossId`、`nextAgentIndexes`、`identityUsage`、`updatedAt`、自己的 loopback `supervisorUrl`，以及每个角色的 `parentId` / `role` / `task` / `identity` / `sessionPath`）。它不是指针也不是 pi Session 的副本，而是插件自己的结构链权威来源，每次 Team 状态变化都原子重写。
- **不依赖 pi 自带会话**：启动、`/resume`、`/reload`、`/new`、`/fork` 或树分支切换时，当前会话自己携带的 Team 快照优先；当前会话没有任何 Team 时，插件直接读工作区注册表重建整棵树（Boss → Lead → Worker）和 focused Boss，不需要 pi 原生 Session 里有对应的 entry。`--no-session` 运行也走同一条路径；`/fork` 仍是复制前缀语义，会分配新的 `teamId`。
- **角色自己的会话路径**：每个角色的绝对 `sessionPath` 同时写进注册表和 `agents/<agent-id>/instance.json`，恢复时用 `--session <path>` 续写同一个角色 Session；因此角色历史与组织结构不会因为丢了 `state.json` 一起丢。
- **自动恢复有边界**：只有最近 24 小时内活跃过、并且没有第二个 Supervisor 仍在跑这个 Team 时才会自动接管；否则只写一条提示并保持空 Team，由用户决定是否恢复。过老的快照（包括旧版本用 `instance.json` 重建出来的、没有时间戳的快照）不会被自动复活，避免启动时凭空拉起一堆无意义的角色进程。
- **`/team-restore` 手动接管**：`/team-restore [storageId] [force]` 显式采用工作区里持久化的 Team 并重启所有角色（不传参数用注册表，传参数指定某个 storage 目录）。如果探测到另一个 Supervisor 仍在跑这个 Team，默认只提示并拒绝（`stop it there first, or run /team-restore force`）；加 `force` 才先终止那个 Supervisor 的进程树、再接管，不需要用户手动找进程。
- **避免双开 Supervisor**：接管前会向快照里记录的 loopback 地址发一个 `/alive` 探测（只回自己的 pid 和 teamId，不做认证）。探测到另一个 Supervisor 仍在跑同一个 Team 时不接管，只写一条提示；端口或 PID 被复用无法伪造成这个应答，而 `/reload` 造成的同进程重入会被 pid 比对排除。 `/team-restore` 前的终止也只信任这个应答，不会因为快照里一个被复用的 PID 去杀死无关进程。
- **多层兜底**：注册表 → 同目录 `state.json` → 旧版 `latest.json` 指针 → 目录扫描 → `agents/<id>/instance.json` + `events.jsonl`（丢失 `state.json` 时从每个角色的实例配置和取消事件重建层级）→ 角色自己的 Pi Session 文件。逐层降级只损失历史，不损失结构。
- Team 的 Supervisor 主 Session 仍以 `Pi Team: ...` 命名，可从 pi 原生 `/resume` 找到；`--no-session` 下创建的锚点路径写入快照，后续恢复续写同一个锚点。

### 事件与协调

- 所有角色直接共享当前工作目录；插件不加锁、不创建 worktree，也不自动合并。
- 所有 Boss、Lead、Worker 的正常文本写入线性正式事件日志并在主 transcript 上屏；底部被动面板只显示角色运行状态。
- Boss 对一组新的、彼此不冲突的任务，默认并行创建对应的 Lead；只有任务确实属于同一个连贯工作流时才使用单个 Lead。
- Boss 与 Lead 是事件驱动协调者，不直接承担实质项目实现；处理当前事件后停止，没有新外部事件时保持 idle。
- Worker 的正常文本实时进入主 transcript；Worker `agent_settled` 后 Supervisor 必定通知直属 Lead。Lead 正在运行时通知用 `steer` 合入当前 loop，idle 时自动改用 `prompt` 启动新 loop；临近报告会批量合并。
- 每次角色被唤醒，Supervisor 自动注入该角色上次事件游标之后、截至本次唤醒的全部可见正式事件；游标随 Team 状态持久化。
- 运行中的 Worker 每 10 分钟触发一次 Lead 巡检并继续重复，直到 Worker settled、被移除或退出。即使区间内没有新 assistant 文本，也会明确报告仍在运行。

### 交付、派发与能力升级

- **事件不携带 brief 正文**：`started` 事件、`assignment` 事件和 `team_delegate` 的返回值只带身份、状态和出处（`"任务首行摘要" (brief N chars, <instance.json 路径>)`）。完整正文只存在于三处：委派方自己的工具调用历史、`state.json` / `agents/<id>/instance.json`、以及子角色 Session；子角色的 system prompt 是它的唯一权威副本，首次/恢复唤醒提示不再重复一遍。需要引用某次派发时用回执里的 `#seq`。
- **产物义务**：Lead/Worker 用 `team_require_artifact { path, note? }` 声明本轮必须存在的产物。`agent_settled` 时 Supervisor 按该角色工作目录解析路径并检查；缺失时不报干净的 idle，而是写入 `kind: "error"` 事件、通知 Lead，并把该角色唤醒一次要求补齐或说明原因；再次 settle 仍缺失则标记 `failed`。全部存在后义务清空，随取消一起失效；义务列表随 Team 状态持久化。
- **派发回执**：`team_send` 与 `team_delegate` 都返回 `{ delivered, eventId, seq, timestamp }`，正文带上 `#seq`。派发因此可以被引用，「我发出去了」从回忆变成可核对的事实；`delivered` 仍然只表示已写入并尝试唤醒。
- **投递缺口**：唤醒角色时，Supervisor 会列出该角色发出、但目标之后没有任何事件的消息（`#12 -> lead-1 at ...: delivered, no event from the target since`）。这与回执互补：回执说明「确实发出」，这里说明「对方还没有后续动作」，用于判断裁决是否真的送达。
- **决定 ≠ 派发**：Boss/Lead 一轮结束时，如果最后的 assistant 正文提到了直属下级（稳定 agent id 或完整层级路径），而本轮既没调用 `team_send` 也没调用 `team_delegate`，Supervisor 追加一条指向该执行者的 `kind: "error"` 事件并唤醒它一次，要求真的派发或确认只是汇报。同一段正文只提醒一次，避免自唤醒循环。
- **能力升级**：Lead/Worker 用 `team_escalate { reason, needed?, kind? }` 请求 `write`/`code` 能力，Supervisor 追加 `kind: "control"` 事件并唤醒父角色。宿主 Pi 侧的 investigate/写锁由 Pi 自己控制，本插件只负责把「被挡住」结构化上报，不悄悄放开写入。
- **容量软提醒**：直接下级超过 4 个时委派仍然成功，只在 `team_delegate` 结果里附一条带状态明细的提醒（`lead-1 now has 5 active children, past the soft limit of 4: worker-64 (idle), worker-75 (running) — 1 idle may be released via team_cancel. The role was created; ...`）。空闲角色在显式 `team_cancel` 之前仍然占位，提醒只影响模型的后续判断，不再拒绝创建。
- **委派软提醒**：`team_delegate` 未传 `identity` 时，结果里附一句 `team_models` 提醒，不阻断委派，也不改变默认沿用主模型的行为。

### 计量与 UI

- 每个角色的 token 用量（输入、输出、缓存读写、费用）随每次 LLM 调用实时统计（`message_end` 事件），并在 settled 时与 Session 文件对账；随 Team 状态持久化。底部树和 Inspector 显示为 `in 1.2M out 340k cache 900k $0.42`。
- 面板最底部单独一行按六档 identity 累计整个会话的模型开销，实时更新且不随角色移除而消失；每档压缩为 `text-medium 1.2M/45.0k/900.0k $0.42`（in/out/cache/费用）。
- 底部 Team 面板按 Boss → Lead → Worker 三层树显示，每个角色显示所选档位和实际模型（如 `[text-medium: opencode-go/deepseek-v4-flash]`），未指定档位时显示 `[inherited: provider/model]`。
- 侧栏和 `/agents` 的 `rN` 是持久化 `runCount`，只按真实 RPC `agent_start` 递增。

### 安全与韧性

- Supervisor IPC 只监听 loopback，并验证 `agentId + actorEpoch + instanceToken`。每个 Supervisor 只维护自己的 Team registry；跨 Team 请求无法通过实例认证。
- 意外退出会以新的 epoch/token 从 Session 副本恢复，并要求角色先检查实际工作区状态。
- 委派数量按任务动态决定；4 是软限制和提醒线而不是目标。新角色必须有具体的独立工作理由，并优先复用现有合适角色；超出后仍可继续委派，但每次都会收到容量提醒。
- 派发检查只看正文里的 agent id / 层级路径，不做中文祈使句判断：只是提到某个下级会被误报，指令里没写 id 会被漏报。误报只多一次提醒（同一段正文不重复），真实语义判断仍由模型负责。
- 除非用户明确说「停止」「暂停」或「替换」，不得取消已有 Team 或其角色。

### 上下文缓存

- 各角色的 system prompt、工具集合和历史 Session 都按追加方式保持稳定；事件游标只把新正式事件追加到最新 user message，不会重写已有历史前缀。Supervisor 的 `custom` Team 状态 entry 不进入 LLM context。
- 定向消息、Worker 报告、settled 和巡检通知的正文只保留在 `Formal Team events` 一份；wake signal 只发送短提示。
- 首次启动的新 Agent 没有可复用历史；不同模型档位、不同角色工具集合、模型供应商缓存 TTL，以及一次唤醒中新增加的大段 Worker 输出，仍会自然降低跨整个 Team 汇总后的缓存命中率。

## 当前限制

Windows 角色进程属于 `KILL_ON_JOB_CLOSE` Job Object：Node 运行时使用 libuv 的进程级 Job，Bun 运行时通过 `bun:ffi` 显式调用 `kernel32` 创建 Job。正常取消仍调用 `taskkill /T /F` 以立即等待完整进程树退出。真实 crash smoke 已验证只强杀 Supervisor PID 后 Boss 自动终止。底部面板目前是固定状态 widget，Inspector 复用该区域显示运行细节。

## 开发

```bash
npm test                # runtime 单元测试（node --test）
node smoke.mjs          # RPC 端到端 smoke（临时目录，spawn pi --mode rpc）
node recovery-smoke.mjs # 注册表恢复 / 双开保护 / /team-restore 接管 / 过老快照不自动恢复
node crash-smoke.mjs    # Windows 强杀 Supervisor 的 crash clean 验证
```

验证脚本基于真实 `pi --mode rpc` 进程，不依赖 mock。

## 许可

[GPL-3.0](./LICENSE)