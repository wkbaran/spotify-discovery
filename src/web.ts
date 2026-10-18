import { tool } from "cron-llm";
import { pacedFetch, type FetchLike } from "paced-fetch";
import { z } from "zod";

// The research loop's two web tools: search through a SearXNG instance, and read
// a page through a Firecrawl instance. Both are self-hosted services, so the
// pacing here is only politeness to them; the sites behind them see one request
// per call.

export interface WebOptions {
  /** SearXNG base URL, e.g. http://localhost:8080. Its JSON format must be enabled. */
  searxngUrl: string;
  /** Firecrawl base URL, e.g. http://localhost:3002. */
  firecrawlUrl: string;
  firecrawlKey?: string;
  /** Results per search shown to the model. */
  results?: number;
  /** Characters of a page shown to the model. */
  pageChars?: number;
  fetch?: FetchLike;
}

export function webTools(opts: WebOptions, budgets: { search: number; extract: number }, stopped: () => string | null) {
  const f = pacedFetch({ fetch: opts.fetch, defaults: { concurrency: 2, retries: 1, timeoutMs: 60_000 } });
  const results = opts.results ?? 8;
  const pageChars = opts.pageChars ?? 8_000;

  const search = tool({
    name: "web_search",
    description:
      `Search the web. Returns up to ${results} results (title, URL, snippet). Start music discovery searches with !music (SearXNG's music engines), ` +
      "e.g. \"!music neurofunk new releases 2026\"; use a plain query when that finds nothing.",
    args: z.object({ query: z.string().min(2).describe("The search query.") }),
    budget: budgets.search,
    run: async ({ query }) => {
      const stop = stopped();
      if (stop) return stop;
      const url = `${opts.searxngUrl.replace(/\/+$/, "")}/search?${new URLSearchParams({ q: query, format: "json" })}`;
      const res = await f(url, { headers: { accept: "application/json" } });
      if (!res.ok) return `Error: search failed (HTTP ${res.status}).`;
      const body = (await res.json()) as { results?: { title?: string; url: string; content?: string; publishedDate?: string }[] };
      const rows = (body.results ?? []).slice(0, results);
      if (!rows.length) return "No results. Try different words, or a plain query without !music.";
      return rows.map((r, i) => `${i + 1}. ${r.title ?? "(no title)"}\n   ${r.url}${r.publishedDate ? ` · ${r.publishedDate.slice(0, 10)}` : ""}\n   ${(r.content ?? "").replace(/\s+/g, " ").slice(0, 300)}`).join("\n");
    },
  });

  const extract = tool({
    name: "web_extract",
    description: `Read one web page as text (the first ${pageChars} characters). Use it on label, Bandcamp, SoundCloud, blog and artist pages from your searches.`,
    args: z.object({ url: z.string().url().describe("The page URL.") }),
    budget: budgets.extract,
    run: async ({ url }) => {
      const stop = stopped();
      if (stop) return stop;
      const res = await f(`${opts.firecrawlUrl.replace(/\/+$/, "")}/v1/scrape`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(opts.firecrawlKey ? { authorization: `Bearer ${opts.firecrawlKey}` } : {}) },
        body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true }),
      });
      const body = (await res.json().catch(() => ({}))) as { success?: boolean; data?: { markdown?: string }; error?: string };
      if (!res.ok || !body.success) return `Error: couldn't read ${url}${body.error ? ` (${body.error.slice(0, 200)})` : ` (HTTP ${res.status})`}.`;
      const md = (body.data?.markdown ?? "").trim();
      if (!md) return "The page had no readable text.";
      return md.length > pageChars ? `${md.slice(0, pageChars)}\n… (page cut at ${pageChars} characters)` : md;
    },
  });

  return { search, extract };
}
