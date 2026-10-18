import { z } from "zod";

// What the model is asked. Research is the one open-ended step (a bounded tool
// loop); choosing the tracks is one structured call over the server's review.

export interface Budgets {
  search: number;
  extract: number;
  verify: number;
}

/** The lane brief from discovery_begin's text: everything except the known-source track list. */
export function laneBrief(beginText: string): string {
  return beginText
    .split("\n")
    .filter((l) => l.trim() && !/^\s*[KC]\d/.test(l) && !/^(New from known labels|Continuing this lane)/.test(l) && !/^Today's playlist/.test(l))
    .join("\n");
}

export function researchPrompt(p: { lane: string; brief: string; budgets: Budgets; tracks: [number, number]; retry?: string[] }): { system: string; user: string } {
  return {
    system:
      "You research new music for one genre lane of a Spotify discovery playlist. You search the web, read pages, and hand the tracks you find to the server with verify_tracks, " +
      "which checks each one on Spotify. You don't choose the final tracks; that happens after you're done.",
    user: [
      `Find ${p.tracks[0]} to ${p.tracks[1]} recent tracks for the lane below, from artists and labels that are NOT in the covered lists, and hand them to the server with verify_tracks.`,
      "",
      `Lane id: ${p.lane}`,
      p.brief,
      "",
      "Search label pages, Bandcamp, SoundCloud, Beatport, blogs, Reddit and artist pages. Prefer releases from the last 6 to 12 months and smaller artists.",
      `You have ${p.budgets.search} searches, ${p.budgets.extract} page reads and ${p.budgets.verify} verify_tracks calls; a tool disappears when its calls are used up.`,
      "Call verify_tracks every few searches with whatever you have so far; each call adds to the run, so don't hold tracks back for one big call.",
      "",
      "Base every reason on text from a label, Bandcamp or SoundCloud description, artist statement or reputable blog, and say whose text it is. Never write sounds like, on listen or has a vibe.",
      "",
      "verify_tracks takes plain lines, one track per line, fields separated by a pipe:",
      "artist | track | release | label | release date | why it fits, attributed | source URL",
      "Add one line per relevant new label: LABEL | label name | URL | one-line description",
      "No JSON, no numbering, no code fences.",
      "",
      "If verify_tracks says \"Spotify rate limit\", stop: reply DONE.",
      "When you're done, reply with one line: DONE, then how many tracks verify_tracks marked with a check mark.",
      ...(p.retry?.length ? ["", `A first pass found too little. Try different searches from these: ${p.retry.join("; ")}`] : []),
    ].join("\n"),
  };
}

export const ResearchResult = z.object({
  summary: z.string().describe("One or two sentences on what the research found and where."),
});

export const Choice = z.object({
  picks: z.array(z.string()).describe('Refs to add, best first, e.g. ["W2", "K1", "W5"]. Fewer than the target is fine; don\'t pad with weak fits.'),
  reject: z.array(z.string()).describe("K or C refs that are clearly the wrong genre for this lane; never offered again. Not refs you merely didn't pick."),
  why: z
    .array(z.object({ ref: z.string(), reason: z.string() }))
    .describe("Only for a K or C pick with a quoted or attributed reason, e.g. Label: 'quoted text'. W picks already have theirs."),
});
export type Choice = z.infer<typeof Choice>;

export function choicePrompt(p: { review: string; maxReject: number }): { system: string; user: string } {
  return {
    system: "You choose the tracks for one genre lane of a Spotify discovery playlist, from candidates the server has already checked on Spotify.",
    user: [
      p.review.replace(/\nNext: [^\n]*$/, ""),
      "",
      "Choose the tracks that best fit the baseline, best first; the server keeps your order and drops from the end to meet the limits above.",
      "A Beatport:, SoundCloud: or Deezer: line gives the genre. \"⚠ genre outside this lane\" means it doesn't fit: pick it only if the brief clearly supports it. " +
        "Deezer's genres are coarse: Folk or Rock is a real warning, but Pop or Alternative without ⚠ doesn't settle it. A track with no genre line is one no source knew; don't guess its genre from the artist's name.",
      `reject: at most ${p.maxReject} K or C refs that are clearly the wrong genre. Unpicked refs carry over to later runs by themselves, so don't reject a ref just because you didn't pick it.`,
      "why: only for a K or C pick you have a quoted or attributed reason for; leave it empty otherwise.",
    ].join("\n"),
  };
}
