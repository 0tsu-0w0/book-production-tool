import type { TocSettings } from "../document/settings.js";
import { TOC_ENTRY_STYLES, TOC_TITLE_STYLE } from "../document/styles.js";
import { textBlocks, type TextBlock } from "./blocks.js";
import { toFullWidth } from "./parse.js";
import type { Atom, Block, PageLayout } from "./types.js";

// 目次（DTP-14）。見出しから項目を作り、［＃目次］の場所（またはページ構成の「目次」）に置く。
// ページ番号は組んでみないとわからないので、仮の番号で組み、見出しのページを調べて番号を入れ直す。
// 目次のページ数が変わると番号もずれるので、番号が変わらなくなるまで繰り返す（ふつうは2回）。

const KANJI_DIGITS = "〇一二三四五六七八九";
/** 組み直しの上限（目次の長さと番号が行ったり来たりする場合のため）。 */
const MAX_PASSES = 4;

export function hasToc(blocks: Block[]): boolean {
  return blocks.some((b) => b.kind === "toc" || ((b.kind === "pagegroup" || b.kind === "section") && hasToc(b.blocks)));
}

/** 原稿のすべての見出し（扉の中のものも含む、出てくる順）。 */
export function headingBlocks(blocks: Block[]): Extract<TextBlock, { kind: "heading" }>[] {
  return textBlocks(blocks).filter((b): b is Extract<TextBlock, { kind: "heading" }> => b.kind === "heading");
}

/** 組んだページから、見出しごとのページ番号を出てくる順に取り出す。 */
export function headingPageNumbers(pages: PageLayout[], firstPageNumber: number): number[] {
  return pages.flatMap((p) => p.headings.map(() => firstPageNumber + p.index));
}

function numberAtoms(n: number, numerals: TocSettings["numerals"]): Atom[] {
  const digits = String(n);
  if (numerals === "kanji") return [...digits].map((d) => ({ cells: [{ text: KANJI_DIGITS[Number(d)] }] }));
  // 2〜3桁は縦中横で1字分に、1桁と4桁以上は全角で1字ずつ。
  if (digits.length >= 2 && digits.length <= 3) return [{ cells: [{ text: digits, tcy: true }] }];
  return [...toFullWidth(digits)].map((d) => ({ cells: [{ text: d }] }));
}

/** 見出しの字を写す（ルビは外す）。スタイルを当てるとマスの値が書き換わるので、元の見出しと共有しない。 */
function copyAtoms(atoms: Atom[]): Atom[] {
  return atoms.map((a) => ({ cells: a.cells.map((c) => ({ text: c.text, ...(c.tcy ? { tcy: true } : {}), ...(c.rotate ? { rotate: true } : {}) })) }));
}

/** 目次の段落（題と項目）。numbers は headings と同じ並び。 */
export function tocBlocks(headings: Extract<TextBlock, { kind: "heading" }>[], numbers: number[], t: TocSettings): Block[] {
  const out: Block[] = [];
  if (t.title) out.push({ kind: "para", style: TOC_TITLE_STYLE, atoms: [...t.title].map((ch) => ({ cells: [{ text: ch }] })) });
  headings.forEach((h, i) => {
    if (h.level > t.levels) return;
    out.push({
      kind: "para",
      style: TOC_ENTRY_STYLES[h.level - 1],
      atoms: [...copyAtoms(h.atoms), { cells: [{ text: t.leader || "…" }], leader: true }, ...numberAtoms(numbers[i] ?? 0, t.numerals)],
    });
  });
  return out;
}

/** ［＃目次］の置き場所を、目次の段落のまとまり（新しいページから始まる）に置き換える。 */
export function expandToc(blocks: Block[], toc: Block[]): Block[] {
  return blocks.map((b): Block => {
    if (b.kind === "toc") return { kind: "section", role: "toc", blocks: toc };
    if (b.kind === "pagegroup" || b.kind === "section") return { ...b, blocks: expandToc(b.blocks, toc) };
    return b;
  });
}

/**
 * 目次を入れて組む。prepare は段落にスタイルや字幅を当てる処理（組むたびに目次の段落にも当てる）。
 * 見出しのページ番号が変わらなくなったら、その組版を返す。
 */
export function layoutWithToc(
  blocks: Block[],
  t: TocSettings,
  firstPageNumber: number,
  prepare: (blocks: Block[]) => void,
  layout: (blocks: Block[]) => PageLayout[],
): { blocks: Block[]; pages: PageLayout[] } {
  const headings = headingBlocks(blocks);
  // 仮の番号：見出しの数だけ同じ幅（3桁）の番号を入れておく。
  let numbers = headings.map(() => 100);
  let result = { blocks, pages: [] as PageLayout[] };
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const toc = tocBlocks(headings, numbers, t);
    const expanded = expandToc(blocks, toc);
    // 本文の段落は2回目からは変わらないので、目次の段落だけに当て直す。
    prepare(pass === 0 ? expanded : toc);
    result = { blocks: expanded, pages: layout(expanded) };
    const next = headingPageNumbers(result.pages, firstPageNumber);
    if (next.length === numbers.length && next.every((n, i) => n === numbers[i])) break;
    numbers = next;
  }
  return result;
}
