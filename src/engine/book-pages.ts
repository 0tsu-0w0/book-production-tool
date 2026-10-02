import type { BookInfo, PageItem, PageStructure } from "../document/settings.js";
import { AUTHOR_STYLE, COLOPHON_STYLE, TITLE_STYLE } from "../document/styles.js";
import { parse, type ParseOptions } from "./parse.js";
import type { Block } from "./types.js";

// 本文の前後に入れるページ（本扉・白ページ・奥付・自由なページ）を、組版エンジンの段落にする（DTP-13）。
// 中身は原稿と同じ記法の文字列として作り、同じ読み取りを通す（スタイルがそのまま当たる）。

const lines = (s: string) => s.split(/\r\n?|\n/).filter((l) => l.trim() !== "");

/** 本扉：書名を中央に大きく、著者名を地付きに。 */
export function titlePageText(info: BookInfo): string {
  const out: string[] = [];
  if (info.title) out.push(`［＃${TITLE_STYLE}］${info.title}`);
  if (info.title && info.author) out.push("", "");
  if (info.author) out.push(`［＃${AUTHOR_STYLE}］${info.author}`);
  return out.join("\n");
}

/** 奥付：書名、発行日と版、著者・発行・印刷、そのほか。空の項目は出さない。 */
export function colophonText(info: BookInfo): string {
  const sections: string[][] = [
    info.title ? [info.title] : [],
    lines(info.issued),
    [
      ...(info.author ? [`著者　${info.author}`] : []),
      ...(info.publisher ? [`発行　${info.publisher}`] : []),
      ...(info.printer ? [`印刷　${info.printer}`] : []),
    ],
    lines(info.extra),
  ].filter((sec) => sec.length > 0);
  return sections.map((sec) => sec.map((l) => `［＃${COLOPHON_STYLE}］${l}`).join("\n")).join("\n\n");
}

function itemBlocks(item: PageItem, info: BookInfo, opts: ParseOptions): Block[] {
  switch (item.kind) {
    case "blank":
      return [{ kind: "blankpage" }];
    case "title":
      return [{ kind: "pagegroup", role: "title", place: "center", blocks: parse(titlePageText(info), opts) }];
    case "colophon":
      // 奥付は版面の最後の行の側（左端）に寄せる。
      return [{ kind: "pagegroup", role: "colophon", place: "end", blocks: parse(colophonText(info), opts) }];
    case "toc":
      return [{ kind: "toc" }];
    case "index":
      return [{ kind: "indexpage" }];
    case "free":
      return [{ kind: "pagegroup", role: "free", place: "center", blocks: parse(item.text, opts) }];
  }
}

/** 本文の前に入れる段落と、後ろに入れる段落（総ページ数をそろえる白ページの指定を含む）。 */
export function bookPageBlocks(pages: PageStructure, info: BookInfo, opts: ParseOptions): { front: Block[]; back: Block[] } {
  const front = pages.front.flatMap((i) => itemBlocks(i, info, opts));
  const back = pages.back.flatMap((i) => itemBlocks(i, info, opts));
  if (pages.padTo > 1) back.unshift({ kind: "pad", multiple: pages.padTo, reserve: pages.back.length });
  return { front, back };
}
