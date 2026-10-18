# Agent notes

Common mistakes and confusion points in this project. Add to this list when something surprises you.

- **The job drives spotify-discovery-mcp over MCP (and its `report` command); it doesn't import it.** The server stays a plain MCP server that other people use from agent hosts. If the job needs something from it, add it as an MCP feature.
- **Research is the only tool loop**, and its budgets are the loop's, not the prompt's: under Hermes the research subagent ignored a 20-search budget (84 searches in one run). `runLoop` removes a spent tool from the list. The numbers in the research prompt come from the same `Budgets` object, so they can't disagree.
- **The lane id is passed by code, never by the model.** `verify_tracks` is wrapped so the model gives only `text`. The model never sees `discovery_begin`, `discovery_review` or `discovery_finish` as tools, so a research turn can't end the lane early (the Hermes failure that `discovery_review` exists to prevent).
- **A dry run is not side-effect free.** `discovery_begin` finds or creates today's playlist on the account and records it in `days.json`; research uses Spotify's quota. Only `discovery_finish` honours `dry_run`.
- **Spotify's quota can run out for hours** (`429 QUOTA_EXCEEDED`, `Retry-After` of ~3 h, seen 2026-10-04). The server fails at once and blocks later requests; the job stops research and posts a skip or "not saved" line instead of retrying.
- **thin is the code's call**, from the count of ✓ lines `verify_tracks` returned, not the model's opinion.
- **The report is the server's**: after a real finish the job runs `spotify-discovery-mcp report`, which prints every finished, unprinted report (tracked in `reports.json`) and a ⚠ line for runs that never finished. That replaces Hermes's every-5-minutes report job.
- **The real crontab is gitignored** (`docker/crontab`): lane ids describe the user's taste. Commit only `crontab.example`.
- Only `SPOTIFY_DISCOVERY_*` variables and `TZ` reach the server, so the LLM key and webhooks don't.
- Keep personal details out of the repo (it's public): no host paths, time zone, lane ids, webhook URLs or keys. They live in `docker/.env` and `docker/crontab`, both gitignored.
