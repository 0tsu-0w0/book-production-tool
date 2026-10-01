import { toFormatOptions, toLayoutSpec, toPageDecor, toParseOptions, type FontChoice, type Settings } from "../document/settings.js";
import { fontKey, type StyleSheet } from "../document/styles.js";
import { bookPageBlocks } from "./book-pages.js";
import { decoratePage } from "./decorate.js";
import { Face } from "./face.js";
import { formatText } from "./format.js";
import { layoutDocument } from "./layout.js";
import { parse } from "./parse.js";
import { applyProportional, measureMath, measureRotated, resolvePage } from "./resolve.js";
import { prepareSpacing } from "./spacing.js";
import { applyStyles, type EngineStyles } from "./styles.js";
import { hasToc, layoutWithToc } from "./toc.js";
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
}

/** スタイルの書体を、フォントの一覧の番号にする。 */
function engineStyles(sheet: StyleSheet, fonts: FontTable): EngineStyles {
  const indexOf = (f: FontChoice | null, inherit: number) => {
    if (!f) return inherit;
    const i = fonts.keys.indexOf(fontKey(f));
    return i >= 0 ? i : 0;
  };
  return {
    paragraph: new Map(sheet.paragraph.map((p) => [p.name, { ...p, font: indexOf(p.font, 0) }])),
    character: new Map(sheet.character.map((c) => [c.name, { ...c, font: indexOf(c.font, -1) }])),
    body: "本文",
    heading1: "大見出し",
    heading2: "中見出し",
  };
}

/**
 * 行とページの割り付けまでを行い、字形の割り当ては頼まれたページだけ行う。
 * 画面では見えているページしか要らないので、編集のたびの組み直しが速くなる。
 */
export function typesetLazy(text: string, settings: Settings, fontsOrFace: FontTable | Face, images: Record<string, ImageInfo> = {}): LazyTypesetResult {
  const fonts = fontsOrFace instanceof Face ? singleFont(fontsOrFace) : fontsOrFace;
  const { faces } = fonts;
  const spec = { ...toLayoutSpec(settings), images };
  // TeX の記法なら、先に tategumi の記法に置き換える（行の対応も覚えておく）。
  const tex = settings.format.markup === "tex" ? texToMarkup(text) : null;
  const format = formatText(tex ? tex.text : text, toFormatOptions(settings));
  const formatted = format.text;
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
  const source = [...book.front, ...body, ...book.back];
  // 原稿の段落にだけ行の番号がある（扉・奥付などの段落は原稿にない）。
  const sourceLines = [...book.front.map(() => -1), ...lineOf, ...book.back.map(() => -1)].map((n) => (n < 0 ? undefined : n)) as number[];
  const styles = engineStyles(settings.styles, fonts);
  // 数式があるときだけ MathJax を使う（読み込みに時間がかかるため）。
  const hasMath = textBlocks(source).some((b) => b.atoms.some((a) => a.cells.some((c) => c.math)));
  const mathErrors: string[] = [];
  const prepare = (bs: Block[]) => {
    applyStyles(bs, styles);
    measureRotated(bs, faces);
    if (hasMath) mathErrors.push(...measureMath(bs, spec.charsPerLine, spec.lineGap, spec.mathSpaceEm));
    prepareSpacing(bs, spec.typography, spec.rubyScale);
    applyProportional(bs, faces);
  };
  let blocks = source;
  let layouts: PageLayout[];
  if (hasToc(source)) {
    // 目次があれば、見出しのページ番号が決まるまで組み直す（DTP-14）。
    ({ blocks, pages: layouts } = layoutWithToc(source, settings.toc, spec.firstPageNumber, prepare, (bs) => layoutDocument(bs, spec, sourceLines)));
  } else {
    prepare(blocks);
    layouts = layoutDocument(blocks, spec, sourceLines);
  }
  const decor = toPageDecor(settings);
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
  const resolved = new Map<number, DrawPage>();
  return {
    pageCount: layouts.length,
    page(index) {
      let page = resolved.get(index);
      if (!page) resolved.set(index, (page = resolvePage(layouts[index], faces, settings.textColor)));
      return page;
    },
    lines: (index) => layouts[index]?.lines ?? [],
    upems: faces.map((f) => f.upem),
    upem: faces[0].upem,
    missingChars: missingChars(blocks, faces),
    mathErrors: [...new Set(mathErrors)],
    // 本文の最後のページ（奥付などのページは除く）。
    lastPageLines: (layouts.findLast((p) => p.role === "body") ?? layouts[layouts.length - 1]).lineCount,
    linesPerPage: spec.linesPerPage,
    charsPerLine: spec.charsPerLine,
    columns: spec.columns,
  };
}

/**
 * フォントで描けない文字を探す。字形がない文字（.notdef になる）と、
 * 字形はあるが輪郭が空の文字（フォントによっては未収録の漢字をこうしている）。空白は除く。
 * 文字ごとに、その字に当たっている書体で調べる。
 */
function missingChars(blocks: Block[], faces: Face[]): string[] {
  const seen = new Set<string>();
  const missing: string[] = [];
  const check = (text: string, direction: "ttb" | "ltr", face: Face) => {
    for (const ch of text) {
      if (/\s/u.test(ch)) continue;
      const key = `${faces.indexOf(face)}:${ch}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const gid = face.shape(ch, direction)[0]?.gid ?? 0;
      if ((gid === 0 || face.path(gid) === "") && !missing.includes(ch)) missing.push(ch);
    }
  };
  for (const block of textBlocks(blocks)) {
    for (const atom of block.atoms) {
      for (const cell of atom.cells) if (!cell.math) check(cell.text, cell.rotate || cell.tcy ? "ltr" : "ttb", faces[cell.font ?? 0] ?? faces[0]);
      if (atom.warichu) check(atom.warichu, "ttb", faces[atom.cells[0].font ?? 0] ?? faces[0]);
      if (atom.kenten) check(atom.kenten, "ttb", faces[atom.cells[0].font ?? 0] ?? faces[0]);
      if (atom.ruby) check(atom.ruby, "ttb", faces[atom.cells[0].font ?? 0] ?? faces[0]);
    }
  }
  return missing;
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
