// Lay a long write-up out across several Block Kit inputs and put it back.
// A plain_text_input holds at most 3000 characters and write-ups run longer.
// The split is lossless: every chunk records the separator that followed it,
// so an unedited note comes back byte-for-byte. Port of ashby-upload-bot/chunking.py.

export const LIMIT = 2900; // headroom under Slack's 3000 for edits
export const PART_JOINER = "\n\n";

export interface Chunk { text: string; joiner: string }

function splitLong(text: string, limit: number): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = -1;
    let sep = "";
    for (const candidate of ["\n\n", "\n", " "]) {
      // Python's rfind(sep, 1, limit+1): last occurrence starting in [1, limit].
      const idx = rest.lastIndexOf(candidate, limit + 1 - candidate.length);
      if (idx > 0) { cut = idx; sep = candidate; break; }
    }
    if (cut > 0) {
      out.push([rest.slice(0, cut), sep]);
      rest = rest.slice(cut + sep.length);
    } else {
      out.push([rest.slice(0, limit), ""]);
      rest = rest.slice(limit);
    }
  }
  out.push([rest, ""]);
  return out;
}

export function splitNote(parts: string[], limit = LIMIT): Chunk[] {
  const chunks: Chunk[] = [];
  const kept = parts.filter(Boolean);
  kept.forEach((part, i) => {
    const pieces = splitLong(part, limit);
    pieces.forEach(([piece, joiner], j) => {
      const last = j === pieces.length - 1;
      chunks.push({ text: piece, joiner: last ? (i < kept.length - 1 ? PART_JOINER : "") : joiner });
    });
  });
  return chunks;
}

/** Re-join edited chunk values. An emptied chunk drops out with its separator. */
export function joinNote(values: string[], joiners: string[]): string {
  const kept: Array<[string, string]> = [];
  values.forEach((v, i) => { if ((v || "").trim()) kept.push([v, joiners[i] ?? ""]); });
  return kept.map(([v, j], i) => v + (i < kept.length - 1 ? j : "")).join("");
}
