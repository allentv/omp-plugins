import type {
  ExtensionAPI,
  ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";

/**
 * Job Monitor Extension
 *
 * Polls background job status and displays live progress in the TUI.
 * Uses ctx.getAsyncJobSnapshot() + ctx.setInterval() for periodic updates.
 * Timers auto-clear on session_shutdown per OMP contract.
 */
export default function jobMonitor(pi: ExtensionAPI) {
  const z = pi.zod;

  pi.setLabel("Job Monitor");

  // --- Tool: get current job status on demand ---
  pi.registerTool({
    name: "job_status",
    label: "Job Status",
    description:
      "Show real-time status of all background jobs with progress info",
    parameters: z.object({
      verbose: z
        .boolean()
        .optional()
        .describe("Include full job details (model, cost, etc.)"),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const snapshot = ctx.getAsyncJobSnapshot();
      if (!snapshot || snapshot.jobs.length === 0) {
        return {
          content: [{ type: "text", text: "No background jobs running." }],
        };
      }

      const lines: string[] = [];
      lines.push(`## Background Jobs (${snapshot.jobs.length})\n`);

      for (const job of snapshot.jobs) {
        const elapsed = job.startedAt
          ? ((Date.now() - job.startedAt) / 1000).toFixed(1)
          : "?";
        const icon = job.status === "running" ? "🔄" : "✅";
        const progress = job.progress
          ? ` [${job.progress.current}/${job.progress.total}]`
          : "";

        lines.push(`${icon} **${job.id}** (${elapsed}s)${progress}`);
        lines.push(`   Agent: ${job.agent ?? "unknown"}`);

        if (params.verbose) {
          if (job.model) lines.push(`   Model: ${job.model}`);
          if (job.cost != null)
            lines.push(`   Cost: $${job.cost.toFixed(4)}`);
          if (job.label) lines.push(`   Label: ${job.label}`);
        }
        lines.push("");
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { jobCount: snapshot.jobs.length },
      };
    },
  });

  // --- Lazy polling: only activates when jobs are running ---
  let statusPollActive = false;

  function startStatusPolling(ctx: ExtensionContext) {
    if (statusPollActive) return;
    statusPollActive = true;

    ctx.setInterval(() => {
      const snapshot = ctx.getAsyncJobSnapshot();
      const hasJobs = snapshot && snapshot.jobs.length > 0;

      if (!hasJobs) {
        ctx.ui.setStatus?.("");
        statusPollActive = false;
        return;
      }

      const running = snapshot.jobs.filter((j) => j.status === "running");
      const done = snapshot.jobs.filter((j) => j.status !== "running");

      const parts: string[] = [];
      if (running.length > 0) parts.push(`🔄 ${running.length} running`);
      if (done.length > 0) parts.push(`✅ ${done.length} done`);

      for (const job of running) {
        if (job.progress) {
          const pct = Math.round(
            (job.progress.current / job.progress.total) * 100,
          );
          parts.push(`${job.label ?? job.id}: ${pct}%`);
        }
      }

      ctx.ui.setStatus?.(parts.join(" | "));
    }, 5_000);
  }

  function startCompletionWatcher(ctx: ExtensionContext) {
    const seen = new Set<string>();

    ctx.setInterval(() => {
      const snapshot = ctx.getAsyncJobSnapshot();
      if (!snapshot) return;

      for (const job of snapshot.jobs) {
        if (job.status !== "running" && !seen.has(job.id)) {
          seen.add(job.id);
          ctx.ui.notify(
            `Job ${job.id} (${job.agent ?? "unknown"}) completed`,
            "info",
          );
        }
      }
    }, 3_000);
  }

  // --- Trigger polling when tools emit job activity ---
  pi.on("tool_call", async (event, ctx) => {
    if (
      event.toolName === "task" ||
      (event.toolName === "hub" && event.input?.op === "wait")
    ) {
      startStatusPolling(ctx);
      startCompletionWatcher(ctx);
    }
  });

  // Also activate on agent spawn (subagents create background jobs)
  pi.on("before_subagent_spawn", async (_event, ctx) => {
    startStatusPolling(ctx);
    startCompletionWatcher(ctx);
  });
}
