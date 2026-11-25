---
name: pi-subagents
description: Launches one isolated Pi subagent in the foreground or as a detached job, with per-agent defaults, optional overrides, completion pings, result collection, and cancellation. Use for codebase reconnaissance or retrieval from prior session history.
---

# Pi Subagents

This skill is for the parent orchestrator. Subagents must not recursively delegate unless the user explicitly requests it.

Agents are discovered automatically from `~/.pi/agent/agents/*.md` and the nearest `.pi/agents/*.md` directory found by walking upward from the parent session's cwd. No discovery scope is passed in the tool call. Global definitions win on duplicate names; rename a project agent instead of shadowing a global one.

## Start

List available agents in an unfamiliar session:

```typescript
subagent({ action: "list" })
```

Each execution accepts exactly one `agent` and one `task`:

```typescript
subagent({
  agent: "scout",
  task: "Map the authentication flow. Return exact files, symbols, and risks."
})
```

Agent frontmatter can provide `model`, `thinking`, `cwd`, and `tools`. Per-call `model`, `thinking`, and `cwd` override those defaults.

Use `noExtensions: true` when the child Pi process must start with `--no-extensions`:

```typescript
subagent({
  agent: "scout",
  task: "Inspect the repository without loading Pi extensions.",
  noExtensions: true
})
```

`noExtensions` disables extension discovery only; it does not disable skills or context files.

Thinking levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.

## Background jobs

Use `async: true` for independent work. It returns a persistent job ID immediately. Completion pings the originating parent session by default; set `ping: false` to disable that message.

```typescript
subagent({
  agent: "scout",
  task: "Map the authentication flow.",
  async: true,
  ping: true
})
```

Do not sleep or repeatedly poll. Use management actions only when needed:

```typescript
subagent({ action: "status", id: "<job-id>" })
subagent({ action: "result", id: "<job-id>" })
subagent({ action: "cancel", id: "<job-id>" })
```

Each child run is persisted as a normal named Pi session. Background artifacts are stored under `~/.pi/agent/subagent-jobs/<id>/`.

The tool has no `tasks`, `chain`, `agentScope`, or `confirmProjectAgents` parameters. Launch separate calls when more than one independent investigation is needed. Project definitions are repository-controlled prompts, so invoke them only in trusted repositories.
