import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { llmFromEnv, McpServer, runJob } from "cron-llm";
import { runLane, stopsTheRest } from "./lane.js";
import { webTools } from "./web.js";

// Entry point: `node dist/main.js <lane> [<lane> …] [--dry-run]`. The lanes run one after another, each
// posting its own report; one crontab line runs them all, so a lane never waits on a guessed start time.

const SERVER = fileURLToPath(new URL("../node_modules/spotify-discovery-mcp/dist/cli.js", import.meta.url));
const lanes = process.argv.slice(2).filter((a) => !a.startsWith("-"));
if (!lanes.length) {
  console.error("Usage: node dist/main.js <lane id> [<lane id> …] [--dry-run]");
  process.exit(2);
}

let worst = 0;
let stopped: string | null = null;
const notRun: string[] = [];
for (const lane of lanes) {
  // A lane that fails doesn't stop the others; an expired login or a Spotify block does, since the rest would hit it too.
  if (stopped) {
    notRun.push(lane);
    continue;
  }
  const code = await runJob(
    `spotify-discovery ${lane}`,
    async ({ env, dryRun, log }) => {
      const message = await laneRun(lane, env, dryRun, log);
      if (stopsTheRest(message)) stopped = message;
      return message;
    },
    // One name per lane, so Discord doesn't run back-to-back lane reports together.
    { username: `Spotify · ${lane}` },
  );
  worst = Math.max(worst, code);
}
if (notRun.length) {
  // One line for the lanes left out, after the stopping lane's own message.
  await runJob("spotify-discovery", async () => `🎧 Not run, for the same reason: ${notRun.join(", ")}.`, { username: "Spotify" });
}
process.exitCode = worst;

async function laneRun(lane: string, env: NodeJS.ProcessEnv, dryRun: boolean, log: (line: string) => void): Promise<string | null> {
  const llm = llmFromEnv(env, { tags: ["job:spotify-discovery", `lane:${lane}`], log });
  // The server gets its own settings (SPOTIFY_DISCOVERY_*) and TZ, and nothing else from the job's environment.
  const serverEnv = Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith("SPOTIFY_DISCOVERY_") || k === "TZ"));
  serverEnv.SPOTIFY_DISCOVERY_DIR ??= "/data";
  serverEnv.SPOTIFY_DISCOVERY_AUTH ??= "/auth/auth.json";
  const searxngUrl = env.SEARXNG_URL;
  const firecrawlUrl = env.FIRECRAWL_URL;
  if (!searxngUrl || !firecrawlUrl) throw new Error("Set SEARXNG_URL and FIRECRAWL_URL for the research step.");

  const budgets = { search: positive(env.RESEARCH_SEARCHES) ?? 20, extract: positive(env.RESEARCH_PAGES) ?? 10, verify: positive(env.RESEARCH_VERIFY_CALLS) ?? 8 };
  const web = (stopped: () => string | null) =>
    webTools({ searxngUrl, firecrawlUrl, firecrawlKey: env.FIRECRAWL_API_KEY, results: positive(env.SEARCH_RESULTS), pageChars: positive(env.PAGE_CHARS) }, budgets, stopped);

  const server = await McpServer.start({
    command: process.execPath,
    args: [SERVER],
    env: serverEnv,
    // discovery_begin and verify_tracks look tracks up one by one; give them room.
    timeoutMs: 30 * 60_000,
    onStderr: (line) => log(`server: ${line}`),
  });
  try {
    return await runLane({
      lane,
      server,
      llm,
      web,
      // The server's own report command: each finished report is printed once (it keeps track in reports.json).
      report: async () => (await promisify(execFile)(process.execPath, [SERVER, "report"], { env: { ...serverEnv, PATH: env.PATH ?? "" } })).stdout,
      log,
      dryRun,
      budgets,
      tracks: [positive(env.RESEARCH_TRACKS_MIN) ?? 6, positive(env.RESEARCH_TRACKS_MAX) ?? 12],
      minVerified: positive(env.RESEARCH_MIN_VERIFIED) ?? 3,
      maxTurns: positive(env.RESEARCH_MAX_TURNS),
      choiceReasoning: env.CHOICE_REASONING_EFFORT || undefined,
    });
  } finally {
    await server.close();
    log(`tokens: ${llm.usage.prompt_tokens} in, ${llm.usage.completion_tokens} out over ${llm.usage.calls} calls`);
  }
}

/** A positive whole number from env, or undefined for the default. */
function positive(raw: string | undefined): number | undefined {
  const n = Number(raw);
  return raw && Number.isInteger(n) && n > 0 ? n : undefined;
}
