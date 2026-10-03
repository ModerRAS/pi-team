# Pi Team

> 在一个 Pi TUI 中管理多个独立、持久的 RPC Session，按「Boss → Department Lead → Worker」三层组织并行协作。

用户输入新要求的速度可能长期高于单个 coding agent 的输出速度。Pi Team 在一个项目中横向扩展需求分析、监督与执行能力：多个 Boss 并行承接任务，每个 Boss 下挂多个 Department Lead 持续监督和汇总，每个 Lead 下再挂多个 Worker 执行具体工作——全部共享同一个正式群聊，互不阻塞。

## 特性

- **三层角色模型**：Boss（最多 3 个）→ Department Lead（每个 Boss 最多 4 个）→ Worker（每个 Lead 最多 4 个），所有角色由同一个插件入口实现。
- **独立且持久**：每个角色是独立的 `pi --mode rpc` 进程和 Session，随 Team 快照恢复，旧 Session 自动迁移。
- **一个共享大群**：所有正式消息进入同一个只追加事件日志，各角色按自己的上下文投影消费。
- **模型档位池**：委派时按「是否视觉 × 高中低」6 档选模型，只决定价格/能力，不注入额外提示词。
- **持续监督**：Worker 每 10 分钟触发 Lead 巡检，直到 settled；事件游标让 Lead 无需轮询即可拿到增量消息。
- **token 计量与对账**：每个角色的 token 用量随每次 LLM 调用实时统计，settled 时与 Session 文件对账，随 Team 状态持久化。
- **上下文友好**：system prompt、工具集和历史 Session 追加式保持稳定，定向消息正文只在正式事件中保留一份。
- **交付面可观测**：派发返回事件序号，唤醒时列出「已发出但对方还没有后续动作」的消息；点名了下级却没调用派发工具会被记录；`team_require_artifact` 声明必须落盘的产物，settle 时缺失按硬失败上报；`team_escalate` 让 Lead/Worker 结构化请求缺失的能力。

## 架构

```text
用户
  -> Boss（最多 3 个）
     -> Department Lead（每个 Boss 最多 4 个）
        -> Worker（每个 Lead 最多 4 个）
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

Boss 使用 `team_delegate` 创建 Lead，Lead 使用同一工具创建 Worker；两者还可使用 `team_send`、`team_read`、`team_list` 和 `team_cancel`。`team_cancel` 只能移除直属下属，并级联移除其后代。Worker 完整继承 Pi 的实现工具，在 Team 工具上只保留 `team_send`、`team_models`、`team_read`、`team_list`、`team_escalate` 和 `team_require_artifact`，不能继续委派或移除其他角色。Lead 和 Worker 都能用 `team_escalate` 报告被挡住的能力，用 `team_require_artifact` 声明本轮必须产出的文件。

## 命令一览

| 命令 | 作用 |
| --- | --- |
| `/boss <task>` | 创建并聚焦一个新 Boss |
| `/to <agent-id> <message>` | 定向纠正或补充，不改变当前焦点 |
| `/focus <boss-id>` | 把普通输入路由到指定 Boss |
| `/cancel <agent-id>` | 停止角色及其下属，并从活动 Team、列表和底部面板中移除；独立 Session 与正式事件日志保留用于审计 |
| `/agents` | 查看角色状态 |
| `/view [limit]` | 查看最近正式群聊事件 |
| `/inspect <agent-id>` | 让底部 Inspector 持续显示该角色的运行状态和工具生命周期；`/inspect off` 返回团队状态 |
| `/identities` | 查看当前档位池 |
| `/team` | 查看 Team 摘要、可恢复主 Session 路径和内部 IPC 地址 |

`/new`、`/resume`、`/fork` 是 pi 核心 Session 命令，插件会响应其会话缘由：`/new` 创建空 Team，`/resume` 恢复既有 Team，`/fork` 复制 Team 前缀；树分支切换会停止旧角色并恢复目标分支。

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

- **配置位置**：项目 `.pi/pi-team/identities.json` 优先，其次 `.pi/pi-team/models.json`（旧格式），再次全局 `~/.pi/agent/pi-team-identities.json`；都没有时 `identity` 档位不可用。
- **默认模型**：不传 `identity` 时，新角色直接使用主对话当前模型（所有角色默认同一模型）；传了 `identity` 才从档位池解析模型，未知档位拒绝。
- `/boss --identity <档位> <任务>` 可给 Boss 自己指定档位。
- Lead 创建 Worker 前先调用 `team_models`。普通实现、调查和测试优先 medium，简单、边界明确、低风险任务选 low，只有复杂推理或高难执行才选 high；每个档位中，需要视觉证据时选 vision，否则选 text。Lead 通常选 high（`vision-high` 或 `text-high`）。
- 只能传 `team_models` 实际返回的档位；不要臆造不存在的 identity。
- 模型 pattern 格式与 `pi --model` 一致（`provider/id` 或 `provider/id:thinking`）。档位随 AgentRecord 持久化，重启恢复后重新解析池。

## 设计细节

### 会话与恢复

- Team 有一个带 `Pi Team: ...` 名称的 Supervisor 主 Session，可从 Pi 原生 `/resume` 找到。恢复该 Session 会恢复正式群聊、活动组织结构、上次仍存在的 focused Boss，并用各角色原有 Session 重启所有活动角色；`--no-session` 下创建的锚点路径会写入 Team 快照，后续恢复续写同一个锚点。
- Boss、Lead 和 Worker 的独立 Session 使用 Pi 当前项目的默认原生 Session 目录，并以 `Pi Team <agent-id>: ...` 命名。旧版 `.pi/pi-team/.../agents/.../sessions` 下的角色 Session 会在首次恢复时迁移到原生目录。
- Team 快照原子写入 `.pi/pi-team/<team-storage-id>/state.json`，正式群聊逐条写入同目录 `events.jsonl`；主 Session entry、独立快照和事件日志互为恢复兜底。旧版孤立 Team 由 ephemeral Supervisor 做兼容迁移。

### 事件与协调

- 所有角色直接共享当前工作目录；插件不加锁、不创建 worktree，也不自动合并。
- 所有 Boss、Lead、Worker 的正常文本写入线性正式事件日志并在主 transcript 上屏；底部被动面板只显示角色运行状态。
- Boss 对一组新的、彼此不冲突的任务，默认并行创建对应的 Lead；只有任务确实属于同一个连贯工作流时才使用单个 Lead。
- Boss 与 Lead 是事件驱动协调者，不直接承担实质项目实现；处理当前事件后停止，没有新外部事件时保持 idle。
- Worker 的正常文本实时进入主 transcript；Worker `agent_settled` 后 Supervisor 必定通知直属 Lead。Lead 正在运行时通知用 `steer` 合入当前 loop，idle 时自动改用 `prompt` 启动新 loop；临近报告会批量合并。
- 每次角色被唤醒，Supervisor 自动注入该角色上次事件游标之后、截至本次唤醒的全部可见正式事件；游标随 Team 状态持久化。
- 运行中的 Worker 每 10 分钟触发一次 Lead 巡检并继续重复，直到 Worker settled、被移除或退出。即使区间内没有新 assistant 文本，也会明确报告仍在运行。

### 交付、派发与能力升级

- **产物义务**：Lead/Worker 用 `team_require_artifact { path, note? }` 声明本轮必须存在的产物。`agent_settled` 时 Supervisor 按该角色工作目录解析路径并检查；缺失时不报干净的 idle，而是写入 `kind: "error"` 事件、通知 Lead，并把该角色唤醒一次要求补齐或说明原因；再次 settle 仍缺失则标记 `failed`。全部存在后义务清空，随取消一起失效；义务列表随 Team 状态持久化。
- **派发回执**：`team_send` 返回 `{ delivered, eventId, seq, timestamp }`，正文带上 `#seq`。派发因此可以被引用，「我发出去了」从回忆变成可核对的事实；`delivered` 仍然只表示已写入并尝试唤醒。
- **投递缺口**：唤醒角色时，Supervisor 会列出该角色发出、但目标之后没有任何事件的消息（`#12 -> lead-1 at ...: delivered, no event from the target since`）。这与回执互补：回执说明「确实发出」，这里说明「对方还没有后续动作」，用于判断裁决是否真的送达。
- **决定 ≠ 派发**：Boss/Lead 一轮结束时，如果最后的 assistant 正文提到了直属下级（稳定 agent id 或完整层级路径），而本轮既没调用 `team_send` 也没调用 `team_delegate`，Supervisor 追加一条指向该执行者的 `kind: "error"` 事件并唤醒它一次，要求真的派发或确认只是汇报。同一段正文只提醒一次，避免自唤醒循环。
- **能力升级**：Lead/Worker 用 `team_escalate { reason, needed?, kind? }` 请求 `write`/`code` 能力，Supervisor 追加 `kind: "control"` 事件并唤醒父角色。宿主 Pi 侧的 investigate/写锁由 Pi 自己控制，本插件只负责把「被挡住」结构化上报，不悄悄放开写入。
- **容量拒绝带状态**：达到 4 个直接下级上限时，报错逐个列出下级及其状态并标出可释放的 idle 数量（`lead-1 already has 4 active children: worker-64 (idle), worker-75 (running) — 1 idle may be released via team_cancel`）。idle 在显式 `team_cancel` 之前仍然占位，上限规则不变。
- **委派软提醒**：`team_delegate` 未传 `identity` 时，结果里附一句 `team_models` 提醒，不阻断委派，也不改变默认沿用主模型的行为。

### 计量与 UI

- 每个角色的 token 用量（输入、输出、缓存读写、费用）随每次 LLM 调用实时统计（`message_end` 事件），并在 settled 时与 Session 文件对账；随 Team 状态持久化。底部树和 Inspector 显示为 `in 1.2M out 340k cache 900k $0.42`。
- 面板最底部单独一行按六档 identity 累计整个会话的模型开销，实时更新且不随角色移除而消失；每档压缩为 `text-medium 1.2M/45.0k/900.0k $0.42`（in/out/cache/费用）。
- 底部 Team 面板按 Boss → Lead → Worker 三层树显示，每个角色显示所选档位和实际模型（如 `[text-medium: opencode-go/deepseek-v4-flash]`），未指定档位时显示 `[inherited: provider/model]`。
- 侧栏和 `/agents` 的 `rN` 是持久化 `runCount`，只按真实 RPC `agent_start` 递增。

### 安全与韧性

- Supervisor IPC 只监听 loopback，并验证 `agentId + actorEpoch + instanceToken`。每个 Supervisor 只维护自己的 Team registry；跨 Team 请求无法通过实例认证。
- 意外退出会以新的 epoch/token 从 Session 副本恢复，并要求角色先检查实际工作区状态。
- 委派数量按任务动态决定；4 是安全上限而不是目标。新角色必须有具体的独立工作理由，并优先复用现有合适角色。
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
node crash-smoke.mjs    # Windows 强杀 Supervisor 的 crash clean 验证
```

验证脚本基于真实 `pi --mode rpc` 进程，不依赖 mock。

## 许可

[GPL-3.0](./LICENSE)