import type { Kinsoku } from "./types.js";

// JIS X 4051 / JLREQ の分類をもとにした禁則文字。

/** どの強さでも行頭に置かない文字（終わり括弧、句読点、中点、区切り約物など）。 */
const START_BASE = "、。，．・：；？！‼⁇⁈⁉」』）］｝〕〉》】〙〗｠”’ヽヾゝゞ々〻";
/** 強い禁則でだけ行頭に置かない文字（小書きの仮名、長音記号）。 */
const START_STRONG_ONLY = "ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶㇰㇱㇲㇳㇴㇵㇶㇷㇸㇹㇺㇻㇼㇽㇾㇿー";
/** 行末に置かない文字（始め括弧）。 */
const END = "「『（［｛〔〈《【〘〖｟“‘";
/** 行末からはみ出させてよい文字（ぶら下げ）。 */
const HANGING = "、。，．";

const startStrong = new Set([...START_BASE, ...START_STRONG_ONLY]);
const startWeak = new Set([...START_BASE]);
const endSet = new Set([...END]);
const hangSet = new Set([...HANGING]);

export function isLineStartProhibited(text: string, mode: Kinsoku): boolean {
  if (mode === "none" || mode === "custom") return false;
  return (mode === "strong" ? startStrong : startWeak).has(text);
}

export function isLineEndProhibited(text: string, mode: Kinsoku): boolean {
  return mode !== "none" && mode !== "custom" && endSet.has(text);
}

export function isHangable(text: string): boolean {
  return hangSet.has(text);
}

/** 自分で決めた禁則（禁則の強さが custom のとき）。どれも字を並べて書く。 */
export interface KinsokuCustom {
  /** 行頭に置かない字。 */
  start: string;
  /** 行末に置かない字。 */
  end: string;
  /** 行末からはみ出させてよい字（ぶら下げ）。 */
  hang: string;
  /** 分離禁止：この字どうしが続くとき、間で改行しない（――・……など）。 */
  noBreak: string;
}

/** 禁則の型（自分で決めるときの出発点）。 */
export const KINSOKU_PRESETS: Record<"strong" | "weak", KinsokuCustom> = {
  strong: { start: START_BASE + START_STRONG_ONLY, end: END, hang: HANGING, noBreak: "―…‥" },
  weak: { start: START_BASE, end: END, hang: HANGING, noBreak: "―…‥" },
};

/** 行分けで使う禁則の字の集まり。 */
export interface KinsokuSets {
  start: Set<string>;
  end: Set<string>;
  hang: Set<string>;
  noBreak: Set<string>;
}

const chars = (s: string) => new Set([...s].filter((c) => !/\s/u.test(c)));
const EMPTY = new Set<string>();

/**
 * 禁則の強さ（と足す字・自分で決めた字）から、行分けで使う字の集まりを作る。
 * 強い・弱いでは足す字（詳細設定）も入れる。自分で決めるときは、決めた字だけを使う（足す字は使わない）。
 * ぶら下げは、禁則がなしでも句読点をはみ出させる（今までと同じ）。
 */
export function kinsokuSets(mode: Kinsoku, extra?: { start: string; end: string }, custom?: KinsokuCustom): KinsokuSets {
  if (mode === "custom" && custom) return { start: chars(custom.start), end: chars(custom.end), hang: chars(custom.hang), noBreak: chars(custom.noBreak) };
  if (mode === "none") return { start: EMPTY, end: EMPTY, hang: hangSet, noBreak: EMPTY };
  const start = new Set(mode === "strong" ? startStrong : startWeak);
  for (const c of chars(extra?.start ?? "")) start.add(c);
  const end = new Set(endSet);
  for (const c of chars(extra?.end ?? "")) end.add(c);
  return { start, end, hang: hangSet, noBreak: EMPTY };
}
