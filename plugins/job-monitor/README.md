# omp-job-monitor

Real-time background job monitoring for [OMP](https://github.com/can1357/oh-my-pi).

## Features

- **On-demand status** — `job_status` tool shows all background jobs with elapsed time and progress
- **Live status bar** — polls every 5s when jobs are active, updates TUI status bar with running/done counts
- **Completion alerts** — notifies when background jobs finish
- **Lazy activation** — polling only starts when jobs are actually running, zero overhead on idle sessions

## Install

### Via marketplace (recommended)

```bash
omp plugin marketplace add allentv/omp-plugins
omp plugin install job-monitor@allentv-omp-plugins
```

### Via direct link

```bash
omp plugin link https://github.com/allentv/omp-plugins/plugins/job-monitor
```

## Usage

### Automatic

Once installed, the extension activates automatically when background jobs are spawned (via `task`, `hub wait`, or subagent creation).

### Manual

Ask the agent to check job status:

```
What background jobs are running?
```

The `job_status` tool will be called and return a formatted status report.

### Verbose mode

For detailed info (model, cost, label):

```
Show me verbose background job status
```

## How it works

| Feature | Mechanism |
|---|---|
| On-demand queries | `job_status` tool via `ctx.getAsyncJobSnapshot()` |
| Live status bar | `ctx.setInterval()` polling, auto-stops when no jobs remain |
| Completion alerts | Set-based deduplication, `ctx.ui.notify()` |
| Auto-cleanup | Timers auto-clear on `session_shutdown` per OMP contract |

## License

MIT
