import type { ParagraphDecoration } from "../document/styles.js";
import type { KinsokuCustom } from "./kinsoku.js";
import type { Typography } from "./spacing.js";

// 組版エンジンで共有する型。単位は特に断りがなければ pt（1pt = 1/72 インチ）。
// 色は "#rrggbb" の文字列で持ち、PDF の入稿用では CMYK に変換する。

/** 版面の1マスに入るもの。縦中横なら複数の文字が1マスに入る。 */
export interface Cell {
  text: string;
  /** フォントの字形の候補（OpenType の aalt の番号）。原稿の［＃字形：番号］。 */
  alt?: number;
  tcy?: boolean;
  /** 半角英数字を横倒しで組む。advance はそのときの長さ（em）。 */
  rotate?: boolean;
  /** 行方向の長さ（em）。省略時は 1。 */
  advance?: number;
  /** 欧文の単語を分けてよい位置（横組みのハイフネーション）：at 字目で分けたときの、前半（「-」を含む）と後半の長さ（em）。 */
  hyph?: { at: number; width: number; rest: number }[];
  /** 字形をマスの上端からずらす量（em。負なら上へ）。半角にした始め括弧などで使う。 */
  shift?: number;
  /** 行を合わせるために、さらに詰められる量（em）。約物のアキ。 */
  compress?: number;
  /** 詰めるのがマスの前（上）側か。始め括弧は前にアキがある。 */
  compressFromStart?: boolean;
  /** 行末に来たときに取れる、字形のあとのアキ（em）。終わり括弧・句読点（行末約物半角で使う）。 */
  endAki?: number;
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
  /** 長体・平体：字形の横・縦の伸縮率（字形そのものの向きで。省略時は 1）。 */
  sx?: number;
  sy?: number;
  /** 全角の英数字を、合成フォントの欧文の書体で組む（半角の字を1マスの中央に立てる）。 */
  halfLatin?: boolean;
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
  /** この字のある場所の名前（［＃ラベル：名前］。［＃ページ：名前］でページ番号を引く）。 */
  label?: string;
  /** ページ番号の参照（［＃ページ：名前］）。cells は組むたびに、そのラベルのページ番号にする。 */
  pageRef?: string;
  /** ページごとの注のとき、そのページの終わりに置く注の段落（組むたびに作る）。 */
  noteBlock?: { kind: "para"; atoms: Atom[]; style?: string; format?: ParaFormat };
  /** 注（［＃注：…］）の中身。cells は本文に入れる小さな注番号（「注」と番号。番号は組むたびに入れる）。 */
  note?: Atom[];
  /** 箇条書き・番号付きの項目の印（「・」「（1）」など）。段落の2行目以降は、この幅だけ下げる（ぶら下げ）。 */
  listMark?: boolean;
  /**
   * リンクの飛び先（閲覧用 PDF）。「l:名前」はそのラベルのページ、「h:番号」は原稿の何番目（0始まり）の見出しのページ。
   * ページ番号の参照（pageRef）は、書かなくてもそのラベルへ飛ぶ。
   */
  link?: string;
  /** 索引の語（［＃索引］…［＃／索引］・［＃索引：語（よみ）］）。id は組むたびに付ける、この場所のラベル。 */
  index?: { term: string; reading: string; id?: string }[];
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
  /** 段落の罫線・囲み罫・網掛け（使っているときだけ）。 */
  deco?: ParagraphDecoration;
  /** ドロップキャップ（使っているときだけ）。 */
  dropCap?: { lines: number; chars: number };
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
  /** 索引のページの置き場所（［＃索引ページ］。組む前に索引の段落に置き換える）。 */
  | { kind: "indexpage" }
  /** 行に字のないラベル（［＃ラベル：名前］だけの行）。次の字の入るページを指す。 */
  | { kind: "anchor"; name: string }
  /** ここから使うマスターページ（名前。空なら標準のマスター）。DTP-05。 */
  | { kind: "master"; name: string }
  /** 画像（DTP-12）。 */
  | ImageBlock
  /** 表。 */
  | TableBlock
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
  /** キャプション（段落スタイル「キャプション」で組む）。縦組みでは画像の左、横組みでは画像の下に置く。 */
  caption?: { kind: "para"; atoms: Atom[]; style?: string; format?: ParaFormat };
  /** 切り抜き：元の画像の上下左右を、それぞれの割合（0〜1）だけ切り落とす。 */
  crop?: { top: number; right: number; bottom: number; left: number };
  /** 枠いっぱいに広げ、はみ出た分を切り落とす（版面・行の中）。 */
  fill?: boolean;
  /** 大きさ（枠に収めた大きさに対する割合。0.1〜1）。 */
  scale?: number;
  /** 位置の微調整（mm。仕上がりのページで右・下が正）。 */
  shift?: { x: number; y: number };
}

/** 表の行。cells は欄ごとの段落（段落スタイル「表」か「表の見出し」）。line は原稿の行。 */
export interface TableRow {
  cells: { kind: "para"; atoms: Atom[]; style?: string; format?: ParaFormat }[];
  line?: number;
}

/**
 * 表。縦組みでは表の行が縦の行（右から左へ並ぶ）、欄がその中の区切り（上から下へ）になり、
 * 横組みではふつうの表（行が上から下、欄が左から右）になる。
 */
export interface TableBlock {
  kind: "table";
  rows: TableRow[];
  /** 見出しの行の数（区切りの行「|---|」より前の行）。 */
  header: number;
  /** 欄ごとの揃え（区切りの行の「:---」「:---:」「---:」）。ない欄は天（左）揃え。 */
  align?: ("start" | "center" | "end")[];
  /** 罫線：すべて（既定）・行の境目だけ・なし。 */
  rules?: "all" | "rows" | "none";
  /** 見出しの行のあとの罫線を二重線にする。 */
  headerDouble?: boolean;
}

/** 画像の大きさ（ピクセル）。縦横の比を決めるのに使う。 */
export interface ImageInfo {
  width: number;
  height: number;
}

/** ページの種類。本文以外（扉・奥付など）には柱とノンブルを付けない（隠しノンブル）。 */
export type PageRole = "body" | "blank" | "tobira" | "title" | "colophon" | "free" | "toc" | "index" | "image";

/** 禁則の強さ。custom は、行頭禁則・行末禁則・ぶら下げ・分離禁止の字を自分で決める（kinsokuCustom）。 */
export type Kinsoku = "strong" | "weak" | "none" | "custom";

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
  /** 自分で決めた禁則（kinsoku が custom のとき）。 */
  kinsokuCustom?: KinsokuCustom;
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
  /** 長体・平体（字形の横・縦の伸縮率）。 */
  sx?: number;
  sy?: number;
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
  /** リンクの範囲（描かない。閲覧用 PDF でクリックできる所。target は Atom.link と同じ書き方）。 */
  | { kind: "link"; x: number; y: number; w: number; h: number; target: string }
  /** 塗りの輪郭（数式）。m は d の座標をページの座標に写す行列 [a, b, c, d, e, f]。 */
  | { kind: "path"; d: string; m: [number, number, number, number, number, number]; color: string }
  /** 画像。clip があれば、その範囲だけを見せる（全面の画像を塗り足しの外で切る）。画像がなければ枠だけ描く。 */
  | {
      kind: "image";
      name: string;
      x: number;
      y: number;
      w: number;
      h: number;
      clip?: { x: number; y: number; w: number; h: number };
      /** 透明な部分の下の色（#rrggbb。なければ白の紙）。入稿用 PDF で透明をなくすときに重ねる。 */
      matte?: string;
    };

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
  /** このページにあるラベル（［＃ラベル：名前］）。 */
  labels?: string[];
  /** このページで始まる見出し（柱に使う）。 */
  headings: { level: 1 | 2; text: string }[];
  /** このページの行の文字（ルビを除く）。段落の最初の行・最後の行か（校正の補助に使う）。 */
  lines: LineText[];
  /** ページで最初の字の原稿の位置（行・行の中の位置）。字がなければ undefined。 */
  firstSrc?: [number, number];
  /** 字と図形の位置。layoutDocument が作るページでは、初めて読んだときに計算する。 */
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
  /** 横方向の伸縮率（縦中横を1マスに収めるとき・長体で 1 未満になる）。 */
  sx: number;
  /** 縦方向の伸縮率（平体で 1 未満になる。省略時は 1）。 */
  sy?: number;
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
  /** このページにあるラベル（リンクの飛び先を探すのに使う）。 */
  labels?: string[];
  /** このページで始まる見出し（PDF のしおりに使う）。 */
  headings?: { level: 1 | 2; text: string }[];
  items: DrawItem[];
  shapes: Shape[];
}
