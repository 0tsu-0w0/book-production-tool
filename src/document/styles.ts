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
  /** 段抜き：段組みのとき、すべての段をまたいで置く（見出しなど）。前の本文は段の長さをそろえて割り直す。 */
  spanColumns?: boolean;
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
  /** 正規表現スタイル：この段落スタイルの段落で、正規表現に合う字に文字スタイルを当てる（あとの規則が優先）。 */
  grep: GrepRule[];
  /** 段落の罫線（前・後）・囲み罫・網掛け。 */
  decoration: ParagraphDecoration;
  /** ドロップキャップ（段落の頭の字を大きくして、何行かにまたがらせる）。 */
  dropCap: DropCap;
  /** 字間（トラッキング。全角1字の 1/1000。負なら詰める）。 */
  tracking: number;
  /** 先頭文字スタイル：段落の頭から順に、決めた範囲の字に文字スタイルを当てる（上の規則から順に）。 */
  nested: NestedStyle[];
  /** 行スタイル：段落の最初の何行かに文字スタイルを当てる（書体・色・太字・字形・大きさ・字間。0行なら使わない）。 */
  lineStyle: LineStyle;
  /** ルビの揃え（空なら文書の設定）。 */
  rubyAlign: RubyAlign;
  /** ルビの側（空なら文書の設定）。 */
  rubySide: RubySide;
}

/** ルビの揃え：空は「文書（または段落）の設定のまま」。 */
export type RubyAlign = "" | "121" | "center" | "shoulder";
/** ルビの側：空は「文書（または段落）の設定のまま」。 */
export type RubySide = "" | "right" | "left";
export const RUBY_ALIGNS: [RubyAlign, string][] = [
  ["", "文書の設定のまま"],
  ["121", "1-2-1"],
  ["center", "中付き"],
  ["shoulder", "肩付き"],
];
export const RUBY_SIDES: [RubySide, string][] = [
  ["", "文書の設定のまま"],
  ["right", "右（横組みでは上）"],
  ["left", "左（横組みでは下）"],
];

/** 先頭文字スタイルの規則1つ。 */
export interface NestedStyle {
  /** 当てる文字スタイル（空なら当てずに範囲だけ進める）。 */
  style: string;
  /** chars：count 字まで。through：区切りの字の count 個目まで（含む）。before：count 個目の前まで。 */
  until: "chars" | "through" | "before";
  count: number;
  /** 区切りの字（いくつか並べてよい。どれかが来たら区切り）。 */
  chars: string;
}

/** 行スタイル。 */
export interface LineStyle {
  style: string;
  lines: number;
}

/** ドロップキャップの設定。lines が 0 なら使わない。 */
export interface DropCap {
  /** またがる行数（2〜5。0 なら使わない）。 */
  lines: number;
  /** 大きくする字数（1〜5）。 */
  chars: number;
  /** 大きな字に当てる文字スタイルの名前（書体・色・太字。空なら段落の字のまま）。 */
  style: string;
}

/** 罫線の種類。 */
export type RuleKind = "solid" | "double" | "dotted" | "dashed";
export const RULE_KINDS: [RuleKind, string][] = [
  ["solid", "実線"],
  ["double", "二重線"],
  ["dotted", "点線"],
  ["dashed", "破線"],
];

/** 段落の罫線1本（前の罫・後の罫・囲み罫）。 */
export interface ParagraphRule {
  on: boolean;
  kind: RuleKind;
  /** 太さ（pt）。 */
  width: number;
  /** 色（#rrggbb）。null なら文字の色。 */
  color: string | null;
  /** 字との間（本文の1字の大きさに対する割合）。囲み罫では使わない（pad を使う）。 */
  gap: number;
}

/**
 * 段落の罫線・網掛け（InDesign の段落境界線・段落の囲み罫・段落の背景色にあたる）。
 * 縦組みでは、前の罫は段落の右（1行目の外側）、後の罫は左（最後の行の外側）。横組みでは上と下。
 * 字の場所は動かさない（罫や網が前後の段落に掛かるときは、段落スタイルの前後の空きで間を空ける）。
 */
export interface ParagraphDecoration {
  ruleBefore: ParagraphRule;
  ruleAfter: ParagraphRule;
  border: ParagraphRule;
  /** 網掛けの色（#rrggbb）。null なら網掛けなし。 */
  shading: string | null;
  /** 囲み罫・網掛けと字の間（字）。 */
  pad: number;
  /** 長さ：行の長さいっぱい（column）か、字のある所だけ（text）。 */
  length: "column" | "text";
}

const rule = (over: Partial<ParagraphRule> = {}): ParagraphRule => ({ on: false, kind: "solid", width: 0.5, color: null, gap: 0.5, ...over });

export const DEFAULT_DECORATION: ParagraphDecoration = {
  ruleBefore: rule(),
  ruleAfter: rule(),
  border: rule(),
  shading: null,
  pad: 0.5,
  length: "column",
};

/** 罫線・網掛けのどれかを使っているか。 */
export const hasDecoration = (d: ParagraphDecoration | undefined): d is ParagraphDecoration =>
  !!d && (d.ruleBefore.on || d.ruleAfter.on || d.border.on || !!d.shading);

/** 正規表現スタイルの規則：pattern（JavaScript の正規表現）に合う字に、文字スタイル style を当てる。 */
export interface GrepRule {
  pattern: string;
  style: string;
}

/** 正規表現スタイルの例（設定欄で選ぶと、正規表現の欄に入る）。 */
export const GREP_EXAMPLES: [string, string][] = [
  ["数字（半角・全角）", "[0-9０-９]+"],
  ["欧文の単語", "[A-Za-zＡ-Ｚａ-ｚ]+"],
  ["かぎかっこの中（かっこを含む）", "「[^」]*」"],
  ["かぎかっこの中（かっこを除く）", "(?<=「)[^」]+(?=」)"],
  ["丸かっこの中", "（[^）]*）"],
  ["三点リーダー・ダッシュ", "[…―]+"],
  ["カタカナ", "[ァ-ヶー]+"],
  ["行頭の1字", "^."],
];

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
  /** 字間（全角1字の 1/1000）。0 なら段落の字間のまま。 */
  tracking: number;
  /** ルビの揃え・側（空なら段落・文書の設定のまま）。 */
  rubyAlign: RubyAlign;
  rubySide: RubySide;
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
  grep: [],
  decoration: structuredClone(DEFAULT_DECORATION),
  dropCap: { lines: 0, chars: 1, style: "" },
  tracking: 0,
  nested: [],
  lineStyle: { style: "", lines: 0 },
  rubyAlign: "",
  rubySide: "",
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
  tracking: 0,
  rubyAlign: "",
  rubySide: "",
  ...over,
});

/** 段落の罫線1本を読む。 */
const ruleOf = (v: unknown): ParagraphRule => {
  const r = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  return rule({
    on: r.on === true,
    kind: RULE_KINDS.some(([k]) => k === r.kind) ? (r.kind as RuleKind) : "solid",
    width: Math.round(num(r.width, 0.5, 0.1, 10) * 100) / 100,
    color: color(r.color),
    gap: Math.round(num(r.gap, 0.5, 0, 5) * 100) / 100,
  });
};

/** ドロップキャップを読む（行数は 0 か 2〜5）。 */
const dropCapOf = (v: unknown): DropCap => {
  const d = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const lines = Math.round(num(d.lines, 0, 0, 5));
  return { lines: lines < 2 ? 0 : lines, chars: Math.round(num(d.chars, 1, 1, 5)), style: typeof d.style === "string" ? d.style : "" };
};

const rubyAlignOf = (v: unknown): RubyAlign => (v === "121" || v === "center" || v === "shoulder" ? v : "");
const rubySideOf = (v: unknown): RubySide => (v === "right" || v === "left" ? v : "");

/** 先頭文字スタイルの規則を読む（8つまで）。 */
const nestedOf = (v: unknown): NestedStyle[] =>
  (Array.isArray(v) ? v : [])
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .slice(0, 8)
    .map((x) => ({
      style: typeof x.style === "string" ? x.style : "",
      until: x.until === "through" || x.until === "before" ? x.until : "chars",
      count: Math.round(num(x.count, 1, 1, 999)),
      chars: typeof x.chars === "string" ? x.chars.slice(0, 20) : "　",
    }));

/** 行スタイルを読む。 */
const lineStyleOf = (v: unknown): LineStyle => {
  const l = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  return { style: typeof l.style === "string" ? l.style : "", lines: Math.round(num(l.lines, 0, 0, 20)) };
};

/** 段落の罫線・網掛けを読む。 */
const decorationOf = (v: unknown): ParagraphDecoration => {
  const d = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  return {
    ruleBefore: ruleOf(d.ruleBefore),
    ruleAfter: ruleOf(d.ruleAfter),
    border: ruleOf(d.border),
    shading: color(d.shading),
    pad: Math.round(num(d.pad, 0.5, 0, 5) * 100) / 100,
    length: d.length === "text" ? "text" : "column",
  };
};

/** 正規表現スタイルの規則を読む（正規表現が読めない規則も、直せるように残す）。 */
const grepRules = (v: unknown): GrepRule[] =>
  (Array.isArray(v) ? v : [])
    .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
    .map((r) => ({ pattern: typeof r.pattern === "string" ? r.pattern.slice(0, 500) : "", style: typeof r.style === "string" ? r.style : "" }))
    .slice(0, 30);

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
        ...(p.spanColumns === true ? { spanColumns: true } : {}),
        color: color(p.color),
        bold: p.bold === true,
        glyphForm: glyphForm(p.glyphForm),
        proportional: p.proportional === true,
        deform: deform(p.deform),
        deformRatio: Math.round(num(p.deformRatio, 80, 30, 99)),
        grep: grepRules(p.grep),
        decoration: decorationOf(p.decoration),
        dropCap: dropCapOf(p.dropCap),
        tracking: Math.round(num(p.tracking, 0, -500, 1000)),
        nested: nestedOf(p.nested),
        lineStyle: lineStyleOf(p.lineStyle),
        rubyAlign: rubyAlignOf(p.rubyAlign),
        rubySide: rubySideOf(p.rubySide),
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
        tracking: Math.round(num(c.tracking, 0, -500, 1000)),
        rubyAlign: rubyAlignOf(c.rubyAlign),
        rubySide: rubySideOf(c.rubySide),
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
