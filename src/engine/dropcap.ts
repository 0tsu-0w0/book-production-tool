import type { Atom } from "./types.js";

// ドロップキャップ：段落の頭の字を大きくして、何行かにまたがらせる（InDesign のドロップキャップにあたる）。
// 大きな字の幅（行の並ぶ向き）は、またがる行の幅と同じ。字の長さ（行の向き）も同じだけ取り、
// またがる行はその分だけ下げて始める（下げる量は1字単位に切り上げる。字詰めのグリッドがずれないように）。

/**
 * 段落の頭から、大きくする字の Atom と、残りの Atom に分ける。
 * 頭の空白（字下げの全角の空白など）は落とす。割注・注・ページ参照・数式・横倒しの字・箇条書きの印の所で止める。
 * 大きくする字がなければ undefined。
 */
export function splitDropCap(atoms: readonly Atom[], chars: number): { cap: Atom[]; rest: Atom[] } | undefined {
  if (atoms[0]?.listMark) return undefined;
  let i = 0;
  while (i < atoms.length && atoms[i].cells.length > 0 && atoms[i].cells.every((c) => /^\s*$/u.test(c.text)) && !atoms[i].note) i++;
  const cap: Atom[] = [];
  let n = 0;
  for (; i < atoms.length && n < chars; i++) {
    const a = atoms[i];
    if (a.warichu !== undefined || a.note || a.pageRef || a.leader || a.cells.some((c) => c.math || c.rotate || /^\s*$/u.test(c.text))) break;
    cap.push(a);
    n += a.cells.length;
  }
  return cap.length > 0 ? { cap, rest: atoms.slice(i) } : undefined;
}

/** 大きな字の大きさ（本文の字に対する倍率）：またがる行の幅。lineGap は行送り（字の大きさに対する倍率）、span は1行の行取り。 */
export function dropCapScale(lines: number, lineGap: number, span: number): number {
  return (lines - 1) * lineGap * span + 1;
}
