import { McpToolError, StructuredOutputError, tool } from "cron-llm";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { laneBrief } from "../src/prompts.js";
import { runLane, stopsTheRest, type LaneServer } from "../src/lane.js";

const BEGIN = `Lane lane-a: Neurofunk and techstep
Today's playlist: hermes20261020 (0 tracks so far)
Baseline: Dark, technical drum & bass.
Research note: Releases are sparse.
Pick up to 6 (aim for 3–6).

New from known labels and artists (since 2026-10-07):
K1  Kestrel — Hollow Ground · single, 2026-10-01 · Ferrous Records [core artist]
K2  Pressure Front (single, 2026-09-30, Obsidian Audio) · 2 tracks:
    K2.1  Mara Voss — Pressure Front · Obsidian Audio

Covered labels (research should look elsewhere): Obsidian Audio
Covered artists: Kestrel`;

const REVIEW = `Lane lane-a: Neurofunk and techstep
Pick up to 6.

Web finds, verified on Spotify (2):
W1  Vanta — Signal Loss · single, 2026-10-02 · Sublevel Recordings
    why: Sublevel Recordings: 'a slow-burning halftime roller'
W4  Lumen Drift — Glass Engine · single, 2026-09-29 · Sublevel Recordings
Not pickable: W2 Ash Meridian — Fever Line (pending)

From known labels and artists (3):
K1  Kestrel — Hollow Ground · single, 2026-10-01 · Ferrous Records
K2.1  Mara Voss — Pressure Front · single, 2026-09-30 · Obsidian Audio
C1  Dekker — Rivet · single, 2026-09-27 · Ironclad Music

Next: call discovery_finish with your picks as refs, best first.`;

function fakeServer(over: Partial<Record<string, (args: any) => string>> = {}) {
  const calls: { name: string; args: any }[] = [];
  const handlers: Record<string, (args: any) => string> = {
    discovery_begin: () => BEGIN,
    verify_tracks: () => "W1 ✓ Vanta — Signal Loss · 2026-10-02 · Sublevel Recordings\nW2 pending Ash Meridian — Fever Line\nW3 ✓ Lumen Drift — Glass Engine\nW4 ✓ X — Y",
    discovery_review: () => REVIEW,
    discovery_fill: () => "Lane lane-a has no room for more picks; nothing was checked. Call discovery_finish with your picks.",
    discovery_finish: () => "Saved. Added 3 track(s) to hermes20261020: …\nThe report job posts the full report. Reply with one line: Done: lane-a",
    ...over,
  };
  const server: LaneServer = {
    async call(name, args = {}) {
      calls.push({ name, args });
      return handlers[name]!(args);
    },
  };
  return { server, calls };
}

/** A model that answers the tool loop from a script, then the structured calls. */
function fakeLlm(turns: Array<{ tool: string; args: unknown } | string>, structured: (name: string, user: string) => unknown) {
  let i = 0;
  const seen: { name: string; user: string }[] = [];
  const toolsOffered: string[][] = [];
  const llm = {
    async chat(_messages: unknown, opts?: { tools?: { function: { name: string } }[] }) {
      toolsOffered.push((opts?.tools ?? []).map((t) => t.function.name));
      const t = turns[Math.min(i++, turns.length - 1)]!;
      if (typeof t === "string") return { message: { role: "assistant" as const, content: t }, usage: { prompt_tokens: 0, completion_tokens: 0 } };
      return { message: { role: "assistant" as const, content: null, tool_calls: [{ id: `c${i}`, type: "function" as const, function: { name: t.tool, arguments: JSON.stringify(t.args) } }] }, usage: { prompt_tokens: 0, completion_tokens: 0 } };
    },
    async structured(schema: z.ZodType, prompt: { user: string } | unknown[], opts?: { name?: string }) {
      const user = Array.isArray(prompt) ? "" : (prompt as { user: string }).user;
      const name = opts?.name ?? (/Sum up the research/.test(user) ? "research" : "");
      seen.push({ name, user });
      const a = name === "research" ? { summary: "Found some." } : structured(name, user);
      if (a instanceof Error) throw a;
      return schema.parse(a);
    },
  };
  return { llm: llm as any, seen, toolsOffered };
}

const web = (searches: string[]) => (stopped: () => string | null) => ({
  search: tool({ name: "web_search", description: "s", args: z.object({ query: z.string() }), budget: 2, run: async ({ query }) => stopped() ?? (searches.push(query), `results for ${query}`) }),
  extract: tool({ name: "web_extract", description: "e", args: z.object({ url: z.string() }), budget: 2, run: async ({ url }) => stopped() ?? `page ${url}` }),
});

const base = { lane: "lane-a", budgets: { search: 2, extract: 2, verify: 3 }, log: () => {}, report: async () => "**Lane:** Neurofunk\n**Added (3):** …" };

describe("runLane", () => {
  it("researches within budget, checks the choice against the review, finishes and returns the report", async () => {
    const { server, calls } = fakeServer();
    const searches: string[] = [];
    const { llm, seen, toolsOffered } = fakeLlm(
      [
        { tool: "web_search", args: { query: "!music neurofunk 2026" } },
        { tool: "web_search", args: { query: "halftime label" } },
        { tool: "web_search", args: { query: "one too many" } },
        { tool: "verify_tracks", args: { text: "Vanta | Signal Loss | Signal Loss | Sublevel | 2026-10-02 | Sublevel: 'roller' | https://x" } },
        "DONE 3",
      ],
      (name) => (name === "choice" ? { picks: ["w4", "W1", "K2.1", "W2", "Z9"], reject: ["C1", "W1", "K2.1"], why: [{ ref: "K2.1", reason: "Obsidian: 'rolling'" }, { ref: "W1", reason: "x" }] } : {}),
    );
    const lines: string[] = [];
    const out = await runLane({ ...base, server, llm, web: web(searches), log: (l) => lines.push(l) });
    expect(out).toBe("**Lane:** Neurofunk\n**Added (3):** …");

    // Budgets: web_search vanished from the tool list after 2 calls.
    expect(searches).toEqual(["!music neurofunk 2026", "halftime label"]);
    expect(toolsOffered[2]).toEqual(["web_extract", "verify_tracks"]);
    // The research brief leaves out the known-source tracks, and the lane is passed by code.
    const research = seen.find((s) => s.name === "research")!.user;
    expect(research).toContain("Covered labels (research should look elsewhere): Obsidian Audio");
    expect(research).not.toContain("K1  Kestrel");
    expect(calls.find((c) => c.name === "verify_tracks")!.args.lane).toBe("lane-a");
    expect(calls[0]).toEqual({ name: "discovery_begin", args: { lane: "lane-a", feed: false } });
    // The lane had no room left, so one review and one choice.
    expect(calls.find((c) => c.name === "discovery_fill")!.args).toEqual({ lane: "lane-a", picks: ["W4", "W1", "K2.1"] });
    expect(calls.filter((c) => c.name === "discovery_review")).toHaveLength(1);

    const finish = calls.find((c) => c.name === "discovery_finish")!.args;
    expect(finish).toEqual({ lane: "lane-a", picks: ["W4", "W1", "K2.1"], reject: ["C1"], why: { "K2.1": "Obsidian: 'rolling'" }, thin: false, dry_run: false });
    expect(lines).toContain("choice: ignoring refs not in the review: W2, Z9");
  });

  it("fills from known sources only when the lane is short, and chooses the rest from what that added", async () => {
    const FILL = "Lane lane-a: checked the known labels and artists for up to 2 more picks.\n\nNew from known labels and artists:\nK1  Kestrel — Hollow Ground · single, 2026-10-01 · Ferrous Records\n\nNext: call discovery_review for the full list, then discovery_finish.";
    const { server, calls } = fakeServer({ discovery_fill: () => FILL });
    const users: string[] = [];
    const { llm } = fakeLlm(["DONE 2"], (name, user) => {
      users.push(user);
      return users.length === 1 ? { picks: ["W1"], reject: [], why: [] } : { picks: ["W1", "K1", "C1"], reject: ["C1"], why: [{ ref: "K1", reason: "Ferrous: 'heavy'" }] };
    });
    const lines: string[] = [];
    await runLane({ ...base, server, llm, web: web([]), log: (l) => lines.push(l) });
    expect(calls.filter((c) => c.name === "discovery_review")).toHaveLength(2);
    expect(users[1]).toContain("Already chosen: W1. Those stay; don't list them again. The lane has room for up to 2 more");
    expect(lines).toContain("fill: short by 2; new K1");
    expect(lines).toContain("choice (more): K1, C1");
    expect(calls.find((c) => c.name === "discovery_finish")!.args).toMatchObject({ picks: ["W1", "K1", "C1"], reject: [], why: { K1: "Ferrous: 'heavy'" } });
  });

  it("runs research a second time with different searches when too little verified, and marks the run thin", async () => {
    const { server, calls } = fakeServer({ verify_tracks: () => "W1 ✓ Vanta — Signal Loss" });
    const { llm, seen } = fakeLlm([{ tool: "web_search", args: { query: "first try" } }, { tool: "verify_tracks", args: { text: "a | b | c | d | e | f | g" } }, "DONE 1"], (name) => (name === "choice" ? { picks: ["W1"], reject: [], why: [] } : {}));
    await runLane({ ...base, server, llm, web: web([]) });
    const researches = seen.filter((s) => s.name === "research");
    expect(researches).toHaveLength(2);
    expect(researches[1]!.user).toContain("Try different searches from these: first try");
    expect(calls.find((c) => c.name === "discovery_finish")!.args.thin).toBe(true);
  });

  it("stops research on a Spotify rate limit: every tool then says so", async () => {
    const { server } = fakeServer({
      verify_tracks: () => {
        throw new McpToolError("verify_tracks", "Spotify rate limit: Spotify is rate-limiting this app until 2026-10-20T14:00Z, about 200 min from now. Nothing was added.");
      },
    });
    const searches: string[] = [];
    const { llm } = fakeLlm(
      [{ tool: "verify_tracks", args: { text: "a | b | c | d | e | f | g" } }, { tool: "web_search", args: { query: "after the limit" } }, "DONE 0"],
      (name) => (name === "choice" ? { picks: [], reject: [], why: [] } : {}),
    );
    const lines: string[] = [];
    await runLane({ ...base, server, llm, web: web(searches), log: (l) => lines.push(l) });
    expect(searches).toEqual([]);
    expect(lines.some((l) => l.startsWith("research stopped: Spotify is rate-limiting this app until 2026-10-20T14:00Z"))).toBe(true);
    // No second pass after a rate limit.
    expect(lines.filter((l) => l.startsWith("research:")).length).toBe(1);
  });

  it("returns the skip messages for an expired login or a rate limit at begin, and 'not saved' at finish", async () => {
    const { llm } = fakeLlm(["DONE"], () => ({ picks: ["W1"], reject: [], why: [] }));
    const login = fakeServer({
      discovery_begin: () => {
        throw new McpToolError("discovery_begin", "Spotify login needed: token refresh failed. Report this in your reply; don't retry.");
      },
    });
    expect(await runLane({ ...base, server: login.server, llm, web: web([]) })).toMatch(/^🎧 Spotify lane lane-a skipped — the spotify-discovery-mcp login has expired/);
    const rate = fakeServer({
      discovery_begin: () => {
        throw new McpToolError("discovery_begin", "Spotify rate limit: Spotify is rate-limiting this app until 14:00Z, about 3 h from now. Nothing was added or saved.");
      },
    });
    expect(await runLane({ ...base, server: rate.server, llm, web: web([]) })).toBe("🎧 Spotify lane lane-a skipped — Spotify is rate-limiting this app until 14:00Z, about 3 h from now.");
    const finish = fakeServer({
      discovery_finish: () => {
        throw new McpToolError("discovery_finish", "Spotify rate limit: blocked until 14:00Z. Nothing was added or saved.");
      },
    });
    expect(await runLane({ ...base, server: finish.server, llm, web: web([]) })).toBe("🎧 Spotify lane lane-a not saved — blocked until 14:00Z.");
  });

  it("in a dry run returns the report from finish's text, and falls back to the W refs when the choice is unusable", async () => {
    const { server, calls } = fakeServer({ discovery_finish: () => "Dry run: nothing added or saved.\n===== REPORT (for the record) =====\n**Lane:** Neurofunk" });
    const { llm } = fakeLlm(["DONE 3"], (name) => (name === "choice" ? new StructuredOutputError("bad", "{") : {}));
    const report = async () => {
      throw new Error("not called in a dry run");
    };
    expect(await runLane({ ...base, server, llm, web: web([]), dryRun: true, report, minVerified: 0 })).toBe("**Lane:** Neurofunk");
    expect(calls.find((c) => c.name === "discovery_finish")!.args).toMatchObject({ picks: ["W1", "W4"], dry_run: true });
  });
});

describe("stopsTheRest", () => {
  it("is true for the skip and not-saved messages only", () => {
    expect(stopsTheRest("🎧 Spotify lane lane-a skipped — Spotify is rate-limiting this app until 14:00Z.")).toBe(true);
    expect(stopsTheRest("🎧 Spotify lane lane-a not saved — blocked until 14:00Z.")).toBe(true);
    expect(stopsTheRest("**Lane:** Neurofunk")).toBe(false);
    expect(stopsTheRest(null)).toBe(false);
  });
});

describe("laneBrief", () => {
  it("keeps the brief and the covered lists, not the track list", () => {
    expect(laneBrief(BEGIN)).toBe(
      "Lane lane-a: Neurofunk and techstep\nBaseline: Dark, technical drum & bass.\nResearch note: Releases are sparse.\nPick up to 6 (aim for 3–6).\nCovered labels (research should look elsewhere): Obsidian Audio\nCovered artists: Kestrel",
    );
  });
});
