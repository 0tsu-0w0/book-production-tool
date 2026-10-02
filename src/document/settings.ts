import { DEFAULT_NOMBRE_STYLE, type Decoration, type HeadSource, type MasterSettings, type NamedMaster, type NombreStyle, type PageDecor, type Placement } from "../engine/decorate.js";
import type { FormatOptions } from "../engine/format.js";
import type { ParseOptions } from "../engine/parse.js";
import type { Typography } from "../engine/spacing.js";
import type { Kinsoku, LayoutSpec } from "../engine/types.js";
import { DEFAULT_STYLES, normalizeStyles, type StyleSheet } from "./styles.js";

export type { Decoration, HeadSource, MasterSettings, NamedMaster, Placement };

// 文書ごとの設定。文書ファイルに保存され、同じ設定なら同じ組版になる（NF-05）。

export type HalfWidth = "fullwidth" | "rotate";
export type PdfKind = "print" | "print-nomarks" | "screen";

export interface FormatSettings {
  /** FMT-01 符号の変換（ーー → ――、... → ……）。 */
  symbols: boolean;
  /** FMT-02 段落頭の字下げ。 */
  indent: boolean;
  /** FMT-03 会話文前後の空行の削除。 */
  dialogueBlankLines: boolean;
  /** FMT-04 半角数字を全角にする。 */
  digitsFullWidth: boolean;
  /** FMT-05 2〜3桁の半角数字を縦中横にする。 */
  tcyDigits: boolean;
  /** FMT-06 数字を漢数字にする。 */
  kanjiNumerals: boolean;
  /** FMT-07 文中の感嘆符・疑問符の後に全角空白を入れる。 */
  spaceAfterMarks: boolean;
  /** FMT-08 3つ以上続く感嘆符・疑問符を2つにする。 */
  limitMarks: boolean;
  /** IN-07 半角の英字を全角にするか、横倒しで組むか。 */
  halfWidth: HalfWidth;
  /** IN-05 ＝＝＝ の行で改ページする。 */
  pageBreakMark: boolean;
  /** 原稿の記法：Kolophon の記法か、TeX（LaTeX）の記法か。 */
  markup: "standard" | "tex";
}

export interface CustomLayout {
  marginXMm: number;
  marginYMm: number;
  fontSizePt: number;
  lineGapPercent: number;
}

export interface FontChoice {
  /** 画面に出す名前。 */
  name: string;
  postscriptName: string;
  path: string;
  /** .ttc の中の何番目のフォントか。 */
  index: number;
}

export interface ImageSettings {
  format: "png" | "jpeg";
  dpi: number;
  jpegQuality: number;
  /** 書き出すページ（ノンブルで「1-10, 15, 20-」。空なら全ページ。OUT-07）。 */
  range: string;
  /** SNS 向けに4枚ずつの組（フォルダ）に分ける（OUT-08）。 */
  snsGroups: boolean;
  /** 画像にだけ入れるクレジット（下の余白に小さく。空なら入れない。OUT-08）。 */
  credit: string;
}

/** 判型と版面を自分で決めるときの設定（DTP-01〜03）。 */
export interface BookLayout {
  /** 判型の名前（TRIM_SIZES のキー）。「自由」なら widthMm・heightMm を使う。 */
  trim: string;
  widthMm: number;
  heightMm: number;
  fontSizePt: number;
  /** 1段の字数。 */
  charsPerLine: number;
  /** 1段の行数。 */
  linesPerPage: number;
  lineGapPercent: number;
  /** 段数（1〜4）。 */
  columns: number;
  /** 段間（字数）。 */
  columnGapChars: number;
  /** 版面の位置：ページの中央か、天とノドの余白で決めるか。 */
  position: "center" | "top-gutter";
  /** 組み方向：縦組み（右綴じ）か横組み（左綴じ）。DTP-01。 */
  writingMode: "vertical" | "horizontal";
  topMm: number;
  gutterMm: number;
  /** 横組みの句読点：「、。」「，。」「，．」。縦組みでは使わない。 */
  punctuation: HorizontalPunctuation;
  /** 横組みで、行末に入らない英単語をハイフンで分ける。 */
  hyphenation: boolean;
}

export type HorizontalPunctuation = "、。" | "，。" | "，．";
export const HORIZONTAL_PUNCTUATION: HorizontalPunctuation[] = ["、。", "，。", "，．"];

/**
 * 組み方向を変えたとき、字数と行数を版面に収まるように決め直す（縦組みの字数のまま横組みにすると、
 * 行がページからはみ出すため）。余白は天・ノドの指定を使い、地と小口はそれと同じくらい（最低 12mm）取る。
 */
export function fitBookToWritingMode(b: BookLayout): void {
  const [w, h] = trimSize(b);
  const size = b.fontSizePt / MM;
  const pitch = size * (b.lineGapPercent / 100);
  const centered = b.position === "center";
  const top = centered ? 15 : b.topMm;
  const inner = centered ? 15 : b.gutterMm;
  const bottom = Math.max(12, top);
  const outer = Math.max(12, inner * 0.8);
  // 字の並ぶ向きの長さ（段を含む）と、行の並ぶ向きの長さ。
  const along = b.writingMode === "horizontal" ? w - inner - outer : h - top - bottom;
  const across = b.writingMode === "horizontal" ? h - top - bottom : w - inner - outer;
  const gap = b.columns > 1 ? (b.columns - 1) * b.columnGapChars * size : 0;
  b.charsPerLine = Math.max(5, Math.floor((along - gap) / b.columns / size + 1e-9));
  b.linesPerPage = Math.max(1, Math.floor((across - size) / pitch + 1e-9) + 1);
}

/** 書誌（扉・奥付・柱の書名に使う）。 */
export interface BookInfo {
  title: string;
  author: string;
  publisher: string;
  printer: string;
  /** 発行日と版（複数行可。例：2026年10月1日　初版発行）。 */
  issued: string;
  /** そのほか奥付に載せること（複数行可）。 */
  extra: string;
}

/** 本文の前後に入れるページ：本扉・白ページ・奥付・自由なページ（献辞など。原稿と同じ記法）。 */
export type PageItemKind = "title" | "blank" | "colophon" | "free" | "toc";
export interface PageItem {
  kind: PageItemKind;
  /** 自由なページの中身。 */
  text: string;
}

/** ページ構成（DTP-13）。 */
export interface PageStructure {
  front: PageItem[];
  back: PageItem[];
  /** 総ページ数をこの数の倍数にそろえる（本文と後ろのページの間に白ページを足す）。1 ならそろえない。 */
  padTo: number;
}

export const PAGE_ITEM_KINDS: PageItemKind[] = ["title", "blank", "colophon", "free", "toc"];

/** 表紙。画像は文書の画像の名前（空なら使わない）。 */
export interface CoverSettings {
  /** 地の色（塗り足しまで）。 */
  background: string;
  /** 題・著者名の色。 */
  textColor: string;
  /** 表1（表）と表4（裏）の画像。塗り足しまで広げて、はみ出た分を切る。 */
  frontImage: string;
  backImage: string;
  /** 背に題と著者名を入れる（背幅が4mmより狭いときは入れない）。 */
  spineText: boolean;
}

/** 目次（DTP-14）。 */
export interface TocSettings {
  /** 目次の題（空なら題を出さない）。 */
  title: string;
  /** 載せる見出し：1 なら大見出しだけ、2 なら中見出しまで。 */
  levels: number;
  /** ページ番号：算用数字（2〜3桁は縦中横）か漢数字。 */
  numerals: "arabic" | "kanji";
  /** リーダー（見出しとページ番号の間を埋める字）。 */
  leader: string;
}

/** 目次のリーダーに使える字。 */
export const TOC_LEADERS: [string, string][] = [
  ["…", "三点リーダ（…）"],
  ["・", "中黒（・）"],
  ["．", "ピリオド（．）"],
  ["―", "ダッシュ（―）"],
  ["　", "空白（なし）"],
];
export const PAD_CHOICES = [1, 2, 4, 8, 16];

/** 本文用紙（背幅の計算に使う）。厚さは1枚（2ページ分）の目安。 */
export const PAPERS: Record<string, number> = {
  "上質紙 55kg": 0.075,
  "上質紙 70kg": 0.095,
  "上質紙 90kg": 0.12,
  "上質紙 110kg": 0.145,
  "書籍用紙 72.5kg": 0.11,
  "ラフ系の嵩高紙 70kg": 0.13,
};
export const CUSTOM_PAPER = "厚さを入れる";

/** 書き出しの設定（OUT-03・05・10）。 */
export interface OutputSettings {
  /** auto：入稿用は CMYK、閲覧用・画像はそのまま。gray：すべてグレースケール。 */
  color: "auto" | "gray";
  /**
   * 面付け：単ページ・見開き（閲覧用 PDF と画像）・中綴じ（閲覧用 PDF。家庭のプリンターで両面に刷って、
   * 半分に折って綴じると冊子になる順に、2ページずつ並べる）。
   */
  imposition: "single" | "spread" | "saddle";
  /** 画像を1つの ZIP にまとめる。 */
  zipImages: boolean;
  /** 本文用紙（PAPERS のキーか CUSTOM_PAPER）。 */
  paper: string;
  /** 自分で入れる紙の厚さ（mm）。 */
  paperThicknessMm: number;
  /** 入稿用 PDF の規格：PDF/X-1a:2003 か PDF/X-4。 */
  pdfStandard: "x1a" | "x4";
  /** PDF/X-4 に埋め込む印刷条件（CMYK の ICC プロファイル）のファイル。 */
  iccPath: string;
  /** 入稿用 PDF で、文字をアウトライン化する（フォントを埋め込まない）。 */
  outline: boolean;
  /** 特色：画面でこの色を使った所を、入稿用 PDF では特色の版で刷る。 */
  spotColors: SpotColor[];
  /** 入稿用 PDF で、スミ（K100%）の文字・罫をノセ（オーバープリント）にする。 */
  overprintBlack: boolean;
}

/** 特色の登録。 */
export interface SpotColor {
  /** 印刷所に伝えるインキの名前（例：DIC 156）。PDF の版の名前になる。 */
  name: string;
  /** 画面での色（#rrggbb）。この色で描いた所が特色になる。 */
  color: string;
  /** 代わりの CMYK（各 0〜100）。特色を使えないときや、校正の表示に使われる。 */
  cmyk: [number, number, number, number];
  /** ノセ（下の色を抜かずに重ねて刷る）。 */
  overprint: boolean;
}

/** 特色の登録を確かめて、使えるものだけにする（名前と色が重ならないように）。 */
export function normalizeSpots(v: unknown): SpotColor[] {
  if (!Array.isArray(v)) return [];
  const out: SpotColor[] = [];
  for (const x of v) {
    const s = (x && typeof x === "object" ? x : {}) as Partial<SpotColor>;
    const name = typeof s.name === "string" ? s.name.trim().slice(0, 60) : "";
    const color = typeof s.color === "string" && /^#[0-9a-f]{6}$/i.test(s.color) ? s.color.toLowerCase() : "";
    if (!name || !color || out.some((o) => o.name === name || o.color === color)) continue;
    const cmyk = (Array.isArray(s.cmyk) ? s.cmyk : []).slice(0, 4).map((n) => (typeof n === "number" && Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0));
    while (cmyk.length < 4) cmyk.push(0);
    out.push({ name, color, cmyk: cmyk as SpotColor["cmyk"], overprint: s.overprint === true });
  }
  return out.slice(0, 16);
}

/** 詳細設定：ふだんは既定のままでよい、細かな組版と書き出しの値。 */
export interface AdvancedSettings {
  /** ルビ・圏点の大きさ（本文の文字サイズに対する %）。 */
  rubyPercent: number;
  /** 自動で縦中横にする数字の桁数の上限（2〜4）。 */
  tcyMaxDigits: number;
  /** 行頭に置かない字を追加する（禁則。並べて書く）。 */
  kinsokuStartExtra: string;
  /** 行末に置かない字を追加する。 */
  kinsokuEndExtra: string;
  /** 行の中の数式と和文の間（em）。 */
  mathSpaceEm: number;
  /** 画像の回り込みで、画像と本文の間に空ける字数。 */
  wrapGapChars: number;
  /** かんたんな組み方の付記・ノンブルの大きさ（本文に対する %）。 */
  noteScalePercent: number;
  /** 入稿用 PDF の塗り足し（mm）。全面の画像もこの幅まで伸ばす。 */
  bleedMm: number;
  /** PDF に入れる画像を、この解像度（ppi）を大きく超えるなら縮める。 */
  imagePpi: number;
  /** 書き出す前の検査で、文字を仕上がり線から離しておく距離（mm）。 */
  safeMarginMm: number;
}

export interface Settings {
  /** simple：参照元と同じ字組（文庫・版面は中央）。book：判型と版面を自分で決める。 */
  layoutMode: "simple" | "book";
  preset: string;
  custom: CustomLayout;
  book: BookLayout;
  /** 大見出しを奇数ページから始める（改丁。DTP-11）。 */
  chapterStartsOdd: boolean;
  /** 白ページ（改丁で入る空のページ）にもノンブルを付ける。 */
  blankPageNombre: boolean;
  /** 柱とマスターページ（詳しい組み方のとき。DTP-05）。 */
  master: MasterSettings;
  /** 名前を付けたマスターページ（［＃マスター：名前］で使う）。 */
  masters: NamedMaster[];
  /** 約物の詰めとルビの掛け方（DTP-06・07）。 */
  typography: Typography;
  /** 段落スタイル・文字スタイル（DTP-04）。 */
  styles: StyleSheet;
  /** 書誌（DTP-13）。 */
  bookInfo: BookInfo;
  /** 扉・奥付などのページ構成（DTP-13）。 */
  pages: PageStructure;
  /** 目次（DTP-14）。 */
  toc: TocSettings;
  /** 注（［＃注：…］）を置く場所：章ごと（次の大見出しの前）か本の終わり。 */
  notes: { placement: "chapter" | "end" | "page" };
  /** ノンブルの書き方（前付けの番号・数字）と位置の微調整。 */
  nombreStyle: NombreStyle;
  /**
   * 合成フォント：本文の書体の字のうち、かな（ひらがな・カタカナ）と欧文（半角の英数字・記号）を別の書体にする。
   * null なら本文の書体のまま。スタイルで書体を指定した字には効かない。
   */
  compositeFont: { kana: FontChoice | null; latin: FontChoice | null };
  /** 表紙（表1・背・表4）。題と著者名は書誌のもの。 */
  cover: CoverSettings;
  /** 詳細設定。 */
  advanced: AdvancedSettings;
  kinsoku: Kinsoku;
  hanging: boolean;
  headingBlankAfter: number;
  format: FormatSettings;

  note1: string;
  note2: string;
  note2Faint: boolean;
  nombre: boolean;
  nombreStart: number;
  placement: Placement;
  spread: boolean;
  border: boolean;

  paperColor: string;
  textColor: string;
  decoration: Decoration;
  decoColor1: string;
  decoColor2: string;

  /** null なら既定のフォント。 */
  font: FontChoice | null;

  image: ImageSettings;
  pdfKind: PdfKind;
  output: OutputSettings;
}

export const CUSTOM_PRESET = "自分で設定する";

/** 参照元（文庫ページメーカー）の字組と同じ字数・行数・行間。 */
export const PRESETS: Record<string, { fontSizePt: number; charsPerLine: number; linesPerPage: number; lineGap: number }> = {
  "文字小（39字×16行）": { fontSizePt: 8.5, charsPerLine: 39, linesPerPage: 16, lineGap: 1.67 },
  "文字中（36字×15行）": { fontSizePt: 9.25, charsPerLine: 36, linesPerPage: 15, lineGap: 1.67 },
  "文字大（34字×14行）": { fontSizePt: 10, charsPerLine: 34, linesPerPage: 14, lineGap: 1.67 },
  "文字小／広め（39字×15行）": { fontSizePt: 8.5, charsPerLine: 39, linesPerPage: 15, lineGap: 1.75 },
  "文字中／広め（36字×14行）": { fontSizePt: 9.25, charsPerLine: 36, linesPerPage: 14, lineGap: 1.75 },
  "文字大／広め（33字×13行）": { fontSizePt: 10, charsPerLine: 33, linesPerPage: 13, lineGap: 1.75 },
  "文字中／余白小さめ（39字×16行）": { fontSizePt: 9.25, charsPerLine: 39, linesPerPage: 16, lineGap: 1.67 },
  "文字大／余白小さめ（36字×15行）": { fontSizePt: 10, charsPerLine: 36, linesPerPage: 15, lineGap: 1.67 },
  "文字中／行間余白小さめ（39字×18行）": { fontSizePt: 9.25, charsPerLine: 39, linesPerPage: 18, lineGap: 1.5 },
  "文字大／行間余白小さめ（36字×17行）": { fontSizePt: 10, charsPerLine: 36, linesPerPage: 17, lineGap: 1.5 },
};

/** 判型（仕上がりの寸法、mm）。 */
export const TRIM_SIZES: Record<string, [number, number]> = {
  "文庫（A6）": [105, 148],
  新書: [103, 182],
  四六判: [127, 188],
  B6: [128, 182],
  A5: [148, 210],
  B5: [182, 257],
};
export const FREE_TRIM = "自由";

export const FONT_SIZES_PT = [8.5, 9, 9.25, 10, 10.5, 11, 12];
export const LINE_GAPS_PERCENT = [150, 167, 175, 200];

/** 和色の名前と色。値は一般に流布している伝統色の近似値。 */
export const PAPER_COLORS: [string, string][] = [
  ["白", "#ffffff"], ["白練", "#f3f3f2"], ["象牙", "#f8f4e6"], ["藍白", "#ebf6f7"], ["桜", "#fef4f4"],
  ["白藤", "#dbd0e6"], ["白緑", "#d6e9ca"], ["白鼠", "#dcdddd"], ["鳥の子", "#fff1cf"], ["菜の花", "#ffec47"],
  ["萱草", "#f8b862"], ["灰桜", "#e8d3d1"], ["青磁鼠", "#bed2c3"], ["銀朱", "#c85554"], ["蘇芳", "#9e3d3f"],
  ["苔", "#69821b"], ["縹", "#2792c3"], ["勿忘草", "#89c3eb"], ["花紺青", "#4c6cb3"], ["紺", "#223a70"],
  ["呂", "#0c0c0c"], ["黒", "#2b2b2b"],
];
export const TEXT_COLORS: [string, string][] = [
  ["黒", "#000000"], ["白鼠", "#dcdddd"], ["白花", "#e8ecef"], ["白", "#ffffff"], ["灰桜", "#e8d3d1"],
  ["桑染", "#b79b5b"], ["蘇芳", "#9e3d3f"], ["真朱", "#ec6d71"], ["銀朱", "#c85554"], ["韓紅花", "#e95464"],
  ["山吹", "#f8b500"], ["苔", "#69821b"], ["常磐", "#007b43"], ["海松茶", "#5a544b"], ["千歳緑", "#316745"],
  ["熨斗目花", "#2b4b65"], ["花紺青", "#4c6cb3"], ["紺", "#223a70"], ["桔梗", "#5654a2"], ["深紫", "#493759"],
];

export const DEFAULT_SETTINGS: Settings = {
  layoutMode: "simple",
  preset: "文字中（36字×15行）",
  custom: { marginXMm: 12, marginYMm: 15, fontSizePt: 9.25, lineGapPercent: 167 },
  book: {
    trim: "文庫（A6）",
    widthMm: 105,
    heightMm: 148,
    fontSizePt: 9,
    charsPerLine: 38,
    linesPerPage: 15,
    lineGapPercent: 175,
    columns: 1,
    columnGapChars: 2,
    position: "top-gutter",
    writingMode: "vertical",
    punctuation: "、。",
    hyphenation: true,
    topMm: 14,
    gutterMm: 12,
  },
  chapterStartsOdd: false,
  blankPageNombre: false,
  master: {
    bookTitle: "",
    headPosition: "top-outer",
    nombrePosition: "bottom-outer",
    gapMm: 4,
    sizePt: 7,
    // 奇数ページ（左ページ）に章題、偶数ページ（右ページ）に書名。章の始まりのページには柱を出さない。
    bodyOdd: "chapter",
    bodyEven: "book-title",
    bodyNombre: true,
    openingOdd: "none",
    openingEven: "none",
    openingNombre: true,
  },
  masters: [],
  // 既定は全角ベタ組み（参照元と同じ）。JIS 準拠は設定で選ぶ。
  typography: { mode: "grid", lineHeadBracket: "full", oikomi: true, rubyOverhang: true },
  styles: DEFAULT_STYLES,
  bookInfo: { title: "", author: "", publisher: "", printer: "", issued: "", extra: "" },
  pages: { front: [], back: [], padTo: 1 },
  toc: { title: "目次", levels: 2, numerals: "arabic", leader: "…" },
  notes: { placement: "chapter" },
  nombreStyle: { ...DEFAULT_NOMBRE_STYLE },
  compositeFont: { kana: null, latin: null },
  cover: { background: "#ffffff", textColor: "#000000", frontImage: "", backImage: "", spineText: true },
  advanced: {
    rubyPercent: 50,
    tcyMaxDigits: 3,
    kinsokuStartExtra: "",
    kinsokuEndExtra: "",
    mathSpaceEm: 0.25,
    wrapGapChars: 1,
    noteScalePercent: 80,
    bleedMm: 3,
    imagePpi: 400,
    safeMarginMm: 3,
  },
  kinsoku: "strong",
  hanging: true,
  headingBlankAfter: 0,
  format: {
    symbols: false,
    indent: false,
    dialogueBlankLines: false,
    digitsFullWidth: false,
    tcyDigits: true,
    kanjiNumerals: false,
    spaceAfterMarks: false,
    limitMarks: false,
    halfWidth: "fullwidth",
    pageBreakMark: true,
    markup: "standard",
  },
  note1: "",
  note2: "",
  note2Faint: false,
  nombre: true,
  nombreStart: 1,
  placement: "note-tl.nombre-bl",
  spread: false,
  border: false,
  paperColor: "#ffffff",
  textColor: "#000000",
  decoration: "none",
  decoColor1: "#9e3d3f",
  decoColor2: "#223a70",
  font: null,
  image: { format: "png", dpi: 350, jpegQuality: 0.92, range: "", snsGroups: false, credit: "" },
  pdfKind: "print",
  output: { color: "auto", imposition: "single", zipImages: false, paper: "書籍用紙 72.5kg", paperThicknessMm: 0.1, pdfStandard: "x1a", iccPath: "", outline: false, spotColors: [], overprintBlack: true },
};

/** 紙1枚の厚さ（mm）。 */
export function paperThickness(o: OutputSettings): number {
  return PAPERS[o.paper] ?? o.paperThicknessMm;
}

/** 背幅（mm）：本文の紙の枚数（2ページで1枚）× 紙の厚さ。表紙の厚さは含まない（OUT-10）。 */
export function spineWidthMm(pageCount: number, o: OutputSettings): number {
  return Math.ceil(pageCount / 2) * paperThickness(o);
}

/** 見開きで書き出すか（入稿用 PDF は単ページのまま）。 */
/** 左綴じ（横組み）か。 */
export function leftBound(s: Settings): boolean {
  return s.layoutMode === "book" && s.book.writingMode === "horizontal";
}

export function spreadOutput(s: Settings, target: "pdf" | "images"): boolean {
  return s.output.imposition === "spread" && (target === "images" || s.pdfKind === "screen");
}

/** 中綴じの面付けで書き出すか（閲覧用 PDF だけ。入稿用は印刷所が面付けするので単ページのまま）。 */
export function saddleOutput(s: Settings): boolean {
  return s.output.imposition === "saddle" && s.pdfKind === "screen";
}

/** 「お任せ整形」で入れる整形ルールの組み合わせ（参照元のお節介アシスト相当）。 */
export const RECOMMENDED_FORMAT: Partial<FormatSettings> = {
  symbols: true,
  indent: true,
  dialogueBlankLines: true,
  spaceAfterMarks: true,
  limitMarks: true,
};

const PAGE = { widthMm: 105, heightMm: 148 };
const MM = 72 / 25.4;

/** 設定から、組版エンジンに渡す版面の指定を作る。 */
export function toLayoutSpec(s: Settings): LayoutSpec {
  const common = {
    kinsoku: s.kinsoku,
    hanging: s.hanging,
    rubyScale: s.advanced.rubyPercent / 100,
    kinsokuExtra: { start: s.advanced.kinsokuStartExtra, end: s.advanced.kinsokuEndExtra },
    wrapGapChars: s.advanced.wrapGapChars,
    mathSpaceEm: s.advanced.mathSpaceEm,
    bleedMm: s.advanced.bleedMm,
    headingBlankAfter: s.headingBlankAfter,
    firstPageNumber: s.nombreStart,
    chapterStartsOdd: s.chapterStartsOdd,
    typography: s.typography,
  };
  if (s.layoutMode === "book") {
    const b = s.book;
    const [w, h] = trimSize(b);
    return {
      ...common,
      pageWidthMm: w,
      pageHeightMm: h,
      fontSizePt: b.fontSizePt,
      charsPerLine: b.charsPerLine,
      linesPerPage: b.linesPerPage,
      lineGap: b.lineGapPercent / 100,
      columns: b.columns,
      columnGapPt: b.columnGapChars * b.fontSizePt,
      margins: b.position === "top-gutter" ? { topMm: b.topMm, gutterMm: b.gutterMm } : null,
      horizontal: b.writingMode === "horizontal",
    };
  }
  const simple = { ...common, pageWidthMm: PAGE.widthMm, pageHeightMm: PAGE.heightMm, columns: 1, columnGapPt: 0, margins: null };
  if (s.preset !== CUSTOM_PRESET && PRESETS[s.preset]) return { ...simple, ...PRESETS[s.preset] };
  return { ...simple, ...customGrid(s.custom) };
}

export function trimSize(b: Pick<BookLayout, "trim" | "widthMm" | "heightMm">): [number, number] {
  return TRIM_SIZES[b.trim] ?? [b.widthMm, b.heightMm];
}

/** 版面の大きさと四方の余白（mm）。余白が負なら版面がページからはみ出している。 */
export function bookGeometry(b: BookLayout): { blockWidthMm: number; blockHeightMm: number; top: number; bottom: number; gutter: number; foreEdge: number } {
  const [w, h] = trimSize(b);
  const size = b.fontSizePt / MM;
  // 行の並ぶ向きの長さと、字の並ぶ向きの長さ。横組みでは縦横が入れ替わる。
  const across = (b.linesPerPage - 1) * size * (b.lineGapPercent / 100) + size;
  const along = b.columns * b.charsPerLine * size + (b.columns - 1) * b.columnGapChars * size;
  const horizontal = b.writingMode === "horizontal";
  const blockWidthMm = horizontal ? along : across;
  const blockHeightMm = horizontal ? across : along;
  const top = b.position === "top-gutter" ? b.topMm : (h - blockHeightMm) / 2;
  const gutter = b.position === "top-gutter" ? b.gutterMm : (w - blockWidthMm) / 2;
  return { blockWidthMm, blockHeightMm, top, bottom: h - top - blockHeightMm, gutter, foreEdge: w - gutter - blockWidthMm };
}

/** 余白・文字サイズ・行間から、入る字数と行数を求める（LAY-02）。 */
export function customGrid(c: CustomLayout): { fontSizePt: number; charsPerLine: number; linesPerPage: number; lineGap: number } {
  const size = c.fontSizePt;
  const lineGap = c.lineGapPercent / 100;
  const usableW = (PAGE.widthMm - c.marginXMm * 2) * MM;
  const usableH = (PAGE.heightMm - c.marginYMm * 2) * MM;
  const charsPerLine = Math.max(1, Math.floor(usableH / size + 1e-9));
  const linesPerPage = Math.max(1, Math.floor((usableW - size) / (size * lineGap) + 1e-9) + 1);
  return { fontSizePt: size, charsPerLine, linesPerPage, lineGap };
}

/**
 * 読み込んだ設定を、今の形式にそろえる。欠けている項目は既定値で埋め、知らない項目は捨てる。
 * 古い文書ファイルを開いたときや、設定の項目が増えたときのため。
 */
export function normalizeSettings(input: unknown): Settings {
  const src = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const out = structuredClone(DEFAULT_SETTINGS) as unknown as Record<string, unknown>;
  for (const [key, def] of Object.entries(DEFAULT_SETTINGS)) {
    const v = src[key];
    if (v === undefined) continue;
    if (key === "styles") {
      // スタイルは配列を含むので、専用の読み替えで中身まで確かめる。
      out.styles = normalizeStyles(v);
      continue;
    }
    if (key === "pages") {
      out.pages = normalizePages(v);
      continue;
    }
    if (key === "masters") {
      out.masters = normalizeMasters(v);
      continue;
    }
    if (def !== null && typeof def === "object" && !Array.isArray(def)) {
      if (v && typeof v === "object") {
        const merged = out[key] as Record<string, unknown>;
        for (const sub of Object.keys(def)) {
          const sv = (v as Record<string, unknown>)[sub];
          if (sv !== undefined && typeof sv === typeof (def as Record<string, unknown>)[sub]) merged[sub] = sv;
        }
      }
    } else if (key === "font") {
      out.font = isFontChoice(v) ? v : null;
    } else if (typeof v === typeof def) {
      out[key] = v;
    }
  }
  const s = out as unknown as Settings;
  if (s.preset !== CUSTOM_PRESET && !PRESETS[s.preset]) s.preset = DEFAULT_SETTINGS.preset;
  if (s.format.markup !== "tex") s.format.markup = "standard";
  if (!TOC_LEADERS.some(([k]) => k === s.toc.leader)) s.toc.leader = "…";
  // 詳細設定は、範囲の外の値を範囲に収める。
  const a = s.advanced;
  const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
  a.rubyPercent = clamp(a.rubyPercent, 30, 80);
  a.tcyMaxDigits = Math.round(clamp(a.tcyMaxDigits, 2, 4));
  a.mathSpaceEm = clamp(a.mathSpaceEm, 0, 1);
  a.wrapGapChars = clamp(a.wrapGapChars, 0, 5);
  a.noteScalePercent = clamp(a.noteScalePercent, 50, 150);
  a.bleedMm = clamp(a.bleedMm, 0, 10);
  a.imagePpi = clamp(a.imagePpi, 150, 1200);
  a.safeMarginMm = clamp(a.safeMarginMm, 0, 10);
  if (s.output.pdfStandard !== "x4") s.output.pdfStandard = "x1a";
  if (s.notes.placement !== "end" && s.notes.placement !== "page") s.notes.placement = "chapter";
  if (!isFontChoice(s.compositeFont.kana)) s.compositeFont.kana = null;
  if (!isFontChoice(s.compositeFont.latin)) s.compositeFont.latin = null;
  const ns = s.nombreStyle;
  if (!["continue", "roman", "roman-upper", "none"].includes(ns.front)) ns.front = "continue";
  if (!["arabic", "fullwidth", "kanji"].includes(ns.numerals)) ns.numerals = "arabic";
  ns.outerMm = Number.isFinite(ns.outerMm) ? Math.min(30, Math.max(-30, ns.outerMm)) : 0;
  ns.downMm = Number.isFinite(ns.downMm) ? Math.min(30, Math.max(-30, ns.downMm)) : 0;
  if (!/^#[0-9a-f]{6}$/i.test(s.cover.background)) s.cover.background = "#ffffff";
  if (!/^#[0-9a-f]{6}$/i.test(s.cover.textColor)) s.cover.textColor = "#000000";
  if (s.toc.levels !== 1) s.toc.levels = 2;
  if (s.toc.numerals !== "kanji") s.toc.numerals = "arabic";
  if (s.book.writingMode !== "horizontal") s.book.writingMode = "vertical";
  if (!HORIZONTAL_PUNCTUATION.includes(s.book.punctuation)) s.book.punctuation = "、。";
  const o = s.output;
  if (o.color !== "gray") o.color = "auto";
  if (o.imposition !== "spread" && o.imposition !== "saddle") o.imposition = "single";
  o.spotColors = normalizeSpots(o.spotColors);
  if (!(o.paper in PAPERS) && o.paper !== CUSTOM_PAPER) o.paper = DEFAULT_SETTINGS.output.paper;
  if (!(o.paperThicknessMm > 0.02 && o.paperThicknessMm < 1)) o.paperThicknessMm = DEFAULT_SETTINGS.output.paperThicknessMm;
  return s;
}

const HEAD_SOURCES: HeadSource[] = ["none", "book-title", "chapter", "section"];

function normalizeMasters(v: unknown): NamedMaster[] {
  if (!Array.isArray(v)) return [];
  const head = (x: unknown, def: HeadSource): HeadSource => (HEAD_SOURCES.includes(x as HeadSource) ? (x as HeadSource) : def);
  const seen = new Set<string>();
  return v
    .filter((m): m is Record<string, unknown> => !!m && typeof m === "object" && typeof (m as { name?: unknown }).name === "string")
    .filter((m) => {
      const name = m.name as string;
      if (!name || /[［］＃／：:\s]/u.test(name) || name === "標準" || seen.has(name)) return false;
      seen.add(name);
      return true;
    })
    .map((m) => ({
      name: m.name as string,
      bodyOdd: head(m.bodyOdd, "none"),
      bodyEven: head(m.bodyEven, "none"),
      bodyNombre: m.bodyNombre !== false,
      openingOdd: head(m.openingOdd, "none"),
      openingEven: head(m.openingEven, "none"),
      openingNombre: m.openingNombre !== false,
      decoration: typeof m.decoration === "string" ? (m.decoration as NamedMaster["decoration"]) : "inherit",
    }));
}

function normalizePages(v: unknown): PageStructure {
  const src = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const items = (list: unknown): PageItem[] =>
    (Array.isArray(list) ? list : [])
      .filter((i): i is PageItem => !!i && PAGE_ITEM_KINDS.includes((i as PageItem).kind))
      .map((i) => ({ kind: i.kind, text: typeof i.text === "string" ? i.text : "" }));
  const padTo = typeof src.padTo === "number" && PAD_CHOICES.includes(src.padTo) ? src.padTo : 1;
  return { front: items(src.front), back: items(src.back), padTo };
}

function isFontChoice(v: unknown): v is FontChoice {
  const f = v as FontChoice;
  return !!f && typeof f.path === "string" && typeof f.postscriptName === "string" && typeof f.index === "number";
}

export function toFormatOptions(s: Settings): FormatOptions {
  const { symbols, indent, dialogueBlankLines, digitsFullWidth, kanjiNumerals, spaceAfterMarks, limitMarks } = s.format;
  return { symbols, indent, dialogueBlankLines, digitsFullWidth, kanjiNumerals, spaceAfterMarks, limitMarks };
}

export function toParseOptions(s: Settings): ParseOptions {
  // 横組みでは、半角の英数字は半角のまま（字の幅どおり）に組み、数字を縦中横にしない。
  if (leftBound(s)) return { tcyDigits: false, halfWidth: "rotate", pageBreakMark: s.format.pageBreakMark, tcyMaxDigits: s.advanced.tcyMaxDigits };
  return { tcyDigits: s.format.tcyDigits, halfWidth: s.format.halfWidth, pageBreakMark: s.format.pageBreakMark, tcyMaxDigits: s.advanced.tcyMaxDigits };
}

/** 合成フォントで使う書体（かな・欧文の順。使わないものは null）。フォントを読むときに本文・スタイルの書体に足す。 */
export function compositeFonts(s: Pick<Settings, "compositeFont">): (FontChoice | null)[] {
  return [s.compositeFont.kana, s.compositeFont.latin];
}

/** 横組みの句読点に置き換える（字数は変わらないので、原稿の位置はずれない）。 */
export function horizontalPunctuation(text: string, s: Settings): string {
  if (!leftBound(s) || s.book.punctuation === "、。") return text;
  const out = text.replace(/、/g, "，");
  return s.book.punctuation === "，．" ? out.replace(/。/g, "．") : out;
}

export function toPageDecor(s: Settings): PageDecor {
  const { note1, note2, note2Faint, nombre, nombreStart, placement, spread, border, blankPageNombre, paperColor, textColor, decoration, decoColor1, decoColor2 } = s;
  return {
    mode: s.layoutMode,
    masters: s.masters,
    // 柱の書名が空なら、書誌の書名を使う。
    master: { ...s.master, bookTitle: s.master.bookTitle || s.bookInfo.title },
    note1,
    note2,
    note2Faint,
    nombre,
    nombreStart,
    placement,
    spread,
    border,
    blankPageNombre,
    horizontal: s.layoutMode === "book" && s.book.writingMode === "horizontal",
    noteScale: s.advanced.noteScalePercent / 100,
    paperColor,
    textColor,
    decoration,
    decoColor1,
    decoColor2,
    nombreStyle: s.nombreStyle,
  };
}
