# Pi Team

`pi-team` 在一个 Pi TUI 中管理多个独立、持久的 Pi RPC Session：

```text
用户
  -> Boss（最多 3 个）
     -> Department Lead（每个 Boss 最多 4 个）
        -> Worker（每个 Lead 最多 4 个）
```

Supervisor、Boss、Lead 和 Worker 都由同一个插件入口实现。Supervisor 启动子 Pi 时注入内部实例配置；用户不需要也不应该单独安装角色扩展。

## 安装

```bash
pi install /absolute/path/to/ModerPiPlugins/extensions/pi-team
```

安装 `pi-team` 不会安装或加载同仓库的 `goal` 与 `infinite-retry`。

## npm 发布

GitHub Actions 在发布 GitHub Release 时执行 `npm publish`。发布前必须由仓库管理员在 GitHub 网页手动创建 repository secret：进入 **Settings -> Secrets and variables -> Actions -> New repository secret**，名称填写 `NPM_TOKEN`，值填写 npm automation token。不要将 token 写入仓库、工作流或本地配置。

## 命令

- `/boss <task>`：创建并聚焦一个新 Boss；现有 Boss 继续运行。
- `/to <agent-id> <message>`：定向纠正或补充，不改变当前焦点。
- `/focus <boss-id>`：把普通输入路由到指定 Boss。
- `/cancel <agent-id>`：停止角色及其下属，并从活动 Team、列表和底部面板中移除；独立 Session 与正式事件日志保留用于审计。
- `/agents`：查看角色状态。
- `/view [limit]`：查看最近正式群聊事件。
- `/inspect <agent-id>`：让底部被动 Inspector 持续显示该角色的运行状态和工具生命周期；`/inspect off` 返回团队状态。
- `/team`：查看 Team 摘要、可恢复主 Session 路径和内部 IPC 地址。

Boss 使用 `team_delegate` 创建 Lead，Lead 使用同一工具创建 Worker；两者还可使用 `team_send`、`team_read`、`team_list` 和 `team_cancel`。`team_cancel` 只能移除直属下属，并级联移除其后代。Worker 完整继承 Pi 的实现工具；只在 Team 管理权限上受限为 `team_send`、`team_read` 和 `team_list`，不能继续委派或移除其他角色。

`team_send` 的普通消息可发给同一 Pi Team 中任意其他 Boss、Lead 或 Worker。目标支持稳定 agent id、完整层级路径、这些形式前加 `@`，以及唯一显示名；显示名歧义、未知目标和 self-message 都会拒绝。该放宽只适用于消息，不改变委派、取消、角色列表或事件上下文的原有权限。

## 模型档位池（按业务选模型的中间件）

模型档位池是给 Boss/Lead 委派时看的一张“档位 → 模型”选型表：按是否支持视觉 × 高中低共 6 档，委派时选一个档位，只决定新角色用什么模型（价格/能力），不注入任何额外提示词。配置在项目 `.pi/pi-team/identities.json`（`.pi/` 已 gitignore，只在本机生效）：

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

6 个档位即 6 种工作角色，建议用途：`text-high` 规划/审查（深度推理）、`text-medium` 常规执行与 CLI/TUI 调试、`text-low` git 等简单操作、`vision-high` 复杂 GUI 视觉调试、`vision-medium` 常规视觉调试、`vision-low` 简单视觉任务。

- 配置位置：项目 `.pi/pi-team/identities.json` 优先，其次 `.pi/pi-team/models.json`（旧格式），再次全局 `~/.pi/agent/pi-team-identities.json`；都没有时 `identity` 档位不可用。
- 默认模型：不传 `identity` 时，新角色直接使用主对话当前模型（所有角色默认同一模型）；传了 `identity` 才从档位池解析模型，未知档位拒绝。
- `/boss --identity <档位> <任务>` 可给 Boss 自己指定档位。
- Boss 创建 Lead 前先调用 `team_models`。Lead 通常选 high：需要查看图片、截图、视频、GUI 状态或其他视觉证据时选 `vision-high`，否则选 `text-high`。
- Lead 创建 Worker 前先调用 `team_models`。普通实现、调查和测试优先 medium，简单、边界明确、低风险任务选 low，只有复杂推理或高难执行才选 high；每个档位中，需要视觉证据时选 vision，否则选 text。
- 只能传 `team_models` 实际返回的档位；不要臆造不存在的 identity。
- 模型 pattern 格式与 `pi --model` 一致（`provider/id` 或 `provider/id:thinking`）。档位会随 AgentRecord 持久化，重启恢复后重新解析池。
- 兼容：旧 `models.json`（档位 → 模型）仍会读取，`identities.json` 优先。

## 行为

- Team 有一个带 `Pi Team: ...` 名称的 Supervisor 主 Session，可从 Pi 原生 `/resume` 找到。恢复该 Session 会恢复正式群聊、活动组织结构、上次仍存在的 focused Boss，并用各角色原有 Session 重启所有活动角色；`--no-session` 下创建的锚点路径会写入 Team 快照，后续恢复续写同一个锚点，不再重复创建。
- Boss、Lead 和 Worker 的独立 Session 使用 Pi 当前项目的默认原生 Session 目录，并以 `Pi Team <agent-id>: ...` 命名，可在 `/resume` 中搜索。旧版位于 `.pi/pi-team/.../agents/.../sessions` 的角色 Session 会在首次恢复时迁移到原生目录，进程恢复继续写同一个文件。
- Team 快照会原子写入 `.pi/pi-team/<team-storage-id>/state.json`，正式群聊逐条写入同目录的 `events.jsonl`；主 Session entry、独立快照和事件日志互为恢复兜底。旧版只留下 `instance.json`、角色 Session 和 `events.jsonl` 的孤立 Team 会由 ephemeral Supervisor 做兼容迁移。
- 所有角色直接共享当前工作目录；插件不加锁、不创建 worktree，也不自动合并。
- 每个角色是独立的 `pi --mode rpc` 进程和 Session，并继承用户正常安装的资源。
- 所有 Boss、Lead、Worker 的正常文本都写入线性正式事件日志并在主 transcript 上屏；底部被动面板只显示角色运行状态，不重复显示 prompt 或消息正文。
- Boss 对一组新的、彼此不冲突的任务，默认并行创建对应的 Lead；只有任务确实属于同一个连贯工作流时才使用单个 Lead。
- 除非用户明确说“停止”、“暂停”或“替换”，不得取消已有 Team 或其角色。
- Boss 与 Lead 是事件驱动协调者，不直接承担实质项目实现：Boss 把一个连贯工作流交给一个 Lead，Lead 把一个连贯执行任务交给一个 Worker；只有真正独立的领域或并行任务才增加角色。处理当前事件后停止，没有新外部事件时保持 idle。
- Worker 的正常文本实时进入主 transcript；Worker `agent_settled` 后 Supervisor 必定通知直属 Lead。Lead 正在运行时通知用 `steer` 合入当前 loop，Lead idle 时自动改用 `prompt` 启动新 loop；临近报告会批量合并。
- 每次角色被唤醒，Supervisor 自动注入该角色上次事件游标之后、截至本次唤醒的全部可见正式事件。Lead 因此无需主动轮询也能拿到期间所有直属 Worker 消息；游标随 Team 状态持久化。
- 底部 Team 面板按 Boss → Lead → Worker 三层树显示，Lead 行直接标出直属 Worker 数量；每个角色同时显示所选档位和实际模型，例如 `[text-medium: opencode-go/deepseek-v4-flash]`，未指定档位时显示 `[inherited: provider/model]`；被移除角色不再占用面板。
- 运行中的 Worker 每 10 分钟触发一次 Lead 巡检并继续重复，直到 Worker settled、被移除或退出。即使区间内没有新 assistant 文本，也会明确报告仍在运行。
- 每个角色在其 Session 文件中的 token 用量（输入、输出、缓存读写、费用）随每次 LLM 调用实时统计（`message_end` 事件），并在 settled 时与 Session 文件对账；随 Team 状态持久化。底部树和 Inspector 显示为 `in 1.2M out 340k cache 900k $0.42`，恢复后沿用累计值。
- 面板最底部单独一行按六档 identity（text/vision × high/medium/low）累计整个会话的模型开销，实时更新且不随角色移除而消失；只显示实际有消耗的档位，每档压缩为 `text-medium 1.2M/45.0k/900.0k $0.42`（in/out/cache/费用）避免撑出面板。
- 侧栏和 `/agents` 的 `rN` 是持久化 `runCount`，只按真实 RPC `agent_start` 递增，用于区分一轮内的多条 assistant 消息与多次 agent loop。
- 委派数量按任务动态决定；4 是安全上限而不是目标。新角色必须有具体的独立工作理由，并优先复用现有合适角色。
- Supervisor IPC 只监听 loopback，并验证 `agentId + actorEpoch + instanceToken`。每个 Supervisor 只维护自己的 Team registry；跨 Team 请求无法通过实例认证，已认证请求也只能解析本 registry 内的目标。
- 意外退出会以新的 epoch/token 从 Session 副本恢复，并要求角色先检查实际工作区状态。
- `/new` 创建空 Team；`/resume` 恢复 Team；`/fork` 复制 Team 前缀；树分支切换会停止旧角色并恢复目标分支。

## 上下文缓存

- 各角色的 system prompt、工具集合和历史 Session 都按追加方式保持稳定；事件游标只把新正式事件追加到最新 user message，不会重写已有历史前缀。Supervisor 的 `custom` Team 状态 entry 不进入 LLM context。
- 定向消息、Worker 报告、settled 和巡检通知的正文只保留在 `Formal Team events` 一份；wake signal 只发送短提示，避免同一正文在单次 prompt 尾部重复两次。
- 首次启动的新 Agent 没有可复用历史；不同模型档位、不同角色工具集合、模型供应商缓存 TTL，以及一次唤醒中新增加的大段 Worker 输出，仍会自然降低跨整个 Team 汇总后的缓存命中率。

## 当前限制

Windows 角色进程属于 `KILL_ON_JOB_CLOSE` Job Object：Node 运行时使用 libuv 的进程级 Job，Bun 运行时通过 `bun:ffi` 显式调用 `kernel32` 创建 Job。正常取消仍调用 `taskkill /T /F` 以立即等待完整进程树退出。真实 crash smoke 已验证只强杀 Supervisor PID 后 Boss 自动终止。底部面板目前是固定状态 widget，Inspector 复用该区域显示运行细节。

完整协议、状态模型和设计取舍见 [DESIGN.md](./DESIGN.md)。
