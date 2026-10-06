import { textBlocks, type TextBlock } from "./blocks.js";
import { toFullWidth } from "./parse.js";
import type { Atom, Block } from "./types.js";

// 相互参照（InDesign の相互参照にあたる）：ラベル（［＃ラベル：名前］）のある所の見出しの字・章の題・ページ番号を、書式どおりに入れる。
//   ［＃見出し：名前］ … ラベルのある所の見出し（ラベルが見出しの中ならその見出し、本文の中ならその前の最後の見出し）
//   ［＃章：名前］     … ラベルのある所の章（その前の最後の大見出し）
//   ［＃参照：名前］   … 「見出し」（Nページ）。［＃参照：名前｜書式］で書式を決める（〈見出し〉〈章〉〈ページ〉を入れる）
// 見出しの字は原稿から決まるので、組む前に字に開く。ページ番号は［＃ページ：名前］と同じく、組んでから入れる。

export { XREF_FORMAT, XREF_KINDS } from "./xref-kinds.js";
const FIELD = /(〈見出し〉|〈章〉|〈ページ〉)/u;

/** ラベルのある所の見出しと章。 */
interface Place {
  heading?: Atom[];
  chapter?: Atom[];
}

/** 原稿を順になめて、ラベルごとに、その所の見出しと章を調べる（同じ名前のラベルは最初のもの）。 */
function labelPlaces(blocks: Block[]): Map<string, Place> {
  const out = new Map<string, Place>();
  let heading: Atom[] | undefined;
  let chapter: Atom[] | undefined;
  const mark = (name: string) => {
    if (!out.has(name)) out.set(name, { heading, chapter });
  };
  const text = (b: TextBlock) => {
    for (const a of b.atoms) if (a.label) mark(a.label);
  };
  const walk = (bs: Block[]) => {
    for (const b of bs) {
      if (b.kind === "heading") {
        heading = b.atoms;
        if (b.level === 1) chapter = b.atoms;
        text(b);
      } else if (b.kind === "anchor") mark(b.name);
      else if (b.kind === "pagegroup" || b.kind === "section") walk(b.blocks);
      else for (const t of textBlocks([b])) text(t);
    }
  };
  walk(blocks);
  return out;
}

/** 見出しの字を写す（ルビ・注・参照は外す。スタイルを当てるとマスの値が書き換わるので、元の見出しと共有しない）。 */
function copyHeading(atoms: Atom[]): Atom[] {
  return atoms
    .filter((a) => !a.note && !a.xref && !a.pageRef && !a.leader && !a.listMark && a.warichu === undefined)
    .map((a) => ({ cells: a.cells.map((c) => ({ text: c.text, ...(c.tcy ? { tcy: true } : {}), ...(c.rotate ? { rotate: true } : {}) })) }));
}

/** 書式からページ番号の所を除く（EPUB ではページ番号がないので）。「（〈ページ〉ページ）」のような括弧ごと除く。 */
export function withoutPage(format: string): string {
  return format.replace(/[（(][^（）()〈〉]*〈ページ〉[^（）()〈〉]*[）)]|[^「」『』（）()〈〉]*〈ページ〉[^「」『』（）()〈〉]*/gu, "");
}

/** 参照の Atom を、書式どおりの字の Atom に開く。どの字も参照先へのリンクにする。 */
function xrefAtoms(a: Atom, places: Map<string, Place>, epub: boolean): Atom[] {
  const { name, format } = a.xref!;
  const place = places.get(name);
  const src = a.cells[0]?.src;
  const fmt = epub ? withoutPage(format) || "〈ページ〉" : format;
  const out: Atom[] = [];
  for (const part of fmt.split(FIELD)) {
    if (part === "") continue;
    if (part === "〈ページ〉") {
      // 番号は組んでから入れる（それまでは仮に3桁分）。EPUB ではリンクの印になる。
      out.push({ cells: [{ text: "000", tcy: true }], pageRef: name });
      continue;
    }
    const field = part === "〈見出し〉" ? place?.heading : part === "〈章〉" ? place?.chapter : undefined;
    if (part === "〈見出し〉" || part === "〈章〉") {
      out.push(...(field && field.length > 0 ? copyHeading(field) : [{ cells: [{ text: "？" }] }]));
      continue;
    }
    for (const ch of part) out.push({ cells: [{ text: toFullWidth(ch) }] });
  }
  return out.map((x) => ({
    ...x,
    ...(a.style ? { style: a.style } : {}),
    ...(x.pageRef ? {} : { link: `l:${name}` }),
    cells: x.cells.map((c) => ({ ...c, ...(src !== undefined ? { src } : {}), ...(a.cells[0]?.tracking !== undefined ? { tracking: a.cells[0].tracking } : {}) })),
  }));
}

/** 原稿に参照（［＃見出し：］・［＃章：］・［＃参照：］）があるか。 */
export function hasXref(blocks: Block[]): boolean {
  return textBlocks(blocks).some((b) => b.atoms.some((a) => a.xref));
}

/**
 * 参照を字に開いた原稿を返す。参照のある段落だけを新しい段落にする（記法の読み取り結果は使い回すので、元の段落は変えない）。
 * epub なら、ページ番号の所は除く（ページ番号しかない書式なら、リンクの印にする）。
 */
export function expandXrefs(blocks: Block[], epub = false): Block[] {
  if (!hasXref(blocks)) return blocks;
  const places = labelPlaces(blocks);
  const para = <T extends TextBlock>(b: T): T => (b.atoms.some((a) => a.xref) ? { ...b, atoms: b.atoms.flatMap((a) => (a.xref ? xrefAtoms(a, places, epub) : [a])) } : b);
  const map = (bs: Block[]): Block[] =>
    bs.map((b): Block => {
      switch (b.kind) {
        case "para":
        case "heading":
          return para(b);
        case "pagegroup":
        case "section":
          return { ...b, blocks: map(b.blocks) };
        case "image":
          return b.caption ? { ...b, caption: para(b.caption) } : b;
        case "table":
          return { ...b, rows: b.rows.map((r) => ({ ...r, cells: r.cells.map(para) })) };
        default:
          return b;
      }
    });
  return map(blocks);
}

/** 参照先のラベルがない参照の名前（［＃ページ：］・［＃見出し：］・［＃参照：］など。重複なし、出てくる順）。 */
export function missingLabels(blocks: Block[], labels: Map<string, number>): string[] {
  const out = new Set<string>();
  for (const b of textBlocks(blocks)) {
    for (const a of b.atoms) {
      const name = a.pageRef ?? (a.link?.startsWith("l:") ? a.link.slice(2) : undefined);
      if (name !== undefined && !labels.has(name)) out.add(name);
    }
  }
  return [...out];
}
