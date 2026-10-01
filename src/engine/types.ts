import type { Typography } from "./spacing.js";

// 組版エンジンで共有する型。単位は特に断りがなければ pt（1pt = 1/72 インチ）。
// 色は "#rrggbb" の文字列で持ち、PDF の入稿用では CMYK に変換する。

/** 版面の1マスに入るもの。縦中横なら複数の文字が1マスに入る。 */
export interface Cell {
  text: string;
  tcy?: boolean;
  /** 半角英数字を横倒しで組む。advance はそのときの長さ（em）。 */
  rotate?: boolean;
  /** 行方向の長さ（em）。省略時は 1。 */
  advance?: number;
  /** 字形をマスの上端からずらす量（em。負なら上へ）。半角にした始め括弧などで使う。 */
  shift?: number;
  /** 行を合わせるために、さらに詰められる量（em）。約物のアキ。 */
  compress?: number;
  /** 詰めるのがマスの前（上）側か。始め括弧は前にアキがある。 */
  compressFromStart?: boolean;
  /** 使うフォントの番号（0 は本文の書体）。 */
  font?: number;
  /** 本文の文字サイズに対する倍率。 */
  scale?: number;
  bold?: boolean;
  color?: string;
  /** OpenType の字形の機能（jp78・trad など。カンマ区切り）。 */
  features?: string;
  /** プロポーショナル（字の幅どおりに詰める）。 */
  proportional?: boolean;
  /** 原稿の行の中での位置（紙面から原稿へ戻るのに使う。DTP-15）。 */
  src?: number;
  /** 数式（text は TeX）。display なら別行数式。pad は前後の空き（em）。 */
  math?: { display: boolean; pad?: number };
}

/** 行分割で切り離さない最小単位（1文字、ルビ付きの親文字列、「――」など）。 */
export interface Atom {
  cells: Cell[];
  ruby?: string;
  /** 圏点の記号（﹅・﹆・●・○ など）。 */
  kenten?: string;
  /** 傍線（字の右に引く線）。 */
  sideline?: SideLine;
  /** 割注の文字列。cells は半角（0.5em）ずつの枠で、字は2行に分けて置く。 */
  warichu?: string;
  /** ルビが前の文字に掛かる長さ（em）。 */
  rubyBefore?: number;
  /** 文字スタイルの名前（［＃名前］…［＃／名前］）。 */
  style?: string;
  /** リーダー（目次の点線）：行の残りを埋めるまで、この字を繰り返す。 */
  leader?: boolean;
}

export type SideLine = "single" | "double" | "wave" | "dotted" | "dashed";

/** 段落の組み方（段落スタイルから決まる）。 */
export interface ParaFormat {
  indent: number;
  align: "start" | "center" | "end";
  /** 行取り（何行分の幅を取るか）。 */
  lineSpan: number;
  /** 行送り：標準の行送りに対する倍率（1 なら標準）。行取りとかけ合わせた幅を1行が取る。 */
  linePitch?: number;
  spaceBefore: number;
  spaceAfter: number;
  /** 孤立行を避ける：段落の1行目だけがページ（段）の最後に、最後の1行だけが次のページに残らないようにする。 */
  keepLines?: boolean;
  /** 次の行と離さない（見出しがページの最後の行に取り残されないようにする）。 */
  keepWithNext?: boolean;
}

export type Block =
  | { kind: "para"; atoms: Atom[]; style?: string; format?: ParaFormat }
  | { kind: "heading"; level: 1 | 2; atoms: Atom[]; style?: string; format?: ParaFormat }
  | { kind: "blank" }
  /** 改ページ。odd なら次の奇数ページから（改丁）。 */
  | { kind: "pagebreak"; odd?: boolean }
  /** 白ページを1枚入れる。 */
  | { kind: "blankpage" }
  /**
   * 1ページにまとめて置く段落（扉・奥付など）。前後で改ページし、行の並びをページの中央（center）か
   * 左端（end：版面の最後の行の側）に寄せる。1ページに収まらなければ、ふつうに流し込む。
   */
  | { kind: "pagegroup"; role: PageRole; place: "center" | "end"; blocks: Block[]; lines?: number[] }
  /** 総ページ数が multiple の倍数になるよう白ページを足す。reserve はこのあとに続くページ数。 */
  | { kind: "pad"; multiple: number; reserve: number }
  /** 目次を入れる場所（組版の前に、見出しから作った段落に置き換える）。 */
  | { kind: "toc" }
  /** ここから使うマスターページ（名前。空なら標準のマスター）。DTP-05。 */
  | { kind: "master"; name: string }
  /** 画像（DTP-12）。 */
  | ImageBlock
  /** 新しいページから始めて流し込み、終わったら改ページする段落のまとまり（目次）。そのページの種類は role。 */
  | { kind: "section"; role: PageRole; blocks: Block[] };

/**
 * 画像の置き方。full：ページ全面（塗り足しまで）。block：版面に収めて1ページ。
 * lines：本文の中に lines 行分の幅で置く。wrap なら、画像の上（天に置くとき）か下に本文を回り込ませる。
 */
export interface ImageBlock {
  kind: "image";
  name: string;
  mode: "full" | "block" | "lines";
  lines: number;
  wrap: boolean;
  /** 行の中での位置：天・中央・地。 */
  position: "top" | "center" | "bottom";
  /** 全面・版面の画像を置くページ：偶数ページか奇数ページか（扉絵を章扉と向かい合わせるときなど）。 */
  parity?: "even" | "odd";
}

/** 画像の大きさ（ピクセル）。縦横の比を決めるのに使う。 */
export interface ImageInfo {
  width: number;
  height: number;
}

/** ページの種類。本文以外（扉・奥付など）には柱とノンブルを付けない（隠しノンブル）。 */
export type PageRole = "body" | "blank" | "tobira" | "title" | "colophon" | "free" | "toc" | "image";

export type Kinsoku = "strong" | "weak" | "none";

export interface LayoutSpec {
  pageWidthMm: number;
  pageHeightMm: number;
  fontSizePt: number;
  charsPerLine: number;
  linesPerPage: number;
  /** 行送り ÷ 文字サイズ（1.67 なら行送りは文字サイズの 167%）。 */
  lineGap: number;
  kinsoku: Kinsoku;
  /** 行末の句読点のぶら下げ。 */
  hanging: boolean;
  rubyScale: number;
  /** 見出しの後に入れる空行の数。 */
  headingBlankAfter: number;
  /** 段数。段は上から下へ並び、1段目を埋めたら2段目へ続く。 */
  columns: number;
  /** 段と段の間（pt）。 */
  columnGapPt: number;
  /**
   * 版面の位置。null ならページの中央。指定があれば天（上の余白）とノド（綴じ側の余白）で決める。
   * 縦書き（右綴じ）の本では、奇数ページは左ページで右側が、偶数ページは右ページで左側がノドになる。
   */
  margins: { topMm: number; gutterMm: number } | null;
  /** 1ページ目のページ番号（ページの左右と奇数・偶数を決める）。 */
  firstPageNumber: number;
  /** 大見出しを奇数ページから始める（改丁）。 */
  chapterStartsOdd: boolean;
  /** 約物の詰めとルビの掛け方。 */
  typography: Typography;
  /** 文書の画像の大きさ（名前で引く）。 */
  images?: Record<string, ImageInfo>;
  /** 横組み（左綴じ）。DTP-01。 */
  horizontal?: boolean;
  /** 禁則に足す字（行頭に置かない字・行末に置かない字）。 */
  kinsokuExtra?: { start: string; end: string };
  /** 画像の回り込みで、画像と本文の間に空ける字数（既定 1）。 */
  wrapGapChars?: number;
  /** 行の中の数式と和文の間（em。既定 0.25）。 */
  mathSpaceEm?: number;
  /** 塗り足し（mm。全面の画像をここまで伸ばす。既定 3）。 */
  bleedMm?: number;
}

/**
 * ページ上に置く1つの文字（または縦中横の1マス）。
 * vert / tcy: x はマスの中心、y はマスの上端。
 * rot: 横倒しの半角文字列。x は行の中心、y は文字列の上端。
 * mark: 圏点などの記号。x, y は字形のインクの中心。
 * horiz: 横書き（付記・ノンブル）。y はベースライン。x は align に応じて左端・中央・右端。
 */
export interface PlacedGlyph {
  text: string;
  /** hcell：横組みの1マス（x はマスの左端、y は行の中心）。hmark：横組みの圏点（x, y はインクの中心）。 */
  kind: "vert" | "tcy" | "rot" | "mark" | "horiz" | "hcell" | "hmark" | "math" | "hmath";
  /** math・hmath：別行数式か。 */
  display?: boolean;
  /** math・hmath：数式の前後の空き（em）。 */
  pad?: number;
  /** hcell で、字の並びを1字分の幅に収める（横組みでの縦中横の数字など）。 */
  fit?: boolean;
  /** 使うフォントの番号（0 は本文の書体）。 */
  font?: number;
  bold?: boolean;
  /** OpenType の字形の機能。 */
  features?: string;
  /** 原稿の位置：[行（0始まり）, 行の中の位置]。 */
  src?: [number, number];
  x: number;
  y: number;
  size: number;
  color?: string;
  align?: "left" | "center" | "right";
}

export type Shape =
  /** color が空なら文字の色。dash があれば破線（線の長さと隙間の長さ）。 */
  | { kind: "line"; x1: number; y1: number; x2: number; y2: number; width: number; color: string; dash?: number[] }
  | { kind: "rect"; x: number; y: number; w: number; h: number; fill?: string; stroke?: { width: number; color: string } }
  | { kind: "circle"; cx: number; cy: number; r: number; fill: string }
  | { kind: "diamond"; cx: number; cy: number; r: number; fill: string }
  /** 塗りの輪郭（数式）。m は d の座標をページの座標に写す行列 [a, b, c, d, e, f]。 */
  | { kind: "path"; d: string; m: [number, number, number, number, number, number]; color: string }
  /** 画像。clip があれば、その範囲だけを見せる（全面の画像を塗り足しの外で切る）。画像がなければ枠だけ描く。 */
  | { kind: "image"; name: string; x: number; y: number; w: number; h: number; clip?: { x: number; y: number; w: number; h: number } };

export interface LineText {
  text: string;
  start: boolean;
  end: boolean;
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PageLayout {
  /** 先頭を 0 とする通し番号。 */
  index: number;
  width: number;
  height: number;
  /** 版面（本文の入る範囲）。 */
  block: Rect;
  /** このページに入った行数（空行を含む）。 */
  lineCount: number;
  role: PageRole;
  /** このページのマスターページの名前（なければ標準のマスター）。 */
  master?: string;
  /** このページで始まる見出し（柱に使う）。 */
  headings: { level: 1 | 2; text: string }[];
  /** このページの行の文字（ルビを除く）。段落の最初の行・最後の行か（校正の補助に使う）。 */
  lines: LineText[];
  glyphs: PlacedGlyph[];
  shapes: Shape[];
  paper: string;
}

/** フォントの字形まで決めた描画命令。画面・PDF・画像はすべてこれを描く。 */
export interface DrawItem {
  /** PDF でどちらの埋め込みフォント（縦書き用字形か通常字形か）を使うか。 */
  font: "vert" | "horiz";
  text: string;
  /** dx は先頭の字形からの送り方向のずれ（フォント単位）。 */
  glyphs: { gid: number; dx: number }[];
  /** 字形の原点（ベースラインの始点）。 */
  x: number;
  y: number;
  size: number;
  /** 横方向の伸縮率（縦中横を1マスに収めるときに 1 未満になる）。 */
  sx: number;
  /** true なら時計回りに 90° 回して描く（横倒しの半角文字）。 */
  rotate?: boolean;
  color: string;
  /** 使うフォントの番号（0 は本文の書体）。 */
  face: number;
  /** 擬似ボールド：塗りに加えて輪郭を太らせて描く。 */
  bold?: boolean;
  /** 原稿の位置：[行（0始まり）, 行の中の位置]。 */
  src?: [number, number];
}

export interface DrawPage {
  index: number;
  width: number;
  height: number;
  paper: string;
  items: DrawItem[];
  shapes: Shape[];
}
