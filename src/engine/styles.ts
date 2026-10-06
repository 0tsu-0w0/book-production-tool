import type { Block } from "./types.js";
import { textBlocks } from "./blocks.js";
import { grepCellStyles, type CompiledGrep } from "./grep.js";
import { NOTE_MARK_SCALE } from "./notes.js";

// 段落スタイル・文字スタイルを、段落とマスに当てる（DTP-04）。
// フォントは番号で指定する（0 は本文の書体）。どの番号がどのフォントかは呼び出し側が決める。

export interface EngineParagraphStyle {
  font: number;
  scale: number;
  lineSpan: number;
  linePitch?: number;
  align: "start" | "center" | "end";
  indent: number;
  spaceBefore: number;
  spaceAfter: number;
  keepLines: boolean;
  keepWithNext: boolean;
  color: string | null;
  bold: boolean;
  glyphForm?: string;
  proportional?: boolean;
  deform?: "" | "condensed" | "flat";
  /** 長体・平体の割合（%）。 */
  deformRatio?: number;
  /** 正規表現スタイル（読める規則だけ）。 */
  grep?: CompiledGrep[];
}

export interface EngineCharacterStyle {
  /** -1 なら段落の書体のまま。 */
  font: number;
  scale: number;
  color: string | null;
  bold: boolean;
  glyphForm?: string;
  proportional?: boolean;
  /** 空なら段落の長体・平体のまま。 */
  deform?: "" | "condensed" | "flat";
  deformRatio?: number;
}

export interface EngineStyles {
  paragraph: Map<string, EngineParagraphStyle>;
  character: Map<string, EngineCharacterStyle>;
  /** 合成フォント：本文の書体の字のうち、かなと欧文に使う書体の番号（-1 なら本文の書体のまま）。 */
  kanaFont?: number;
  latinFont?: number;
  body: string;
  heading1: string;
  heading2: string;
}

/** 合成フォントの字の種類：かな（ひらがな・カタカナ・長音・踊り字）と欧文（半角の英数字と記号）。 */
const KANA = /^[ぁ-ゟ゠-ヿㇰ-ㇿ]+$/u;
const LATIN = /^[\x20-\x7e]+$/;
/** 全角の英数字（縦組みで半角を全角にしたもの）。合成フォントの欧文の書体では、半角の字にして組む。 */
const FULLWIDTH_ALNUM = /^[０-９Ａ-Ｚａ-ｚ]$/;

/**
 * 段落スタイルとして、見出しには大見出し・中見出し、それ以外には本文を当てる。行頭の［＃名前］があればそちら。
 * 記法の読み取り結果は使い回すので、毎回すべてのマスに値を書き直す（前の設定を残さない）。
 * マスに書くもの：書体の番号・大きさ・太字・色・字形の形（features）・プロポーショナル・長体（sx）・平体（sy）・
 * 欧文の書体で組む全角英数字の印（halfLatin）。
 * 文字スタイルは、原稿で当てたもの → 段落スタイルの正規表現スタイル → 行頭の［＃名前］が文字スタイルのとき、の順に決める。
 */
export function applyStyles(blocks: Block[], styles: EngineStyles): void {
  const body = styles.paragraph.get(styles.body)!;
  for (const block of textBlocks(blocks)) {
    const defaultName = block.kind === "heading" ? (block.level === 1 ? styles.heading1 : styles.heading2) : styles.body;
    const ps = (block.style && styles.paragraph.get(block.style)) || styles.paragraph.get(defaultName) || body;
    block.format = {
      indent: ps.indent,
      align: ps.align,
      lineSpan: ps.lineSpan,
      linePitch: ps.linePitch ?? 1,
      spaceBefore: ps.spaceBefore,
      spaceAfter: ps.spaceAfter,
      keepLines: ps.keepLines,
      keepWithNext: ps.keepWithNext,
    };
    // 行頭の［＃名前］が段落スタイルでなく文字スタイルの名前なら、その行全体に文字スタイルを当てる（閉じ忘れなど）。
    const lineStyle = block.style && !styles.paragraph.has(block.style) ? styles.character.get(block.style) : undefined;
    // 正規表現スタイル：マスごとに当てる文字スタイルの名前（当たる規則がなければ undefined）。
    const grep = ps.grep?.length ? grepCellStyles(block.atoms, ps.grep) : undefined;
    for (let ai = 0; ai < block.atoms.length; ai++) {
      const atom = block.atoms[ai];
      const own = atom.style ? styles.character.get(atom.style) : undefined;
      for (let ci = 0; ci < atom.cells.length; ci++) {
        const cell = atom.cells[ci];
        const byGrep = !own && grep?.[ai][ci];
        const cs = own ?? (byGrep ? styles.character.get(byGrep) : undefined) ?? lineStyle;
        cell.font = cs && cs.font >= 0 ? cs.font : ps.font;
        cell.halfLatin = undefined;
        // 合成フォント：本文の書体（0）の字だけ、かな・欧文を別の書体にする。
        if (cell.font === 0 && !cell.math) {
          if (styles.kanaFont !== undefined && styles.kanaFont > 0 && KANA.test(cell.text)) cell.font = styles.kanaFont;
          else if (styles.latinFont !== undefined && styles.latinFont > 0 && LATIN.test(cell.text)) cell.font = styles.latinFont;
          else if (styles.latinFont !== undefined && styles.latinFont > 0 && !cell.tcy && !cell.rotate && FULLWIDTH_ALNUM.test(cell.text)) {
            cell.font = styles.latinFont;
            cell.halfLatin = true;
          }
        }
        cell.scale = ps.scale * (cs?.scale ?? 1) * (atom.note ? NOTE_MARK_SCALE : 1);
        cell.bold = ps.bold || !!cs?.bold;
        cell.color = cs?.color ?? ps.color ?? undefined;
        const form = cs?.glyphForm || ps.glyphForm || "";
        // delete を使うとオブジェクトが遅い形に変わるので、undefined を入れる。
        cell.features = form || undefined;
        cell.proportional = !!(ps.proportional || cs?.proportional);
        // 長体・平体：字形の横（sx）か縦（sy）を縮める。文字スタイルの指定が段落スタイルより優先。
        // ここでは倍率を書くだけ。字の取る長さは applyDeform で、字形の大きさは resolveGlyph で縮める。
        const d = cs?.deform ? cs : ps.deform ? ps : undefined;
        const r = d ? (d.deformRatio ?? 80) / 100 : 1;
        cell.sx = d?.deform === "condensed" && !cell.math ? r : undefined;
        cell.sy = d?.deform === "flat" && !cell.math ? r : undefined;
      }
    }
  }
}
