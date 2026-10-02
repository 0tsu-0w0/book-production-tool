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

/**
 * 書き出すページの範囲を、ページの名前（pageLabels）で読む。数はノンブル（本文の番号）、
 * i・ii…（ローマ数字）は前付けのページ。空なら全ページ。返すのはページの通し番号（0 始まり）。
 */
export function parseLabeledRange(text: string, labels: string[]): Set<number> {
  const out = new Set<number>();
  const numbers = labels.map((l) => (/^\d+$/.test(l) ? Number(l) : null));
  const known = numbers.filter((n): n is number => n !== null);
  const src = text
    .replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0))
    .replace(/[－〜～ー―]/g, "-")
    .replace(/[、，]/g, ",");
  if (src.trim() === "") {
    labels.forEach((_, i) => out.add(i));
    return out;
  }
  const romanIndex = (r: string) => labels.findIndex((l) => l === r.toLowerCase());
  for (const part of src.split(",").map((p) => p.trim()).filter(Boolean)) {
    const roman = /^([ivxlcdm]+)\s*(?:-\s*([ivxlcdm]*))?$/i.exec(part);
    if (roman) {
      const from = romanIndex(roman[1]);
      const to = roman[2] === undefined ? from : roman[2] === "" ? labels.findLastIndex((l) => !/^\d+$/.test(l)) : romanIndex(roman[2]);
      if (from < 0 || to < 0) throw new RangeError_(`ページ「${part}」は前付けにありません。`);
      if (from > to) throw new RangeError_(`ページの範囲「${part}」は、始まりが終わりより後ろです。`);
      for (let i = from; i <= to; i++) out.add(i);
      continue;
    }
    const m = /^(\d*)\s*(-?)\s*(\d*)$/.exec(part);
    if (!m || (m[1] === "" && m[3] === "") || (m[2] === "" && m[3] !== "")) throw new RangeError_(`ページの範囲「${part}」が読めません（例：1-10, 15, 20-、前付けは i-iii）。`);
    const from = m[1] === "" ? Math.min(...known) : Number(m[1]);
    const to = m[2] === "" ? from : m[3] === "" ? Math.max(...known) : Number(m[3]);
    if (from > to) throw new RangeError_(`ページの範囲「${part}」は、始まりが終わりより後ろです。`);
    numbers.forEach((n, i) => {
      if (n !== null && n >= from && n <= to) out.add(i);
    });
  }
  if (out.size === 0) throw new RangeError_(`範囲「${text}」に入るページがありません（${labels[0]}〜${labels[labels.length - 1]}ページ）。`);
  return out;
}
