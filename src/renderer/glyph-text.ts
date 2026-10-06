// 字形パネルが替える字を、原稿の中から探す（画面に関係しない、文字列だけの処理）。
// 字のあとの異体字セレクタ（IVS）と［＃字形：番号］も、その字の一部として扱う。

const GLYPH_ALT_AT = /^［＃字形[：:]\s*(\d{1,2})\s*］/u;
const GLYPH_ALT_BEFORE = /［＃字形[：:]\s*\d{1,2}\s*］$/u;
const isVs = (cp: number | undefined) => cp !== undefined && ((cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef));

export interface GlyphTarget {
  /** 原稿の中の範囲（字・異体字セレクタ・［＃字形：番号］を含む）。 */
  start: number;
  end: number;
  /** 字（異体字セレクタを除く）。 */
  base: string;
  /** 付いている異体字セレクタ（コードポイント）。 */
  vs?: number;
  /** 付いている字形の候補の番号。 */
  alt?: number;
}

/** pos の直前のコードポイントの長さ（サロゲートペアなら2）。 */
function lengthBefore(text: string, pos: number): number {
  if (pos <= 0) return 0;
  const low = text.charCodeAt(pos - 1);
  return pos >= 2 && low >= 0xdc00 && low <= 0xdfff ? 2 : 1;
}

/**
 * 字形を替える字を探す。選んでいれば選んだ所の最初の字、選んでいなければカーソルの直前の字。
 * 空白・記法の括弧（［］）・改行は替えない（null）。
 */
export function glyphTarget(text: string, selStart: number, selEnd: number): GlyphTarget | null {
  let start: number;
  if (selEnd > selStart) {
    start = selStart;
  } else {
    let p = selStart;
    const tail = GLYPH_ALT_BEFORE.exec(text.slice(Math.max(0, p - 12), p));
    if (tail) p -= tail[0].length;
    if (isVs(text.codePointAt(p - lengthBefore(text, p)))) p -= lengthBefore(text, p);
    start = p - lengthBefore(text, p);
    if (start < 0 || p === 0) return null;
  }
  const cp = text.codePointAt(start);
  if (cp === undefined) return null;
  const base = String.fromCodePoint(cp);
  if (/^[\s［］＃]$/u.test(base) || isVs(cp)) return null;
  let i = start + base.length;
  const target: GlyphTarget = { start, end: i, base };
  const next = text.codePointAt(i);
  if (isVs(next)) {
    target.vs = next;
    i += String.fromCodePoint(next!).length;
  }
  const m = GLYPH_ALT_AT.exec(text.slice(i, i + 12));
  if (m) {
    target.alt = Number(m[1]);
    i += m[0].length;
  }
  target.end = i;
  return target;
}

/** 選んだ字形の書き方：元の字形なら字だけ、異体字なら字＋異体字セレクタ、字形の候補なら字＋［＃字形：番号］。 */
export function glyphText(base: string, kind: "base" | "ivs" | "alt", value: number): string {
  if (kind === "ivs") return base + String.fromCodePoint(value);
  if (kind === "alt") return `${base}［＃字形：${value}］`;
  return base;
}
