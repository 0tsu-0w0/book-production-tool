import type { GrepRule } from "../document/styles.js";
import type { Atom } from "./types.js";

// 正規表現スタイル（InDesign の GREP スタイルにあたる）。段落スタイルに「この正規表現に合う字に、この文字スタイルを当てる」
// という規則を持たせる。原稿に［＃名前］…［＃／名前］と書かなくても、数字だけ・欧文だけ・かぎかっこの中だけなどに
// 文字スタイルが当たる。原稿で文字スタイルを当てた字は、そちらが優先（正規表現スタイルは当てない）。
// 規則が重なった字には、あとの規則が当たる。英数字は全角・半角のどちらで書いても合う（[0-9] は「２」にも合う）。

export interface CompiledGrep {
  re: RegExp;
  /** 当てる文字スタイルの名前。 */
  style: string;
}

/** 正規表現として読めなければ、その理由（読めれば null）。設定欄で知らせるのに使う。 */
export function grepError(pattern: string): string | null {
  if (!pattern) return "正規表現が空です。";
  try {
    new RegExp(pattern, "gu");
  } catch {
    // ブラウザーの知らせは英語なので、よくある原因を日本語で添える。
    return "正規表現として読めません（かっこ ( ) [ ] の閉じ忘れ、\\ で終わっている、などを確かめてください）。";
  }
  // 何の字にも合わない幅0の規則（^ だけなど）は、字に当てられない。
  if (new RegExp(`^(?:${pattern})$`, "u").test("")) return "空の文字列にも合うので、字に当てられません（* を + にするなど）。";
  return null;
}

/** 規則を組版で使える形にする。読めない正規表現・空の正規表現・ない文字スタイルの規則は外す。 */
export function compileGrep(rules: readonly GrepRule[] | undefined, characterStyles: ReadonlySet<string>): CompiledGrep[] {
  const out: CompiledGrep[] = [];
  for (const r of rules ?? []) {
    if (!characterStyles.has(r.style) || grepError(r.pattern)) continue;
    out.push({ re: new RegExp(r.pattern, "gu"), style: r.style });
  }
  return out;
}

/**
 * 段落の字（マス）ごとに、正規表現スタイルで当てる文字スタイルの名前を返す（atoms と同じ並びの、マスごとの配列）。
 * 当たる規則がなければ undefined。ルビ・圏点の字は親文字の側で数える（ルビの字そのものには合わせない）。
 */
export function grepCellStyles(atoms: readonly Atom[], rules: readonly CompiledGrep[]): (string | undefined)[][] | undefined {
  if (rules.length === 0) return undefined;
  // 段落の字をつないだ文字列と、各マスがその中のどこにあるか。
  let text = "";
  const starts: number[][] = [];
  for (const a of atoms) {
    const row: number[] = [];
    for (const c of a.cells) {
      row.push(text.length);
      text += c.text;
    }
    starts.push(row);
  }
  if (!text) return undefined;
  // 縦組みでは、原稿の半角の英数字が全角になっている（4桁以上の数字など）。原稿のとおりに書いた正規表現でも合うよう、
  // 全角の英数字・記号を半角にした文字列でも探す（字数は変わらないので、位置はそのまま使える）。
  const half = text.replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  // 字の位置ごとの文字スタイル（あとの規則で上書きする）。
  const at: (string | undefined)[] = new Array(text.length);
  let any = false;
  for (const r of rules) {
    for (const t of half === text ? [text] : [text, half]) {
      for (const m of t.matchAll(r.re)) {
        const from = m.index;
        const to = from + m[0].length;
        for (let i = from; i < to; i++) at[i] = r.style;
        if (to > from) any = true;
      }
    }
  }
  if (!any) return undefined;
  // マスの字のうち、どれかが合っていれば、そのマスに当てる（縦中横の「12」の片方だけが合ったときなど）。
  return atoms.map((a, ai) =>
    a.cells.map((c, ci) => {
      const s = starts[ai][ci];
      for (let i = s; i < s + c.text.length; i++) if (at[i]) return at[i];
      return undefined;
    }),
  );
}
