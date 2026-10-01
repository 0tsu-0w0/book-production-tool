import type { Block } from "./types.js";

export type TextBlock = Extract<Block, { kind: "para" | "heading" }>;

/** 文字を持つ段落（見出しを含む）を、扉などのまとまりの中まで含めて順に返す。 */
export function textBlocks(blocks: Block[], out: TextBlock[] = []): TextBlock[] {
  for (const block of blocks) {
    if (block.kind === "para" || block.kind === "heading") out.push(block);
    else if (block.kind === "pagegroup" || block.kind === "section") textBlocks(block.blocks, out);
  }
  return out;
}
