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
  if (mode === "none") return false;
  return (mode === "strong" ? startStrong : startWeak).has(text);
}

export function isLineEndProhibited(text: string, mode: Kinsoku): boolean {
  return mode !== "none" && endSet.has(text);
}

export function isHangable(text: string): boolean {
  return hangSet.has(text);
}
