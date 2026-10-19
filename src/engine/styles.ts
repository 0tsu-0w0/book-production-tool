import { hasDecoration, type ParagraphDecoration } from "../document/styles.js";
import type { Block } from "./types.js";
import { textBlocks } from "./blocks.js";
import { splitDropCap } from "./dropcap.js";
import { grepCellStyles, type CompiledGrep } from "./grep.js";
import { nestedCellStyles } from "./nested.js";
import { NOTE_MARK_SCALE } from "./notes.js";
import type { LineStyle, NestedStyle } from "../document/styles.js";

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
  /** 段抜き（段組みのとき、すべての段をまたぐ）。 */
  spanColumns?: boolean;
  color: string | null;
  bold: boolean;
  glyphForm?: string;
  proportional?: boolean;
  deform?: "" | "condensed" | "flat";
  /** 長体・平体の割合（%）。 */
  deformRatio?: number;
  /** 正規表現スタイル（読める規則だけ）。 */
  grep?: CompiledGrep[];
  /** 段落の罫線・囲み罫・網掛け。 */
  decoration?: ParagraphDecoration;
  /** ドロップキャップ。 */
  dropCap?: { lines: number; chars: number; style: string };
  /** 字間（トラッキング。全角1字の 1/1000）。 */
  tracking?: number;
  /** 先頭文字スタイル。 */
  nested?: NestedStyle[];
  /** ルビの揃え・側（空なら文書の設定）。 */
  rubyAlign?: "" | "121" | "center" | "shoulder";
  rubySide?: "" | "right" | "left";
  /** 行スタイル。 */
  lineStyle?: LineStyle;
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
  /** 字間（全角1字の 1/1000）。0 なら段落の字間のまま。 */
  tracking?: number;
  rubyAlign?: "" | "121" | "center" | "shoulder";
  rubySide?: "" | "right" | "left";
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
      ...(ps.spanColumns ? { spanColumns: true } : {}),
      ...(hasDecoration(ps.decoration) ? { deco: ps.decoration } : {}),
      ...(ps.dropCap && ps.dropCap.lines >= 2 ? { dropCap: { lines: ps.dropCap.lines, chars: ps.dropCap.chars } } : {}),
    };
    // 行スタイル：どの行に当たるかは行に分けてから決まるので、ここでは当てるものだけを段落に書く（組むときに行の字へ当てる）。
    const ls = ps.lineStyle && ps.lineStyle.lines > 0 ? styles.character.get(ps.lineStyle.style) : undefined;
    if (ls) {
      block.format.lineStyle = {
        lines: ps.lineStyle!.lines,
        font: ls.font,
        bold: ls.bold,
        ...(ls.color ? { color: ls.color } : {}),
        ...(ls.glyphForm ? { features: ls.glyphForm } : {}),
        ...(ls.scale !== 1 ? { scale: ls.scale } : {}),
        ...(ls.tracking ? { tracking: ls.tracking } : {}),
      };
    }
    // 行頭の［＃名前］が段落スタイルでなく文字スタイルの名前なら、その行全体に文字スタイルを当てる（閉じ忘れなど）。
    const lineStyle = block.style && !styles.paragraph.has(block.style) ? styles.character.get(block.style) : undefined;
    // 正規表現スタイル：マスごとに当てる文字スタイルの名前（当たる規則がなければ undefined）。
    const grep = ps.grep?.length ? grepCellStyles(block.atoms, ps.grep) : undefined;
    // 先頭文字スタイル：段落の頭から順に当てる文字スタイルの名前。
    const nested = ps.nested?.length ? nestedCellStyles(block.atoms, ps.nested) : undefined;
    for (let ai = 0; ai < block.atoms.length; ai++) {
      const atom = block.atoms[ai];
      const own = atom.style ? styles.character.get(atom.style) : undefined;
      for (let ci = 0; ci < atom.cells.length; ci++) {
        const cell = atom.cells[ci];
        // 当てる順：原稿の文字スタイル → 正規表現スタイル → 先頭文字スタイル → 行頭の［＃名前］。
        const byGrep = !own && grep?.[ai][ci];
        const byNested = !own && !byGrep && nested?.[ai][ci];
        const cs = own ?? (byGrep ? styles.character.get(byGrep) : undefined) ?? (byNested ? styles.character.get(byNested) : undefined) ?? lineStyle;
        cell.charStyled = !!cs || undefined;
        // 行スタイルで大きさ・字間を変えた印は、組むたびに付け直す。
        cell.lineOrig = undefined;
        // ルビの揃え・側：文字スタイル → 段落スタイル（空なら文書の設定）。
        cell.rubyAlign = cs?.rubyAlign || ps.rubyAlign || undefined;
        cell.rubySide = cs?.rubySide || ps.rubySide || undefined;
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
        // 字形の候補（［＃字形：番号］）は、スタイルの字形に足す。
        // delete を使うとオブジェクトが遅い形に変わるので、undefined を入れる。
        cell.features = cell.alt ? (form ? `${form},aalt=${cell.alt}` : `aalt=${cell.alt}`) : form || undefined;
        cell.proportional = !!(ps.proportional || cs?.proportional);
        // 長体・平体：字形の横（sx）か縦（sy）を縮める。文字スタイルの指定が段落スタイルより優先。
        // ここでは倍率を書くだけ。字の取る長さは applyDeform で、字形の大きさは resolveGlyph で縮める。
        const d = cs?.deform ? cs : ps.deform ? ps : undefined;
        const r = d ? (d.deformRatio ?? 80) / 100 : 1;
        cell.sx = d?.deform === "condensed" && !cell.math ? r : undefined;
        cell.sy = d?.deform === "flat" && !cell.math ? r : undefined;
        // 字間：原稿の［＃字間］→ 文字スタイル（0 なら段落のまま）→ 段落スタイル。カーニングは足す。
        const tracking = cell.tracking ?? (cs?.tracking ? cs.tracking : (ps.tracking ?? 0));
        cell.letterSpace = (tracking + (cell.kern ?? 0)) / 1000 || undefined;
      }
    }
    // ドロップキャップの大きな字：指定した文字スタイルの書体・色・太字・字形を当てる（大きさは組むときに決める）。
    const dropStyle = block.format.dropCap && ps.dropCap?.style ? styles.character.get(ps.dropCap.style) : undefined;
    if (dropStyle) {
      for (const atom of splitDropCap(block.atoms, block.format.dropCap!.chars)?.cap ?? []) {
        for (const cell of atom.cells) {
          if (dropStyle.font >= 0) cell.font = dropStyle.font;
          if (dropStyle.color) cell.color = dropStyle.color;
          if (dropStyle.bold) cell.bold = true;
          if (dropStyle.glyphForm) cell.features = dropStyle.glyphForm;
        }
      }
    }
  }
}
