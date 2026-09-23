import type {
  ExtensionAPI,
} from "@oh-my-pi/pi-coding-agent";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

/**
 * Skill Discovery Extension
 *
 * Lazy-loads skills on demand instead of keeping all in context.
 *
 * Pipeline:
 * 1. Build a compact skill index at session start (scan known skill dirs)
 * 2. Register a `skill_search` tool for on-demand discovery
 * 3. Inject a compact skill index into the system prompt via `before_agent_start`
 *    (replaces the full skill list with a lightweight overview)
 * 4. Intercept `read` calls to `skill://` URIs and log them for observability
 *
 * State is per-session — multiple OMP instances stay isolated.
 */

interface SkillEntry {
  name: string;
  description: string;
  source: string;
  path: string;
}

const SKILL_DIRS: Array<{ path: string; source: string }> = [
  {
    path: "~/.omp/agent/managed-skills",
    source: "managed",
  },
  {
    path: ".omp/skills",
    source: "project",
  },
  {
    path: "~/.config/orca/codex-runtime-home/home/skills/.system",
    source: "system",
  },
];

/**
 * Scan a directory for skills (one level deep: <dir>/<name>/SKILL.md).
 * Returns parsed skill entries with frontmatter metadata.
 */
async function scanSkillDir(
  dirPath: string,
  source: string,
  cwd: string,
): Promise<SkillEntry[]> {
  const entries: SkillEntry[] = [];
  const resolved = dirPath.startsWith("~")
    ? resolve(dirPath.replace("~", process.env.HOME ?? ""))
    : resolve(cwd, dirPath);

  try {
    const items = await readdir(resolved, { withFileTypes: true });
    for (const item of items) {
      if (!item.isDirectory()) continue;
      const skillFile = join(resolved, item.name, "SKILL.md");
      try {
        const content = await Bun.file(skillFile).text();
        const parsed = parseSkillFrontmatter(content);
        entries.push({
          name: parsed.name ?? item.name,
          description: parsed.description ?? "",
          source,
          path: skillFile,
        });
      } catch {
        // SKILL.md missing or unreadable — skip
      }
    }
  } catch {
    // Directory doesn't exist — skip
  }

  return entries;
}

/**
 * Parse YAML-like frontmatter from SKILL.md content.
 * Handles --- delimited frontmatter blocks.
 */
function parseSkillFrontmatter(
  content: string,
): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  if (!content.startsWith("---")) return result;

  const endIdx = content.indexOf("---", 3);
  if (endIdx === -1) return result;

  const fm = content.slice(3, endIdx);
  for (const line of fm.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let val = line.slice(colonIdx + 1).trim();
    // Strip quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    result[key] = val;
  }
  return result;
}

/**
 * Build a combined skill index from all known skill directories.
 */
async function buildSkillIndex(cwd: string): Promise<SkillEntry[]> {
  const results = await Promise.all(
    SKILL_DIRS.map((d) => scanSkillDir(d.path, d.source, cwd)),
  );
  return results.flat();
}

/**
 * Score a skill against search query terms.
 * Higher score = better match.
 */
function scoreSkill(skill: SkillEntry, terms: string[]): number {
  let score = 0;
  const nameLower = skill.name.toLowerCase();
  const descLower = skill.description.toLowerCase();

  for (const term of terms) {
    const t = term.toLowerCase();
    if (nameLower.includes(t)) score += 10;
    if (descLower.includes(t)) score += 5;
    // Exact name match bonus
    if (nameLower === t) score += 20;
    // Name starts with term
    if (nameLower.startsWith(t)) score += 5;
  }

  return score;
}

/**
 * Format the skill index as a compact system-prompt-safe block.
 */
function formatSkillIndexForPrompt(skills: SkillEntry[]): string {
  if (skills.length === 0) {
    return "<skill-index>\nNo skills discovered.\n</skill-index>";
  }

  const bySource = new Map<string, SkillEntry[]>();
  for (const s of skills) {
    const list = bySource.get(s.source) ?? [];
    list.push(s);
    bySource.set(s.source, list);
  }

  const lines: string[] = [
    "<skill-index>",
    `Available skills (${skills.length} total):`,
    "",
  ];

  for (const [source, entries] of bySource) {
    lines.push(`[${source}]`);
    for (const s of entries) {
      const desc = s.description
        ? ` — ${s.description.slice(0, 80)}${s.description.length > 80 ? "…" : ""}`
        : "";
      lines.push(`  ${s.name}${desc}`);
    }
    lines.push("");
  }

  lines.push(
    "Use skill://<name> to read a skill's full content. Use skill_search to find relevant skills.",
    "</skill-index>",
  );

  return lines.join("\n");
}

export default function skillDiscovery(pi: ExtensionAPI) {
  const z = pi.zod;

  pi.setLabel("Skill Discovery");

  // --- Process-level skill index (shared across all sessions in this OMP instance) ---
  let sharedIndex: SkillEntry[] | null = null;
  let sharedIndexCwd: string | null = null;

  // --- Per-session state ---
  const sessionLoadedSkills: Record<string, Set<string>> = {};

  // --- Tool: search skills on demand ---
  pi.registerTool({
    name: "skill_search",
    label: "Skill Search",
    description:
      "Search available skills by name or description keywords. Returns matching skills with metadata. " +
      "Use this to discover relevant skills before loading them via skill://<name>.",
    parameters: z.object({
      query: z
        .string()
        .optional()
        .describe(
          "Search terms to match against skill names and descriptions (space-separated keywords)",
        ),
      source: z
        .string()
        .optional()
        .describe(
          "Filter by source: managed, project, system, harness, or omit for all",
        ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const skills = sharedIndex ?? [];

      if (skills.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "Skill index not yet built. Skills may still be loading.",
            },
          ],
        };
      }

      let results = skills;

      // Filter by source
      if (params.source) {
        results = results.filter((s) => s.source === params.source);
      }

      // Score and filter by query
      if (params.query) {
        const terms = params.query.split(/\s+/).filter(Boolean);
        results = results
          .map((s) => ({ skill: s, score: scoreSkill(s, terms) }))
          .filter((r) => r.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 10)
          .map((r) => r.skill);
      } else {
        // No query — return all (capped)
        results = results.slice(0, 20);
      }

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No skills found${params.query ? ` matching "${params.query}"` : ""}.`,
            },
          ],
        };
      }

      const lines: string[] = [];
      lines.push(
        `## Skills${params.query ? ` matching "${params.query}"` : ""} (${results.length})`,
      );
      lines.push("");

      for (const s of results) {
        lines.push(`### ${s.name}`);
        lines.push(`- Source: ${s.source}`);
        if (s.description) lines.push(`- Description: ${s.description}`);
        lines.push(`- Load: \`skill://${s.name}\``);
        lines.push("");
      }

      lines.push(
        "To load a skill's full content, use the read tool with skill://<name>.",
      );

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          totalSkills: skills.length,
          returned: results.length,
          query: params.query,
        },
      };
    },
  });

  // --- Build shared index at first session start, reuse across sessions ---
  pi.on("session_start", async (_event, ctx) => {
    const sid = ctx.sessionManager.getSessionId() ?? "unknown";
    sessionLoadedSkills[sid] = new Set();

    // Rebuild only if first session or cwd changed (monorepo switch)
    if (!sharedIndex || sharedIndexCwd !== ctx.cwd) {
      sharedIndex = await buildSkillIndex(ctx.cwd);
      sharedIndexCwd = ctx.cwd;
    }

    ctx.ui.notify(
      `Skill Discovery: ${sharedIndex.length} skills indexed from ${SKILL_DIRS.length} sources`,
      "info",
    );
  });

  // --- Inject compact skill index into the system prompt ---
  pi.on("before_agent_start", async (_event, ctx) => {
    const skills = sharedIndex;
    if (!skills || skills.length === 0) return;

    const compactIndex = formatSkillIndexForPrompt(skills);

    // Inject the compact index as a developer-attributed custom message
    // that appears at the start of the context
    return {
      message: {
        customType: "skill-discovery-index",
        content: compactIndex,
        display: false,
        details: { skillCount: skills.length },
        attribution: "agent",
      },
    };
  });

  // --- Track skill reads for observability ---
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "read") return;

    const path = String(event.input?.path ?? "");
    if (!path.startsWith("skill://")) return;

    const skillName = path.replace("skill://", "").split("/")[0];
    const sid = ctx.sessionManager.getSessionId() ?? "unknown";
    const loaded = sessionLoadedSkills[sid];
    if (loaded) {
      loaded.add(skillName);
    }
  });

  // --- Cleanup per-session state on shutdown (shared index persists) ---
  pi.on("session_shutdown", async (_event, ctx) => {
    const sid = ctx.sessionManager.getSessionId() ?? "unknown";
    delete sessionLoadedSkills[sid];
  });
}
