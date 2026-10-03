import { placeNotes } from "./notes.js";
import { horizontalPunctuation, leftBound, toFormatOptions, toLayoutSpec, toPageDecor, toParseOptions, type FontChoice, type Settings } from "../document/settings.js";
import { fontKey, type StyleSheet } from "../document/styles.js";
import { bookPageBlocks } from "./book-pages.js";
import { BODY_START_LABEL, decoratePage, displayNumber, pageLabel } from "./decorate.js";
import { Face } from "./face.js";
import { formatText } from "./format.js";
import { layoutDocument } from "./layout.js";
import { parse } from "./parse.js";
import { applyProportional, measureMath, measureRotated, resolvePage } from "./resolve.js";
import { applyDeform, prepareSpacing } from "./spacing.js";
import { collectIndex, expandIndex, hasIndexPage, indexBlocks, replaceIndexContent } from "./indexing.js";
import { applyStyles, type EngineStyles } from "./styles.js";
import { hasPageRefs, hasToc, layoutWithToc, resolvePageRefs } from "./toc.js";
import { texToMarkup } from "./tex.js";
import type { Block, DrawPage, ImageInfo, LineText, PageLayout } from "./types.js";
import { textBlocks } from "./blocks.js";

export { Face } from "./face.js";
export type * from "./types.js";

/**
 * 組版に使うフォントの一覧。faces[0] は本文の書体。keys は各フォントを見分ける文字列（パス#番号）。
 * スタイルで指定した書体は、keys で探して番号にする（見つからなければ本文の書体）。
 */
export interface FontTable {
  faces: Face[];
  keys: string[];
}

export function singleFont(face: Face, key = "body"): FontTable {
  return { faces: [face], keys: [key] };
}

export interface TypesetResult {
  pages: DrawPage[];
  /** フォントごとの 1em の大きさ（faces と同じ並び）。 */
  upems: number[];
  /** 本文の書体の 1em（1つのフォントだけ使う呼び出し側のため）。 */
  upem: number;
  /** フォントに字形がない（または字形が空の）文字。重複なし、原稿に出てくる順（OUT-09）。 */
  missingChars: string[];
  /** 組めなかった数式の知らせ（重複なし）。 */
  mathErrors: string[];
  /** 最終ページに入っている行数（IN-01 の表示用）。 */
  lastPageLines: number;
  linesPerPage: number;
  charsPerLine: number;
  columns: number;
  /** ページごとの名前（画像のファイル名・書き出す範囲に使う。前付けを別の番号にするときは i・ii…、本文は 001…）。 */
  pageLabels: string[];
}

/** 原稿から、描画できる状態のページまでを一度に作る。 */
export function typeset(text: string, settings: Settings, fonts: FontTable | Face, images?: Record<string, ImageInfo>): TypesetResult {
  const lazy = typesetLazy(text, settings, fonts, images);
  const { page: _page, lines: _lines, ...rest } = lazy;
  return { ...rest, pages: Array.from({ length: lazy.pageCount }, (_, i) => lazy.page(i)) };
}

export interface LazyTypesetResult extends Omit<TypesetResult, "pages"> {
  pageCount: number;
  /** i 番目のページ。字形の割り当ては、初めて頼まれたときに行う。 */
  page(index: number): DrawPage;
  /** i 番目のページの行の文字（校正の補助に使う）。 */
  lines(index: number): LineText[];
  /** ラベル（［＃ラベル：名前］）のあるページ（0始まり）。 */
  labelPages(): Map<string, number>;
  /** 原稿の位置（行・行の中の位置）の字があるページ（その位置より前で最後の字のページ）。字がなければ -1。 */
  pageOf(line: number, offset: number): number;
}

/** スタイルの書体を、フォントの一覧の番号にする。 */
export function engineStyles(sheet: StyleSheet, fonts: FontTable, composite?: { kana: FontChoice | null; latin: FontChoice | null }): EngineStyles {
  const indexOf = (f: FontChoice | null, inherit: number) => {
    if (!f) return inherit;
    const i = fonts.keys.indexOf(fontKey(f));
    return i >= 0 ? i : 0;
  };
  return {
    paragraph: new Map(sheet.paragraph.map((p) => [p.name, { ...p, font: indexOf(p.font, 0) }])),
    character: new Map(sheet.character.map((c) => [c.name, { ...c, font: indexOf(c.font, -1) }])),
    ...(composite ? { kanaFont: indexOf(composite.kana, -1), latinFont: indexOf(composite.latin, -1) } : {}),
    body: "本文",
    heading1: "大見出し",
    heading2: "中見出し",
  };
}

/**
 * 行とページの割り付けまでを行い、字形の割り当ては頼まれたページだけ行う。
 * 画面では見えているページしか要らないので、編集のたびの組み直しが速くなる。
 *
 * 流れ：
 * 1. 原稿を整形して読む（parse）。箇条書きの印・索引の語・リンクの元はここで付く。
 * 2. 注を章末・巻末に集める（placeNotes）。索引の語を集め、［＃索引ページ］に仮の索引を置く。
 * 3. 組む前の準備（prepare）：スタイル → 横倒しの長さ → 約物の詰め・ルビ → プロポーショナル → 長体・平体。
 * 4. 行とページに割り付ける（layoutDocument）。目次があれば番号が決まるまで組み直す。
 * 5. ページ番号の参照（索引の番号も）を入れて組み直す。索引は同じページの番号をまとめて作り直す。
 * 6. 柱・ノンブルを付ける（decoratePage）。字形の割り当て（resolvePage）は page() で頼まれたときに行う。
 */
export function typesetLazy(text: string, settings: Settings, fontsOrFace: FontTable | Face, images: Record<string, ImageInfo> = {}): LazyTypesetResult {
  const fonts = fontsOrFace instanceof Face ? singleFont(fontsOrFace) : fontsOrFace;
  const { faces } = fonts;
  const spec = { ...toLayoutSpec(settings), images };
  // TeX の記法なら、先に Kolophon の記法に置き換える（行の対応も覚えておく）。
  const tex = settings.format.markup === "tex" ? texToMarkup(text) : null;
  const format = formatText(tex ? tex.text : text, toFormatOptions(settings));
  const formatted = horizontalPunctuation(format.text, settings);
  // 整形後の行の番号 → 元の原稿の行の番号（整形で消えた行を飛ばす）。
  const origin: number[] = [];
  format.lines.forEach((l, i) => {
    const source = tex ? (tex.origin[i] ?? i) : i;
    if (l.after !== null) for (let k = 0; k <= (l.after.match(/\n/g)?.length ?? 0); k++) origin.push(source);
  });
  const lineOf: number[] = [];
  const parseOpts = toParseOptions(settings);
  const book = bookPageBlocks(settings.pages, settings.bookInfo, parseOpts);
  const body = parse(formatted, parseOpts, lineOf, (i) => origin[i] ?? i);
  // 原稿の段落にだけ行の番号がある（扉・奥付などの段落は原稿にない）。
  // 注を章末か巻末に集める。
  const noted = placeNotes(body, lineOf, settings.notes.placement);
  // 前付けのあとに、本文の始まりの印（前付けと本文でノンブルを分けるため）。
  const bodyMark: Block[] = book.front.length > 0 ? [{ kind: "anchor", name: BODY_START_LABEL }] : [];
  let source = [...book.front, ...bodyMark, ...noted.blocks, ...book.back];
  // 索引：語を集め（語のある場所にラベルを付け）、［＃索引ページ］の場所に、仮の番号で索引を入れる。
  const indexEntries = collectIndex(source);
  const withIndex = indexEntries.length > 0 && hasIndexPage(source);
  if (hasIndexPage(source)) source = expandIndex(source, withIndex ? indexBlocks(indexEntries, parseOpts) : []);
  const sourceLines = [...book.front.map(() => -1), ...bodyMark.map(() => -1), ...noted.lines.map((n) => n ?? -1), ...book.back.map(() => -1)].map((n) => (n < 0 ? undefined : n)) as number[];
  // 目次・ページ番号の参照に入れる番号（前付けを別の番号にするときは、本文の始まりから数える）。
  const decor = toPageDecor(settings);
  const bodyStartOf = (pages: PageLayout[]) => pages.find((p) => p.labels?.includes(BODY_START_LABEL))?.index ?? 0;
  const numberOf = (pages: PageLayout[], index: number) => displayNumber(index, { ...decor, bodyStart: bodyStartOf(pages) });
  const styles = engineStyles(settings.styles, fonts, settings.compositeFont);
  // 数式があるときだけ MathJax を使う（読み込みに時間がかかるため）。
  const hasMath = textBlocks(source).some((b) => b.atoms.some((a) => a.cells.some((c) => c.math)));
  const mathErrors: string[] = [];
  // 組む前の準備。組み直すたびに同じ順で行う（長体・平体は、詰めとプロポーショナルで決まった長さを縮めるので最後）。
  const prepare = (bs: Block[]) => {
    applyStyles(bs, styles);
    measureRotated(bs, faces, leftBound(settings) && settings.book.hyphenation);
    if (hasMath) mathErrors.push(...measureMath(bs, spec.charsPerLine, spec.lineGap, spec.mathSpaceEm));
    prepareSpacing(bs, spec.typography, spec.rubyScale);
    applyProportional(bs, faces);
    applyDeform(bs, !!spec.horizontal);
  };
  let blocks = source;
  let layouts: PageLayout[];
  if (hasToc(source)) {
    // 目次があれば、見出しのページ番号が決まるまで組み直す（DTP-14）。
    ({ blocks, pages: layouts } = layoutWithToc(source, settings.toc, spec.firstPageNumber, prepare, (bs) => layoutDocument(bs, spec, sourceLines), !!spec.horizontal, numberOf));
  } else {
    prepare(blocks);
    layouts = layoutDocument(blocks, spec, sourceLines);
  }
  // ページ番号の参照（［＃ページ：名前］・索引の番号）：番号を入れて組み直し、番号が変わらなくなるまで繰り返す。
  const resolveRefs = () => {
    if (!hasPageRefs(blocks)) return;
    for (let pass = 0; pass < 3; pass++) {
      if (!resolvePageRefs(blocks, layouts, spec.firstPageNumber, settings.toc.numerals, !!spec.horizontal, numberOf)) break;
      prepare(blocks);
      layouts = layoutDocument(blocks, spec, sourceLines);
    }
  };
  resolveRefs();
  if (withIndex) {
    // 索引：語のページが分かったので、同じページに何度出た語の番号を1つにまとめて作り直す。
    const where = new Map<string, number>();
    for (const p of layouts) for (const l of p.labels ?? []) if (!where.has(l)) where.set(l, p.index);
    const content = indexBlocks(indexEntries, parseOpts, (id) => where.get(id));
    replaceIndexContent(blocks, content);
    prepare(content);
    layouts = layoutDocument(blocks, spec, sourceLines);
    resolveRefs();
  }
  // 前付けを別の番号にするときの、本文の始まりのページ（ノンブルとページの名前に使う）。
  decor.bodyStart = bodyStartOf(layouts);
  // 柱に出す章題・節題は、そのページまでに出てきた最後の見出し。
  const running = { chapter: "", section: "" };
  for (const page of layouts) {
    for (const h of page.headings) {
      if (h.level === 1) {
        running.chapter = h.text;
        running.section = "";
      } else {
        running.section = h.text;
      }
    }
    decoratePage(page, decor, spec.fontSizePt, { ...running });
  }
  // 字形を割り当てたページの控え（同じページを何度頼まれても、割り当ては1度だけ）。
  const resolved = new Map<number, DrawPage>();
  return {
    pageCount: layouts.length,
    page(index) {
      let page = resolved.get(index);
      if (!page) resolved.set(index, (page = resolvePage(layouts[index], faces, settings.textColor)));
      return page;
    },
    lines: (index) => layouts[index]?.lines ?? [],
    labelPages() {
      const map = new Map<string, number>();
      for (const p of layouts) for (const l of p.labels ?? []) if (!map.has(l)) map.set(l, p.index);
      return map;
    },
    pageOf(line, offset) {
      let best = -1;
      for (let i = 0; i < layouts.length; i++) {
        for (const g of layouts[i].glyphs) {
          const s = g.src;
          if (s && (s[0] < line || (s[0] === line && s[1] <= offset))) best = i;
        }
      }
      return best;
    },
    upems: faces.map((f) => f.upem),
    upem: faces[0].upem,
    missingChars: missingChars(blocks, faces),
    mathErrors: [...new Set(mathErrors)],
    // 本文の最後のページ（奥付などのページは除く）。
    lastPageLines: (layouts.findLast((p) => p.role === "body") ?? layouts[layouts.length - 1]).lineCount,
    linesPerPage: spec.linesPerPage,
    charsPerLine: spec.charsPerLine,
    columns: spec.columns,
    pageLabels: layouts.map((p) => pageLabel(p.index, decor)),
  };
}

/**
 * フォントで描けない文字を探す。字形がない文字（.notdef になる）と、
 * 字形はあるが輪郭が空の文字（フォントによっては未収録の漢字をこうしている）。空白は除く。
 * 文字ごとに、その字に当たっている書体で調べる。
 */
function missingChars(blocks: Block[], faces: Face[]): string[] {
  const missing = new Set<string>();
  const check = (text: string, direction: "ttb" | "ltr", face: Face) => {
    // ほとんどのマスは1字。調べた結果はフォントが覚えている（Face.isMissing）。
    if (text.length === 1) {
      if (face.isMissing(text, direction)) missing.add(text);
      return;
    }
    for (const ch of text) if (face.isMissing(ch, direction)) missing.add(ch);
  };
  for (const block of textBlocks(blocks)) {
    for (const atom of block.atoms) {
      for (const cell of atom.cells) {
        if (cell.math) continue;
        // 欧文の書体で組む全角の英数字は、半角の字があるかを調べる。
        const text = cell.halfLatin ? cell.text.replace(/[０-９Ａ-Ｚａ-ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)) : cell.text;
        check(text, cell.rotate || cell.tcy || cell.halfLatin ? "ltr" : "ttb", faces[cell.font ?? 0] ?? faces[0]);
      }
      if (atom.warichu) check(atom.warichu, "ttb", faces[atom.cells[0].font ?? 0] ?? faces[0]);
      if (atom.kenten) check(atom.kenten, "ttb", faces[atom.cells[0].font ?? 0] ?? faces[0]);
      if (atom.ruby) check(atom.ruby, "ttb", faces[atom.cells[0].font ?? 0] ?? faces[0]);
    }
  }
  return [...missing];
}

/**
 * ページで使っている字形の輪郭（フォントのキー → 字形番号 → SVG パス）。画面で描くのに使う。
 * sent にある字形は除き、返した字形を sent に加える（同じ輪郭を何度も送らないため）。
 */
export function glyphPaths(pages: DrawPage[], fonts: FontTable, sent: Map<string, Set<number>>): Record<string, Record<number, string>> {
  const out: Record<string, Record<number, string>> = {};
  for (const page of pages) {
    for (const item of page.items) {
      const key = fonts.keys[item.face];
      let skip = sent.get(key);
      if (!skip) sent.set(key, (skip = new Set()));
      for (const g of item.glyphs) {
        if (skip.has(g.gid)) continue;
        skip.add(g.gid);
        (out[key] ??= {})[g.gid] = fonts.faces[item.face].path(g.gid);
      }
    }
  }
  return out;
}
