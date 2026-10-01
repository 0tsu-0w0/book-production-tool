import { createRequire } from "node:module";

// 欧文のハイフネーション（横組み）。英語の分綴のパターン（hyphen パッケージ、ISC。パターンは TeX の hyph-en-us）で、
// 単語を分けてよい位置を求める。行末に入らない長い単語を、そこで「-」を付けて分ける。

type Hyphenator = { hyphenateSync(text: string, options?: { hyphenChar?: string; minWordLength?: number }): string };

let hyphenator: Hyphenator | null | undefined;
const cache = new Map<string, number[]>();
/** 分けてよい語の長さ（字）。これより短い語は分けない。 */
const MIN_WORD = 6;

function load(): Hyphenator | null {
  if (hyphenator !== undefined) return hyphenator;
  try {
    hyphenator = createRequire(import.meta.url)("hyphen/en-us") as Hyphenator;
  } catch {
    hyphenator = null;
  }
  return hyphenator;
}

/**
 * 単語（英字だけの部分）を分けてよい位置（先頭からの字数）。句読点や引用符は前後に付いていてよい。
 * 分けた前半は2字以上、後半は3字以上（パターンの既定）。
 */
export function hyphenPoints(word: string): number[] {
  const m = /^([^A-Za-z]*)([A-Za-z]+)([^A-Za-z]*)$/.exec(word);
  if (!m || m[2].length < MIN_WORD) return [];
  const core = m[2];
  let points = cache.get(core);
  if (!points) {
    const h = load();
    points = [];
    if (h) {
      const parts = h.hyphenateSync(core, { hyphenChar: "­", minWordLength: MIN_WORD }).split("­");
      let at = 0;
      for (const p of parts.slice(0, -1)) points.push((at += p.length));
    }
    if (cache.size > 20000) cache.clear();
    cache.set(core, points);
  }
  return points.map((p) => p + m[1].length);
}
