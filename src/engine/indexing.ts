import { INDEX_ENTRY_STYLE, INDEX_HEADING_STYLE, TOC_TITLE_STYLE } from "../document/styles.js";
import { textBlocks } from "./blocks.js";
import { parseInline, type ParseOptions } from "./parse.js";
import type { Atom, Block } from "./types.js";

// 索引。本文の［＃索引］…［＃／索引］・［＃索引：語（よみ）］の語を集め、読みの五十音順に並べ、
// あ行・か行…の見出しを付けて、［＃索引ページ］（またはページ構成の「索引」）の場所に置く。
// ページ番号は、語のある場所に付けたラベルへの「ページ番号の参照」として入れる（組んでから番号が入る。閲覧用 PDF ではリンク）。
// 同じ語が同じページに何度出ても、番号は1つにまとめる（1度組んで、ページを調べてから作り直す）。

export interface IndexEntry {
  term: string;
  reading: string;
  /** 語のある場所のラベル（出てくる順）。 */
  ids: string[];
}

/** 語のある場所に付けるラベルの頭。 */
const ID_PREFIX = "kolophon-idx-";

export function hasIndexPage(blocks: Block[]): boolean {
  return blocks.some((b) => b.kind === "indexpage" || ((b.kind === "pagegroup" || b.kind === "section") && hasIndexPage(b.blocks)));
}

/**
 * 原稿の索引の語を集める。語のある場所にラベル（id）を付ける（組むたびに付け直す。記法の読み取り結果は使い回すため）。
 * 同じ表記と読みの語は1つの項目にまとめる。
 */
export function collectIndex(blocks: Block[]): IndexEntry[] {
  const entries = new Map<string, IndexEntry>();
  let k = 0;
  for (const block of textBlocks(blocks)) {
    for (const atom of block.atoms) {
      for (const e of atom.index ?? []) {
        e.id = `${ID_PREFIX}${k++}`;
        const key = `${e.term}\u0000${e.reading}`;
        let entry = entries.get(key);
        if (!entry) entries.set(key, (entry = { term: e.term, reading: e.reading, ids: [] }));
        entry.ids.push(e.id);
      }
    }
  }
  return [...entries.values()];
}

/** カタカナをひらがなに、全角英数字を半角にする。 */
function normalizeReading(s: string): string {
  return s
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

const SMALL: Record<string, string> = { ぁ: "あ", ぃ: "い", ぅ: "う", ぇ: "え", ぉ: "お", っ: "つ", ゃ: "や", ゅ: "ゆ", ょ: "よ", ゎ: "わ", ゕ: "か", ゖ: "け" };

/** 並べるときの読み：濁点・半濁点を外し、小さい字を大きくする（そのあとで、元の読みで細かく並べる）。 */
function primaryKey(reading: string): string {
  return [...normalizeReading(reading).normalize("NFD").replace(/[゙゚]/g, "")].map((c) => SMALL[c] ?? c).join("").toLowerCase();
}

/** 五十音の行（頭の字で決める）。かなでなければ、英数字かその他。 */
const ROWS: [string, string][] = [
  ["あ", "あいうえお"],
  ["か", "かきくけこ"],
  ["さ", "さしすせそ"],
  ["た", "たちつてと"],
  ["な", "なにぬねの"],
  ["は", "はひふへほ"],
  ["ま", "まみむめも"],
  ["や", "やゆよ"],
  ["ら", "らりるれろ"],
  ["わ", "わゐゑをん"],
];
const LATIN_GROUP = "英数字";
const OTHER_GROUP = "その他";

export function indexGroup(reading: string): string {
  const head = primaryKey(reading)[0] ?? "";
  if (head === "ゔ") return "あ";
  for (const [name, chars] of ROWS) if (chars.includes(head)) return name;
  if (/[a-z0-9]/.test(head)) return LATIN_GROUP;
  return OTHER_GROUP;
}

const GROUP_ORDER = [...ROWS.map(([n]) => n), LATIN_GROUP, OTHER_GROUP];

/** 項目を、行ごと・読みの順に並べる。 */
export function sortIndex(entries: IndexEntry[]): { group: string; entries: IndexEntry[] }[] {
  const sorted = [...entries].sort(
    (a, b) =>
      GROUP_ORDER.indexOf(indexGroup(a.reading)) - GROUP_ORDER.indexOf(indexGroup(b.reading)) ||
      primaryKey(a.reading).localeCompare(primaryKey(b.reading), "ja") ||
      normalizeReading(a.reading).localeCompare(normalizeReading(b.reading), "ja") ||
      a.term.localeCompare(b.term, "ja"),
  );
  const out: { group: string; entries: IndexEntry[] }[] = [];
  for (const e of sorted) {
    const g = indexGroup(e.reading);
    if (out[out.length - 1]?.group !== g) out.push({ group: g, entries: [] });
    out[out.length - 1].entries.push(e);
  }
  return out;
}

/** 番号を出す場所：同じページに出た2つ目からの場所は外す（ページがまだ分からないときは、全部残す）。 */
function keptIds(e: IndexEntry, pageOf?: (id: string) => number | undefined): string[] {
  const seen = new Set<number>();
  return e.ids.filter((id) => {
    const p = pageOf?.(id);
    if (p === undefined) return true;
    if (seen.has(p)) return false;
    seen.add(p);
    return true;
  });
}

/**
 * 索引に出す番号の場所の一覧を、1つの文字列にしたもの。前に作った索引と同じなら、作り直して組み直す必要はない。
 */
export function indexSignature(entries: IndexEntry[], pageOf?: (id: string) => number | undefined): string {
  return entries.map((e) => keptIds(e, pageOf).join(",")).join(";");
}

/**
 * 索引のページの段落：題「索引」、行の見出し（あ・か…）、項目（語・リーダー・ページ番号）。
 * pageOf を渡すと、同じページの番号は最初の1つだけにする（組んだあとで作り直すとき）。
 */
export function indexBlocks(entries: IndexEntry[], opts: ParseOptions, pageOf?: (id: string) => number | undefined): Block[] {
  const out: Block[] = [{ kind: "para", style: TOC_TITLE_STYLE, atoms: [..."索引"].map((ch) => ({ cells: [{ text: ch }] })) }];
  for (const { group, entries: list } of sortIndex(entries)) {
    out.push({ kind: "para", style: INDEX_HEADING_STYLE, atoms: parseInline(group, opts) });
    for (const e of list) {
      const ids = keptIds(e, pageOf);
      // 番号は、語のある場所のラベルへのページ参照。組むまでは仮に「000」（縦中横の3桁）にしておく。
      const numbers: Atom[] = ids.flatMap((id, i) => [...(i > 0 ? [{ cells: [{ text: "、" }] }] : []), { cells: [{ text: "000", tcy: true }], pageRef: id }]);
      out.push({
        kind: "para",
        style: INDEX_ENTRY_STYLE,
        atoms: [...parseInline(e.term, opts), { cells: [{ text: "…" }], leader: true }, ...numbers],
      });
    }
  }
  return out;
}

/** ［＃索引ページ］の場所を、索引の段落のまとまり（新しいページから始まる）にする。 */
export function expandIndex(blocks: Block[], content: Block[]): Block[] {
  return blocks.map((b): Block => {
    if (b.kind === "indexpage") return { kind: "section", role: "index", blocks: content };
    if (b.kind === "pagegroup" || b.kind === "section") return { ...b, blocks: expandIndex(b.blocks, content) };
    return b;
  });
}

/** 組んだあとで、索引のまとまりの中身を入れ替える。 */
export function replaceIndexContent(blocks: Block[], content: Block[]): void {
  for (const b of blocks) {
    if (b.kind === "section" && b.role === "index") b.blocks = content;
    else if (b.kind === "pagegroup" || b.kind === "section") replaceIndexContent(b.blocks, content);
  }
}
