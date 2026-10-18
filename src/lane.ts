import { McpToolError, runLoop, StructuredOutputError, tool, type Llm, type LoopTool } from "cron-llm";
import { z } from "zod";
import { Choice, choicePrompt, laneBrief, researchPrompt, ResearchResult, type Budgets } from "./prompts.js";

// One lane run: discovery_begin, a bounded research loop (web search, page reads,
// verify_tracks), discovery_review, one structured choice, discovery_finish, then
// the server's report. The server owns Spotify, limits, playlist and state; this
// file owns the order of calls and the checks on what the model returns.

export interface LaneServer {
  call(name: string, args?: Record<string, unknown>): Promise<string>;
}

export interface LaneOptions {
  lane: string;
  server: LaneServer;
  llm: Pick<Llm, "structured" | "chat">;
  /** Builds web_search and web_extract (SearXNG and Firecrawl in main.ts). `stopped` returns a message once research must end. */
  web: (stopped: () => string | null) => { search: LoopTool<any>; extract: LoopTool<any> };
  /** Prints finished reports not delivered yet (the server's `report` command). */
  report: () => Promise<string>;
  log: (line: string) => void;
  dryRun?: boolean;
  budgets: Budgets;
  /** How many tracks research aims for. */
  tracks?: [number, number];
  /** Research runs once more when it verifies fewer than this. */
  minVerified?: number;
  maxTurns?: number;
  maxReject?: number;
}

const REPORT_MARKER = /^===== REPORT[^\n]*\n/m;
const AUTH = /^Spotify login needed/;
const RATE = /^Spotify rate limit/;
const REF_LINE = /^\s*([WKC]\d+(?:\.\d+)?)\s{2,}/gm;
const FIRST_SENTENCE = (s: string) => s.replace(/^Spotify rate limit:\s*/, "").split(/(?<=\.)\s/)[0]!;

/** Runs one lane and returns the message to post: the lane's report, or why it was skipped. */
export async function runLane(opts: LaneOptions): Promise<string | null> {
  const { lane, server, log } = opts;
  const head = `🎧 Spotify lane ${lane}`;

  // 1. Begin.
  let begin: string;
  try {
    begin = await server.call("discovery_begin", { lane });
  } catch (err) {
    if (!(err instanceof McpToolError)) throw err;
    if (AUTH.test(err.message)) return `${head} skipped — the spotify-discovery-mcp login has expired. Run spotify-discovery-mcp login and copy auth.json into the job's auth directory.`;
    if (RATE.test(err.message)) return `${head} skipped — ${FIRST_SENTENCE(err.message)}`;
    throw err;
  }
  log(begin.split("\n").slice(0, 2).join(" · "));
  const brief = laneBrief(begin);

  // 2. Research, with budgets enforced by the loop. A rate limit ends it: every tool then says so.
  let rateLimited: string | null = null;
  const stopped = () => (rateLimited ? `Research is over: ${rateLimited} Reply DONE.` : null);
  let verified = 0;
  const verify = tool({
    name: "verify_tracks",
    description: "Check your finds on Spotify and add them to this lane's run. text: one track per line, artist | track | release | label | release date | why it fits, attributed | source URL; plus LABEL | name | URL | description lines.",
    args: z.object({ text: z.string().min(5).describe("The finds, as pipe-separated lines.") }),
    budget: opts.budgets.verify,
    run: async ({ text }) => {
      if (rateLimited) return `Error: ${rateLimited}`;
      try {
        const out = await server.call("verify_tracks", { lane, text });
        verified += (out.match(/^W\d+ ✓/gm) ?? []).length;
        return out;
      } catch (err) {
        if (!(err instanceof McpToolError)) throw err;
        if (RATE.test(err.message)) rateLimited = FIRST_SENTENCE(err.message);
        return `Error: ${err.message}`;
      }
    },
  });
  const web = opts.web(stopped);
  const tools = [web.search, web.extract, verify];
  const research = async (retry?: string[]) => {
    const r = await runLoop({
      llm: opts.llm as Llm,
      ...researchPrompt({ lane, brief, budgets: opts.budgets, tracks: opts.tracks ?? [6, 12], retry }),
      tools,
      final: ResearchResult,
      finalPrompt: "Sum up the research in one or two sentences.",
      maxTurns: opts.maxTurns ?? 40,
      log,
    });
    log(`research: ${r.calls.length} tool calls (${count(r.calls, "web_search")} searches, ${count(r.calls, "web_extract")} pages, ${count(r.calls, "verify_tracks")} verify), ended by ${r.stopped}; ${verified} verified so far. ${r.value.summary}`);
    return r;
  };
  const first = await research();
  if (verified < (opts.minVerified ?? 3) && !rateLimited) {
    const queries = first.calls.filter((c) => c.name === "web_search").map((c) => String((c.args as { query?: string }).query ?? ""));
    log(`research: only ${verified} verified; one more pass with different searches`);
    await research(queries);
  }
  if (rateLimited) log(`research stopped: ${rateLimited}`);

  // 3. Review, then one structured choice, checked against the review's refs.
  const review = await server.call("discovery_review", { lane });
  const pickable = new Set([...review.matchAll(REF_LINE)].map((m) => m[1]!.toUpperCase()));
  if (!pickable.size) log("review: nothing pickable");
  const maxReject = opts.maxReject ?? 3;
  let choice: Choice;
  try {
    choice = pickable.size ? await opts.llm.structured(Choice, choicePrompt({ review, maxReject }), { name: "choice", tags: [`lane:${lane}`, "step:choice"] }) : { picks: [], reject: [], why: [] };
  } catch (err) {
    if (!(err instanceof StructuredOutputError)) throw err;
    // The verified web finds, with their attributed reasons, in the server's order.
    log(`choice: no usable answer (${err.message}); picking the verified web finds`);
    choice = { picks: [...pickable].filter((r) => r.startsWith("W")), reject: [], why: [] };
  }
  const known = (r: string) => pickable.has(r.trim().toUpperCase());
  const ignored = [...choice.picks, ...choice.reject].filter((r) => !known(r));
  if (ignored.length) log(`choice: ignoring refs not in the review: ${ignored.join(", ")}`);
  const picks = [...new Set(choice.picks.filter(known).map((r) => r.trim().toUpperCase()))];
  const reject = [...new Set(choice.reject.filter(known).map((r) => r.trim().toUpperCase()))].filter((r) => /^[KC]/.test(r) && !picks.includes(r)).slice(0, maxReject);
  const why = Object.fromEntries(choice.why.map((w) => [w.ref.trim().toUpperCase(), w.reason]).filter(([r]) => /^[KC]/.test(r!) && picks.includes(r!)));
  log(`choice: ${picks.join(", ") || "none"}${reject.length ? `; reject ${reject.join(", ")}` : ""}`);

  // 4. Finish. thin is the code's call: the research verified too little.
  let finish: string;
  try {
    finish = await server.call("discovery_finish", { lane, picks, reject, why, thin: verified < (opts.minVerified ?? 3), dry_run: Boolean(opts.dryRun) });
  } catch (err) {
    if (!(err instanceof McpToolError)) throw err;
    if (RATE.test(err.message)) return `${head} not saved — ${FIRST_SENTENCE(err.message)}`;
    throw err;
  }
  log(finish.split(REPORT_MARKER)[0]!.trim().split("\n")[0]!);

  // 5. The report: in a dry run it's in finish's text; otherwise the server prints it once.
  if (opts.dryRun) {
    const at = finish.search(REPORT_MARKER);
    return at < 0 ? finish : finish.slice(at).replace(REPORT_MARKER, "").trim();
  }
  const report = (await opts.report()).trim();
  return report || null;
}

function count(calls: { name: string }[], name: string): number {
  return calls.filter((c) => c.name === name).length;
}
