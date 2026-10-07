import type { NestedStyle } from "../document/styles.js";
import type { Atom } from "./types.js";

// 先頭文字スタイル（InDesign の先頭文字スタイルにあたる）：段落の頭から順に、決めた範囲の字に文字スタイルを当てる。
// 規則は上から順に使う。1つ目の規則の範囲が終わったら、続きの字から2つ目の規則、…と進む。
//   chars   … N字まで
//   through … 区切りの字の N 個目まで（区切りの字も含む）
//   before  … 区切りの字の N 個目の前まで（区切りの字は含まない）
// 区切りの字が見つからなければ、段落の終わりまで。文字スタイルが空の規則（なし）は、範囲だけ進める。

/** マスごとに当てる文字スタイルの名前（当たらなければ undefined）。Atom・マスの並びと同じ形。 */
export function nestedCellStyles(atoms: Atom[], rules: NestedStyle[]): (string | undefined)[][] {
  const out = atoms.map((a) => a.cells.map((): string | undefined => undefined));
  let ri = 0;
  // 今の規則で、数えた字数か、見つけた区切りの字の数。
  let n = 0;
  for (let ai = 0; ai < atoms.length && ri < rules.length; ai++) {
    const cells = atoms[ai].cells;
    for (let ci = 0; ci < cells.length && ri < rules.length; ci++) {
      const text = cells[ci].text;
      // このマスを当てるまで、範囲の終わった規則を飛ばす。
      while (ri < rules.length) {
        const r = rules[ri];
        const count = Math.max(1, r.count);
        if (r.until === "chars") {
          if (n >= count) {
            ri++;
            n = 0;
            continue;
          }
          out[ai][ci] = r.style || undefined;
          n += Math.max(1, [...text].length);
          break;
        }
        const delim = [...text].some((ch) => (r.chars || "　").includes(ch));
        if (r.until === "before" && delim && n + 1 >= count) {
          // 区切りの字は含めず、次の規則へ（このマスは次の規則で当てる）。
          ri++;
          n = 0;
          continue;
        }
        out[ai][ci] = r.style || undefined;
        if (delim) n++;
        if (r.until === "through" && delim && n >= count) {
          ri++;
          n = 0;
        }
        break;
      }
    }
  }
  return out;
}
