# Pi Subagents

A [Pi](https://pi.dev) extension based on Pi's official subagent example, extended with persistent background jobs and completion notifications. It runs one delegated task in an isolated Pi process, with foreground execution, child session persistence, model/thinking/cwd defaults, extension-free child launches, result retrieval, and cancellation.

## Installation

```bash
pi install git:github.com/m4staka/pi-subagents
```

Reload an active Pi session with `/reload`. Agent definitions are discovered separately; copy the included [`agents/scout.md`](agents/scout.md) to `~/.pi/agent/agents/scout.md` or create your own definition as described below.

## Usage

List automatically discovered global and project-local agents:

```typescript
subagent({ action: "list" })
```

Run one agent in the foreground:

```typescript
subagent({
  agent: "scout",
  task: "Inspect authentication and identify the race condition."
})
```

Override agent defaults when necessary:

```typescript
subagent({
  agent: "scout",
  task: "Inspect authentication.",
  model: "openai-codex/gpt-5.6-luna",
  thinking: "high",
  cwd: "/absolute/path/to/project",
  noExtensions: true
})
```

`noExtensions: true` passes `--no-extensions` to the child Pi process. It disables extension discovery, but not skills or context files.

## Background jobs

```typescript
subagent({
  agent: "scout",
  task: "Map the authentication flow.",
  async: true,
  ping: true
})
```

The call returns a job ID immediately. Job artifacts are stored under `~/.pi/agent/subagent-jobs/<job-id>/`; completion pings the originating parent session by default.

```typescript
subagent({ action: "status", id: "<job-id>" })
subagent({ action: "result", id: "<job-id>" })
subagent({ action: "cancel", id: "<job-id>" })
```

Do not repeatedly poll an async job. Set `ping: false` when no completion message is wanted.

## Tool parameters

| Parameter | Purpose |
|---|---|
| `agent` | Discovered global or project-local agent name |
| `task` | Delegated prompt |
| `model` | Optional per-call model override |
| `thinking` | Optional override: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` |
| `cwd` | Optional child working-directory override |
| `noExtensions` | Launch child Pi with `--no-extensions` |
| `async` | Start a detached persistent job |
| `ping` | Ping the parent on async completion; defaults to `true` |
| `action` | `list`, `status`, `result`, or `cancel` |
| `id` | Background job ID for management actions |

The execution API intentionally has no `tasks`, `chain`, `agentScope`, or `confirmProjectAgents` parameters. Invoke separate tool calls for separate tasks.

## Agent definitions

Agents are Markdown files in `~/.pi/agent/agents/*.md`:

```markdown
---
name: my-agent
description: Explains when this agent should be used
model: openai-codex/gpt-5.6-luna
thinking: high
cwd: /absolute/default/working/directory
tools: read, grep, find, ls
---

You are a focused code investigator.
```

Supported frontmatter fields:

- `name` — required
- `description` — required
- `model` — optional default model
- `thinking` — optional default thinking level
- `cwd` — optional default child working directory
- `tools` — optional comma-separated string or YAML list

The Markdown body is the delegated system prompt. Per-call `model`, `thinking`, and `cwd` override frontmatter defaults.

The tool always discovers both `~/.pi/agent/agents/*.md` and the nearest `.pi/agents/*.md` found by walking upward from the parent session's cwd. There is no scope parameter. Global definitions win when a project definition uses the same name; `action: "list"` reports ignored duplicates. This prevents a repository from silently shadowing a known global agent. Project definitions are repository-controlled prompts and should only be invoked in trusted repositories.

## Sessions and persistence

Every child run is saved as a normal named Pi session and can be found with `/resume`. Background jobs additionally persist `request.json`, `status.json`, `result.json`, runner diagnostics, and materialized system prompts.

Terminal states are `completed`, `failed`, and `canceled`.

## Tests

```bash
npm test
```

The deterministic suite covers foreground and detached execution, model/thinking/tools/cwd propagation, `--no-extensions`, session persistence, completion management, cancellation, and failure persistence.

Real provider tests may incur usage costs:

```bash
npm run test:real
```

## Origin

Based on [Pi's official subagent example](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/examples/extensions/subagent) by Mario Zechner and contributors, licensed under [MIT](https://github.com/badlogic/pi-mono/blob/main/LICENSE). Detached jobs, parent completion pings, explicit overrides, native child sessions, and the simplified single-agent API are local changes.

## License

[MIT](LICENSE), including the original copyright notice and attribution for m4staka's modifications.
