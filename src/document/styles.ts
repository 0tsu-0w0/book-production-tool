import type { FontChoice } from "./settings.js";

// 段落スタイル・文字スタイル（DTP-04）。
// 段落スタイル：行頭に［＃スタイル名］と書いた行、または見出し記法（＃・＃＃）と本文に当てる。
// 文字スタイル：［＃スタイル名］…［＃／スタイル名］で囲んだ文字に当てる。

export const BODY_STYLE = "本文";
export const HEADING1_STYLE = "大見出し";
export const HEADING2_STYLE = "中見出し";
export const TITLE_STYLE = "書名";
export const AUTHOR_STYLE = "著者名";
export const COLOPHON_STYLE = "奥付";
export const TOC_TITLE_STYLE = "目次の題";
export const DISPLAY_MATH_STYLE = "別行数式";
export const CAPTION_STYLE = "キャプション";
export const NOTE_STYLE = "注";
export const TABLE_STYLE = "表";
export const TABLE_HEADER_STYLE = "表の見出し";
export const TOC_ENTRY_STYLES = ["目次の項目1", "目次の項目2"] as const;
export const INDEX_HEADING_STYLE = "索引の見出し";
export const INDEX_ENTRY_STYLE = "索引の項目";
/** 消せない段落スタイル（書名・著者名・奥付は、扉と奥付のページで使う）。 */
export const BUILTIN_PARAGRAPH_STYLES = [
  BODY_STYLE,
  HEADING1_STYLE,
  HEADING2_STYLE,
  TITLE_STYLE,
  AUTHOR_STYLE,
  COLOPHON_STYLE,
  TOC_TITLE_STYLE,
  ...TOC_ENTRY_STYLES,
  DISPLAY_MATH_STYLE,
  CAPTION_STYLE,
  NOTE_STYLE,
  TABLE_STYLE,
  TABLE_HEADER_STYLE,
  INDEX_HEADING_STYLE,
  INDEX_ENTRY_STYLE,
];

export interface ParagraphStyle {
  name: string;
  /** null なら本文の書体。 */
  font: FontChoice | null;
  /** 本文の文字サイズに対する倍率。 */
  scale: number;
  /** 行取り：1行を何行分の幅に取るか（その中央に置く）。 */
  lineSpan: number;
  /** 行送り：標準の行送りに対する倍率（1 なら標準。0.5〜3）。 */
  linePitch: number;
  /** 行の中での揃え：天（字下げのあと）・中央・地。 */
  align: "start" | "center" | "end";
  /** 字下げ（字数）。 */
  indent: number;
  /** 前後の空き（行数）。 */
  spaceBefore: number;
  spaceAfter: number;
  /** 孤立行を避ける（段落の1行目だけ・最後の1行だけがページをまたいで離れないようにする。DTP-11）。 */
  keepLines: boolean;
  /** 次の行と離さない（見出しをページの最後に取り残さない）。 */
  keepWithNext: boolean;
  /** null なら文字の色。 */
  color: string | null;
  /** 擬似ボールド（輪郭を太らせる）。 */
  bold: boolean;
  /** 字形（OpenType の機能。空なら標準。DTP-10）。 */
  glyphForm: GlyphForm;
  /** プロポーショナル（かなと約物を字の幅どおりに詰める）。 */
  proportional: boolean;
  /** 長体（字を横に縮めて縦長に）・平体（縦に縮めて横長に）。空ならそのまま。 */
  deform: Deform;
  /** 長体・平体の割合（%）。 */
  deformRatio: number;
}

/** 長体・平体。文字スタイルの空は「段落と同じ」。 */
export type Deform = "" | "condensed" | "flat";
export const DEFORMS: [Deform, string][] = [
  ["", "なし"],
  ["condensed", "長体（縦長）"],
  ["flat", "平体（横長）"],
];
export const DEFORM_RATIOS = [90, 80, 70, 60, 50];

export interface CharacterStyle {
  name: string;
  font: FontChoice | null;
  scale: number;
  color: string | null;
  bold: boolean;
  /** 空なら段落の字形のまま。 */
  glyphForm: GlyphForm;
  proportional: boolean;
  /** 空なら段落の長体・平体のまま。 */
  deform: Deform;
  deformRatio: number;
}

/** 字形の切り替え（OpenType の機能の名前）。フォントにその機能がなければ変わらない。 */
export type GlyphForm = "" | "jp78" | "jp83" | "jp90" | "jp04" | "nlck" | "trad" | "expt" | "hojo";
export const GLYPH_FORMS: [GlyphForm, string][] = [
  ["", "標準"],
  ["jp78", "JIS78 字形"],
  ["jp83", "JIS83 字形"],
  ["jp90", "JIS90 字形"],
  ["jp04", "JIS2004 字形"],
  ["nlck", "印刷標準字体"],
  ["trad", "旧字体"],
  ["expt", "エキスパート字形"],
  ["hojo", "補助漢字字形"],
];

export interface StyleSheet {
  paragraph: ParagraphStyle[];
  character: CharacterStyle[];
}

const paragraph = (name: string, over: Partial<ParagraphStyle> = {}): ParagraphStyle => ({
  name,
  font: null,
  scale: 1,
  lineSpan: 1,
  linePitch: 1,
  align: "start",
  indent: 0,
  spaceBefore: 0,
  spaceAfter: 0,
  keepLines: false,
  keepWithNext: false,
  color: null,
  bold: false,
  glyphForm: "",
  proportional: false,
  deform: "",
  deformRatio: 80,
  ...over,
});

const character = (name: string, over: Partial<CharacterStyle> = {}): CharacterStyle => ({
  name,
  font: null,
  scale: 1,
  color: null,
  bold: false,
  glyphForm: "",
  proportional: false,
  deform: "",
  deformRatio: 80,
  ...over,
});

const deform = (v: unknown): Deform => (v === "condensed" || v === "flat" ? v : "");
const glyphForm = (v: unknown): GlyphForm => (GLYPH_FORMS.some(([k]) => k === v) ? (v as GlyphForm) : "");

/** 既定のスタイル。見出しの字下げ（3字・4字）はこれまでの組み方と同じ。 */
export const DEFAULT_STYLES: StyleSheet = {
  paragraph: [
    paragraph(BODY_STYLE),
    paragraph(HEADING1_STYLE, { indent: 3, keepWithNext: true }),
    paragraph(HEADING2_STYLE, { indent: 4, keepWithNext: true }),
    // 扉：書名は大きく中央に、著者名は地付き。
    paragraph(TITLE_STYLE, { scale: 2, lineSpan: 3, align: "center" }),
    paragraph(AUTHOR_STYLE, { scale: 1.2, lineSpan: 2, align: "end", indent: 0 }),
    paragraph(COLOPHON_STYLE, { scale: 0.9 }),
    // 目次：題は3字下げで後ろに1行空ける。中見出しは大見出しより2字下げる。
    paragraph(TOC_TITLE_STYLE, { indent: 3, scale: 1.2, spaceAfter: 1 }),
    paragraph(TOC_ENTRY_STYLES[0], { indent: 1 }),
    paragraph(TOC_ENTRY_STYLES[1], { indent: 3 }),
    // 別行数式：行の中央に置き、前後を1行ずつ空ける。
    paragraph(DISPLAY_MATH_STYLE, { align: "center", spaceBefore: 1, spaceAfter: 1 }),
    // 画像のキャプション：本文より小さく。
    paragraph(CAPTION_STYLE, { scale: 0.8 }),
    // 注（章末・巻末）：本文より少し小さく。
    paragraph(NOTE_STYLE, { scale: 0.85, indent: 1 }),
    // 表：欄の中の文字。見出しの行は太字。
    paragraph(TABLE_STYLE, { scale: 0.9 }),
    paragraph(TABLE_HEADER_STYLE, { scale: 0.9, bold: true }),
    // 索引：行の見出し（あ・か…）は太字で前を1行空け、項目は少し小さく1字下げる。
    paragraph(INDEX_HEADING_STYLE, { bold: true, spaceBefore: 1, keepWithNext: true }),
    paragraph(INDEX_ENTRY_STYLE, { scale: 0.9, indent: 1 }),
  ],
  character: [character("太字", { bold: true }), character("小さく", { scale: 0.8 })],
};

export function newParagraphStyle(name: string): ParagraphStyle {
  return paragraph(name);
}

export function newCharacterStyle(name: string): CharacterStyle {
  return character(name);
}

const num = (v: unknown, def: number, min: number, max: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def;
const str = (v: unknown, def: string) => (typeof v === "string" ? v : def);
const color = (v: unknown) => (typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v : null);
const font = (v: unknown): FontChoice | null => {
  const f = v as FontChoice;
  return f && typeof f.path === "string" && typeof f.postscriptName === "string" && typeof f.index === "number" ? f : null;
};

/** 読み込んだスタイルを、今の形式にそろえる。本文・大見出し・中見出しは必ずある。 */
export function normalizeStyles(input: unknown): StyleSheet {
  const src = (input && typeof input === "object" ? input : {}) as { paragraph?: unknown; character?: unknown };
  const paragraphs = (Array.isArray(src.paragraph) ? src.paragraph : [])
    .filter((p): p is Record<string, unknown> => !!p && typeof p === "object" && typeof (p as { name?: unknown }).name === "string")
    .map((p) =>
      paragraph(p.name as string, {
        font: font(p.font),
        scale: num(p.scale, 1, 0.3, 5),
        lineSpan: Math.round(num(p.lineSpan, 1, 1, 10)),
        linePitch: Math.round(num(p.linePitch, 1, 0.5, 3) * 100) / 100,
        align: p.align === "center" || p.align === "end" ? p.align : "start",
        indent: num(p.indent, 0, 0, 40),
        spaceBefore: Math.round(num(p.spaceBefore, 0, 0, 10)),
        spaceAfter: Math.round(num(p.spaceAfter, 0, 0, 10)),
        keepLines: p.keepLines === true,
        keepWithNext: p.keepWithNext === true,
        color: color(p.color),
        bold: p.bold === true,
        glyphForm: glyphForm(p.glyphForm),
        proportional: p.proportional === true,
        deform: deform(p.deform),
        deformRatio: Math.round(num(p.deformRatio, 80, 30, 99)),
      }),
    );
  for (const def of DEFAULT_STYLES.paragraph) {
    if (!paragraphs.some((p) => p.name === def.name)) paragraphs.push(structuredClone(def));
  }
  const characters = (Array.isArray(src.character) ? src.character : [])
    .filter((c): c is Record<string, unknown> => !!c && typeof c === "object" && typeof (c as { name?: unknown }).name === "string")
    .map((c) =>
      character(str(c.name, ""), {
        font: font(c.font),
        scale: num(c.scale, 1, 0.3, 3),
        color: color(c.color),
        bold: c.bold === true,
        glyphForm: glyphForm(c.glyphForm),
        proportional: c.proportional === true,
        deform: deform(c.deform),
        deformRatio: Math.round(num(c.deformRatio, 80, 30, 99)),
      }),
    );
  return { paragraph: paragraphs, character: Array.isArray(src.character) ? characters : structuredClone(DEFAULT_STYLES.character) };
}

/** 文書で使うフォント：先頭が本文の書体、続いてスタイルで指定した書体（重複なし）。 */
export function requiredFonts(bodyFont: FontChoice | null, styles: StyleSheet, extra: (FontChoice | null)[] = []): (FontChoice | null)[] {
  const out: (FontChoice | null)[] = [bodyFont];
  const seen = new Set<string>();
  // スタイルの書体に続けて、合成フォントの書体（かな・欧文）。
  for (const font of [...styles.paragraph, ...styles.character].map((s) => s.font).concat(extra)) {
    if (!font) continue;
    const key = fontKey(font);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(font);
  }
  return out;
}

export function fontKey(f: Pick<FontChoice, "path" | "index">): string {
  return `${f.path}#${f.index}`;
}
