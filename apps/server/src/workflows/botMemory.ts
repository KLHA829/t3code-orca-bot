/**
 * mem0-inspired retrieval for a bot's Markdown memory, with no external services: the agent
 * already extracts concise durable facts (`memoryNote`), so the memory file stays the source of
 * truth and this module retrieves the entries relevant to each job. Trigram scoring handles
 * English substrings and CJK text alike, the same approach as the server's thread search index.
 */

export interface BotMemoryEntry {
  /** The `##` heading text, usually an ISO timestamp. */
  readonly heading: string;
  readonly text: string;
}

/** Memory entries in a Markdown memory file: the text under each level-two heading. */
export function parseMemoryEntries(markdown: string): ReadonlyArray<BotMemoryEntry> {
  const entries: BotMemoryEntry[] = [];
  const lines = markdown.split(/\r?\n/);
  let heading: string | null = null;
  let body: string[] = [];
  const flush = () => {
    if (heading === null) return;
    const text = body.join("\n").trim();
    if (text !== "") entries.push({ heading, text });
  };
  for (const line of lines) {
    const match = /^##\s+(.+?)\s*$/.exec(line);
    if (match) {
      flush();
      heading = match[1] ?? "";
      body = [];
    } else if (heading !== null) {
      body.push(line);
    }
  }
  flush();
  return entries;
}

const normalize = (text: string) => text.toLowerCase().normalize("NFKC");

/** Character trigrams of normalized text, plus whole words too short to have any. */
export function trigramsOf(text: string): ReadonlySet<string> {
  const compact = normalize(text).replace(/\s+/g, " ");
  const grams = new Set<string>();
  for (let index = 0; index + 3 <= compact.length; index++) {
    grams.add(compact.slice(index, index + 3));
  }
  if (compact.length < 3 && compact.length > 0) grams.add(compact);
  return grams;
}

/** How much of the query an entry covers, from 0 to 1. */
export function trigramScore(
  queryGrams: ReadonlySet<string>,
  entryGrams: ReadonlySet<string>,
): number {
  if (queryGrams.size === 0) return 0;
  let hits = 0;
  for (const gram of queryGrams) {
    if (entryGrams.has(gram)) hits += 1;
  }
  return hits / queryGrams.size;
}

/**
 * The memory worth giving the agent for one job: the most relevant entries plus the latest few,
 * oldest first, capped at `maxChars`. Falls back to the file's tail when nothing parses as
 * entries, so memory written by hand or before entries existed is never hidden.
 */
export function memoryForJob(
  markdown: string,
  query: string,
  options?: {
    readonly maxChars?: number | undefined;
    readonly maxRelevant?: number | undefined;
    readonly alwaysRecent?: number | undefined;
  },
): string {
  const maxChars = options?.maxChars ?? 48_000;
  const maxRelevant = options?.maxRelevant ?? 6;
  const alwaysRecent = options?.alwaysRecent ?? 2;
  const entries = parseMemoryEntries(markdown);
  if (entries.length === 0) {
    return markdown.length <= maxChars ? markdown : markdown.slice(markdown.length - maxChars);
  }
  const queryGrams = trigramsOf(query);
  const scored = entries.map((entry, index) => ({
    entry,
    index,
    score: trigramScore(queryGrams, trigramsOf(entry.text)),
  }));
  // Common English trigrams give any prose a small baseline score, so relevance is
  // relative to the best hit rather than a fixed cutoff alone.
  const best = Math.max(0, ...scored.map(({ score }) => score));
  const cutoff = Math.max(0.1, best * 0.35);
  const relevant = scored
    .filter(({ score }) => score >= cutoff)
    .sort((left, right) => right.score - left.score || right.index - left.index)
    .slice(0, maxRelevant);
  const picked = new Set<number>();
  for (const { index } of relevant) picked.add(index);
  const recentCount = Math.min(alwaysRecent, entries.length);
  for (let index = entries.length - recentCount; index < entries.length; index++) {
    picked.add(index);
  }
  const chosen = [...picked]
    .sort((left, right) => left - right)
    .map((index) => {
      const entry = entries[index];
      return entry === undefined ? "" : `## ${entry.heading}\n\n${entry.text}`;
    })
    .filter((part) => part !== "");
  const joined = chosen.join("\n\n");
  if (joined.length <= maxChars) return joined;
  // Overflowing relevance picks are dropped oldest-first; recent entries stay.
  const kept: string[] = [];
  let remaining = maxChars;
  for (const part of [...chosen].reverse()) {
    if (part.length <= remaining) {
      kept.unshift(part);
      remaining -= part.length + 2;
    }
  }
  return kept.join("\n\n");
}
