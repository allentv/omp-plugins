# omp-skill-discovery

Lazy-load skills on demand for [OMP](https://github.com/can1357/oh-my-pi).

## Features

- **Compact skill index** — scans skill directories once at startup, shared across all sessions and sub-agents in the same OMP instance
- **`skill_search` tool** — search skills by name or description keywords with relevance scoring
- **Lightweight prompt injection** — replaces the full skill list with a compact `<skill-index>` block in the system prompt
- **Read observability** — tracks `skill://` URI accesses per session
- **Zero redundant scans** — process-level index cache; rebuilds only when `cwd` changes (monorepo switch)

## Install

### Via marketplace (recommended)

```bash
omp plugin marketplace add allentv/omp-plugins
omp plugin install skill-discovery@allentv-omp-plugins
```

### Via direct link

```bash
omp plugin link https://github.com/allentv/omp-plugins/plugins/skill-discovery
```

## Usage

### Automatic

Once installed, the extension runs automatically:

1. At session start, it scans `~/.omp/agent/managed-skills/`, `.omp/skills/`, and `~/.config/orca/codex-runtime-home/home/skills/.system/` for SKILL.md files
2. A compact index is injected into the system prompt on every agent turn
3. The model can search the index with `skill_search` and load skills on demand via `skill://<name>`

### Search skills

Ask the agent to find relevant skills:

```
Find skills related to cloudflare workers
```

The `skill_search` tool returns matching skills with descriptions and `skill://` load instructions.

### Filter by source

```
Show me only project-scoped skills
```

### Load a skill

Once found, load the full content:

```
Load the cloudflare-workers skill
```

The agent reads `skill://cloudflare-workers` and injects the full skill content.

## How it works

| Feature | Mechanism |
|---|---|
| Index generation | `session_start` scans 3 skill dirs, parses SKILL.md frontmatter |
| Shared cache | Process-level `sharedIndex` reused across all sessions; rebuilds on `cwd` change |
| Search tool | `skill_search` with keyword scoring (exact > name > desc) and source filtering |
| Prompt injection | `before_agent_start` injects `<skill-index>` block via custom message |
| Read tracking | `tool_call` intercept on `read` for `skill://` URIs |
| Cleanup | Per-session `sessionLoadedSkills` cleaned on `session_shutdown` |

## Scoring

Search results are ranked by relevance:

| Match type | Points |
|---|---|
| Exact name match | 20 |
| Name contains term | 10 |
| Name starts with term | 5 |
| Description contains term | 5 |

## License

MIT
