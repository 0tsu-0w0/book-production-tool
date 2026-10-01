// 書き出すページの範囲（OUT-07）。「1-10, 15, 20-」のように、ノンブル（ページ番号）で書く。
// 空なら全ページ。「-5」は最初から5ページまで、「20-」は20ページから最後まで。

export class RangeError_ extends Error {}

/** 範囲の文字列を、0 始まりのページの通し番号の集合にする。書き方が誤っていれば RangeError_。 */
export function parsePageRange(text: string, firstPageNumber: number, pageCount: number): Set<number> {
  const out = new Set<number>();
  const last = firstPageNumber + pageCount - 1;
  const src = text.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0)).replace(/[－〜～ー―]/g, "-").replace(/[、，]/g, ",");
  if (src.trim() === "") {
    for (let i = 0; i < pageCount; i++) out.add(i);
    return out;
  }
  for (const part of src.split(",").map((p) => p.trim()).filter(Boolean)) {
    const m = /^(\d*)\s*(-?)\s*(\d*)$/.exec(part);
    if (!m || (m[1] === "" && m[3] === "") || (m[2] === "" && m[3] !== "")) throw new RangeError_(`ページの範囲「${part}」が読めません（例：1-10, 15, 20-）。`);
    const from = m[1] === "" ? firstPageNumber : Number(m[1]);
    const to = m[2] === "" ? from : m[3] === "" ? last : Number(m[3]);
    if (from > to) throw new RangeError_(`ページの範囲「${part}」は、始まりが終わりより後ろです。`);
    for (let n = Math.max(from, firstPageNumber); n <= Math.min(to, last); n++) out.add(n - firstPageNumber);
  }
  if (out.size === 0) throw new RangeError_(`範囲「${text}」に入るページがありません（${firstPageNumber}〜${last}ページ）。`);
  return out;
}
