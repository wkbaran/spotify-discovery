# spotify-discovery

Genre lanes for a Spotify discovery playlist, as scheduled jobs. Each lane run adds a few new tracks that fit the lane to today's playlist and posts a report to a Discord channel: what was added, from where, and why.

It's a plain scheduled job, not an agent:

- [spotify-discovery-mcp](https://github.com/wkbaran/spotify-discovery-mcp) runs as a child process. It creates or finds today's playlist, fetches new releases from the lane's known labels and artists, checks web finds on Spotify, drops anything already recommended, applies the lane's pick limits, adds the tracks, keeps all state and writes the report.
- [cron-llm](https://github.com/wkbaran/cron-llm) runs the research as a bounded tool loop and asks for the final choice with a JSON schema, through any OpenAI-compatible gateway that supports tool calling.
- The research tools are a [SearXNG](https://github.com/searxng/searxng) instance for search and a [Firecrawl](https://github.com/firecrawl/firecrawl) instance for reading pages, both self-hosted.

## How a lane run goes

1. `discovery_begin` returns the lane brief (baseline, notes, limits, the labels and artists already covered) and the new releases from known sources.
2. **Research**, the one open-ended step: the model searches the web, reads pages and hands its finds to `verify_tracks`, which checks each on Spotify. Budgets are enforced in code (by default 20 searches, 10 page reads, 8 `verify_tracks` calls): a tool disappears from the model's list when its calls are spent. If fewer than 3 tracks verify, research runs once more with different searches.
3. `discovery_review` lists everything pickable, from the server's records.
4. One structured call chooses the tracks, best first, and at most 3 to reject. The code drops refs the review doesn't list, rejects only K and C refs, and keeps reasons only for K and C picks.
5. `discovery_finish` applies the limits, adds the tracks and saves. The job then runs the server's `report` command, which prints each finished report once, and posts it.

A Spotify rate limit ends research at once (every tool then says so) and is reported instead of retried. An expired login or a rate limit at `discovery_begin` posts a one-line skip message. Anything else fails the run with a notice, and the lane's next run starts over.

## Running it

```sh
npm install
npm run build
cp docker/.env.example .env                    # fill in
node --env-file=.env dist/main.js <lane id> --dry-run
```

`--dry-run` only stops `discovery_finish` from adding or saving: `discovery_begin` still finds or creates today's playlist and writes a run file, and research uses Spotify's quota.

Sign in to Spotify once with `npx spotify-discovery-mcp login` and point `SPOTIFY_DISCOVERY_AUTH` at the `auth.json` it writes. Lanes are defined in `lanes.json` in the state directory; see the server's README.

### In a container

`docker/` has a Dockerfile, a compose file and `crontab.example`. Copy it to `docker/crontab` (gitignored, since lane ids describe your taste) with one line per lane, copy `docker/.env.example` to `docker/.env`, then:

```sh
docker compose -f docker/compose.yaml up -d --build
docker logs spotify-discovery     # one line per step, tool call and model call
```

The container runs as uid 1000; the state and auth directories should belong to it.

## Configuration

| Variable | |
|---|---|
| `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`, `LLM_REASONING_EFFORT` | The gateway and model (see cron-llm). The model must support tool calling. Requests are tagged `job:spotify-discovery` and `lane:<id>` |
| `DISCORD_WEBHOOK_URL` | Where reports go. Without it, they're printed |
| `DISCORD_FAILURE_WEBHOOK_URL` | Where failure notices go; defaults to the report webhook |
| `SEARXNG_URL`, `FIRECRAWL_URL`, `FIRECRAWL_API_KEY` | The research tools |
| `RESEARCH_SEARCHES`, `RESEARCH_PAGES`, `RESEARCH_VERIFY_CALLS` | Tool budgets (default 20, 10, 8), stated in the research prompt and enforced by the loop |
| `RESEARCH_TRACKS_MIN`, `RESEARCH_TRACKS_MAX`, `RESEARCH_MIN_VERIFIED` | How many tracks research aims for, and the fewest verified before a second pass (default 6, 12, 3). Fewer than the minimum also marks the run thin |
| `RESEARCH_MAX_TURNS` | Model turns in one research pass (default 40) |
| `SEARCH_RESULTS`, `PAGE_CHARS` | Results per search and characters per page shown to the model (default 8, 8000) |
| `SPOTIFY_DISCOVERY_*`, `TZ` | Passed to spotify-discovery-mcp, and nothing else from the job's environment is. `SPOTIFY_DISCOVERY_DIR` defaults to `/data` and `SPOTIFY_DISCOVERY_AUTH` to `/auth/auth.json` |
| `JOB_DRY_RUN=1` | Same as `--dry-run` |

## Development

```sh
npm test
```

Node 26 or later. MIT licensed.
