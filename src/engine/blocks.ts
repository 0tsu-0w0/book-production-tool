import type { Block } from "./types.js";

export type TextBlock = Extract<Block, { kind: "para" | "heading" }>;

/** 文字を持つ段落（見出しを含む）を、扉などのまとまりの中まで含めて順に返す。 */
export function textBlocks(blocks: Block[], out: TextBlock[] = []): TextBlock[] {
  for (const block of blocks) {
    if (block.kind === "para" || block.kind === "heading") {
      out.push(block);
      // ページごとの注の段落も、スタイルを当てて組む。
      for (const a of block.atoms) if (a.noteBlock) out.push(a.noteBlock);
    }
    else if (block.kind === "image" && block.caption) out.push(block.caption);
    else if (block.kind === "table") for (const row of block.rows) out.push(...row.cells);
    else if (block.kind === "pagegroup" || block.kind === "section") textBlocks(block.blocks, out);
  }
  return out;
}
