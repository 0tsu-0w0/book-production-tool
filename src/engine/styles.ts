import type { Block } from "./types.js";
import { textBlocks } from "./blocks.js";

// 段落スタイル・文字スタイルを、段落とマスに当てる（DTP-04）。
// フォントは番号で指定する（0 は本文の書体）。どの番号がどのフォントかは呼び出し側が決める。

export interface EngineParagraphStyle {
  font: number;
  scale: number;
  lineSpan: number;
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
}

export interface EngineCharacterStyle {
  /** -1 なら段落の書体のまま。 */
  font: number;
  scale: number;
  color: string | null;
  bold: boolean;
  glyphForm?: string;
  proportional?: boolean;
}

export interface EngineStyles {
  paragraph: Map<string, EngineParagraphStyle>;
  character: Map<string, EngineCharacterStyle>;
  body: string;
  heading1: string;
  heading2: string;
}

/**
 * 段落スタイルとして、見出しには大見出し・中見出し、それ以外には本文を当てる。行頭の［＃名前］があればそちら。
 * 記法の読み取り結果は使い回すので、毎回すべてのマスに値を書き直す（前の設定を残さない）。
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
      spaceBefore: ps.spaceBefore,
      spaceAfter: ps.spaceAfter,
      keepLines: ps.keepLines,
      keepWithNext: ps.keepWithNext,
    };
    // 行頭の［＃名前］が段落スタイルでなく文字スタイルの名前なら、その行全体に文字スタイルを当てる（閉じ忘れなど）。
    const lineStyle = block.style && !styles.paragraph.has(block.style) ? styles.character.get(block.style) : undefined;
    for (const atom of block.atoms) {
      const cs = (atom.style ? styles.character.get(atom.style) : undefined) ?? lineStyle;
      for (const cell of atom.cells) {
        cell.font = cs && cs.font >= 0 ? cs.font : ps.font;
        cell.scale = ps.scale * (cs?.scale ?? 1);
        cell.bold = ps.bold || !!cs?.bold;
        cell.color = cs?.color ?? ps.color ?? undefined;
        const form = cs?.glyphForm || ps.glyphForm || "";
        if (form) cell.features = form;
        else delete cell.features;
        cell.proportional = !!(ps.proportional || cs?.proportional);
      }
    }
  }
}
