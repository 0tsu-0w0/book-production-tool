import { PageStructureEditor } from "./page-structure-editor.js";
import { StyleEditor } from "./style-editor.js";
import {
  CUSTOM_PRESET,
  DEFAULT_SETTINGS,
  FREE_TRIM,
  TRIM_SIZES,
  bookGeometry,
  FONT_SIZES_PT,
  LINE_GAPS_PERCENT,
  PAPER_COLORS,
  PRESETS,
  RECOMMENDED_FORMAT,
  TEXT_COLORS,
  customGrid,
  CUSTOM_PAPER,
  TOC_LEADERS,
  PAPERS,
  paperThickness,
  spineWidthMm,
  type FontChoice,
  type Settings,
} from "../document/settings.js";

// 右側の設定欄。項目の一覧（SECTIONS）から入力部品を作り、変更を Settings に書き戻す。

export interface FontOption extends FontChoice {
  cff: boolean;
}

type Path = string;
type Opt = [value: string, label: string];

type Field =
  | { kind: "select"; path: Path; label: string; options: Opt[] | (() => Opt[]); numeric?: boolean; when?: (s: Settings) => boolean }
  | { kind: "check"; path: Path; label: string; when?: (s: Settings) => boolean }
  | { kind: "number"; path: Path; label: string; min: number; max: number; step: number; unit?: string; when?: (s: Settings) => boolean }
  | { kind: "text"; path: Path; label: string; placeholder?: string; multiline?: boolean; when?: (s: Settings) => boolean }
  | { kind: "color"; path: Path; label: string; palette: [string, string][] }
  | { kind: "font" }
  | { kind: "styles" }
  | { kind: "pages" }
  | { kind: "custom"; id: string }
  | { kind: "info"; render: (s: Settings) => string | null; tone?: "warning"; when?: (s: Settings) => boolean }
  | { kind: "button"; label: string; action: string };

interface Section {
  title: string;
  open?: boolean;
  fields: Field[];
}

const DECORATIONS: Opt[] = [
  ["none", "使用しない"],
  ["double-line", "二本線"],
  ["top-bottom-line", "上下線"],
  ["gradient", "上下グラデ"],
  ["dots", "・・"],
  ["circle-m", "●●（中）"],
  ["diamond-m", "◆◆（中）"],
  ["square-m", "■■（中）"],
  ["circle-l", "●●（大）"],
  ["diamond-l", "◆◆（大）"],
  ["square-l", "■■（大）"],
];

const DPI_OPTIONS: Opt[] = [
  ["152.4", "Web公開用（630×888px）"],
  ["300", "印刷用 300dpi"],
  ["350", "印刷用 350dpi"],
  ["600", "印刷用 600dpi"],
];

const HEAD_SOURCES: Opt[] = [
  ["none", "なし"],
  ["book-title", "書名"],
  ["chapter", "章題（大見出し）"],
  ["section", "節題（中見出し。なければ章題）"],
];

/** 今の総ページ数（背幅の表示に使う。組版のたびに画面から知らされる）。 */
let pageCount = 0;

const isSimple = (s: Settings) => s.layoutMode === "simple";
const isBook = (s: Settings) => s.layoutMode === "book";
const isCustom = (s: Settings) => isSimple(s) && s.preset === CUSTOM_PRESET;

/** 版面の大きさと四方の余白の表示。余白が足りなければ警告にする。 */
function bookInfo(s: Settings): string {
  const g = bookGeometry(s.book);
  const mm = (v: number) => `${v.toFixed(1)}mm`;
  return `版面 ${mm(g.blockWidthMm)}×${mm(g.blockHeightMm)}　天 ${mm(g.top)}・地 ${mm(g.bottom)}・ノド ${mm(g.gutter)}・小口 ${mm(g.foreEdge)}`;
}

function bookWarning(s: Settings): string | null {
  if (!isBook(s)) return null;
  const g = bookGeometry(s.book);
  const tight = Object.entries({ 天: g.top, 地: g.bottom, ノド: g.gutter, 小口: g.foreEdge }).filter(([, v]) => v < 5);
  if (tight.length === 0) return null;
  const over = tight.filter(([, v]) => v < 0).map(([k]) => k);
  if (over.length > 0) return `版面がページからはみ出しています（${over.join("・")}）。字数・行数・余白を見直してください。`;
  return `余白が 5mm 未満です（${tight.map(([k]) => k).join("・")}）。断裁で文字が切れるおそれがあります。`;
}

function sections(): Section[] {
  return [
    {
      title: "字組",
      open: true,
      fields: [
        {
          kind: "select",
          path: "layoutMode",
          label: "組み方",
          options: [
            ["simple", "かんたん（文庫・参照元と同じ字組）"],
            ["book", "詳しく（判型と版面を決める）"],
          ],
        },
        { kind: "select", path: "preset", label: "本文の字組", options: [...Object.keys(PRESETS), CUSTOM_PRESET].map((p) => [p, p]), when: isSimple },
        { kind: "select", path: "book.trim", label: "判型", options: [...Object.entries(TRIM_SIZES).map(([k, [w, h]]): Opt => [k, `${k}（${w}×${h}mm）`]), [FREE_TRIM, "自由に決める"]], when: isBook },
        {
          kind: "select",
          path: "book.writingMode",
          label: "組み方向",
          options: [
            ["vertical", "縦組み（右綴じ）"],
            ["horizontal", "横組み（左綴じ）"],
          ],
          when: isBook,
        },
        { kind: "number", path: "book.widthMm", label: "仕上がりの幅", min: 50, max: 400, step: 1, unit: "mm", when: (s) => isBook(s) && s.book.trim === FREE_TRIM },
        { kind: "number", path: "book.heightMm", label: "仕上がりの高さ", min: 50, max: 400, step: 1, unit: "mm", when: (s) => isBook(s) && s.book.trim === FREE_TRIM },
        { kind: "number", path: "book.fontSizePt", label: "文字サイズ", min: 6, max: 24, step: 0.25, unit: "pt", when: isBook },
        { kind: "number", path: "book.charsPerLine", label: "字数（1段）", min: 5, max: 80, step: 1, unit: "字", when: isBook },
        { kind: "number", path: "book.linesPerPage", label: "行数（1段）", min: 1, max: 60, step: 1, unit: "行", when: isBook },
        { kind: "number", path: "book.lineGapPercent", label: "行送り", min: 110, max: 300, step: 1, unit: "%", when: isBook },
        { kind: "select", path: "book.columns", label: "段数", numeric: true, options: [["1", "1段"], ["2", "2段"], ["3", "3段"], ["4", "4段"]], when: isBook },
        { kind: "number", path: "book.columnGapChars", label: "段間", min: 0.5, max: 10, step: 0.5, unit: "字", when: (s) => isBook(s) && s.book.columns > 1 },
        { kind: "select", path: "book.position", label: "版面の位置", options: [["top-gutter", "天とノドの余白で決める"], ["center", "ページの中央"]], when: isBook },
        { kind: "number", path: "book.topMm", label: "天（上の余白）", min: 0, max: 100, step: 0.5, unit: "mm", when: (s) => isBook(s) && s.book.position === "top-gutter" },
        { kind: "number", path: "book.gutterMm", label: "ノド（綴じ側の余白）", min: 0, max: 100, step: 0.5, unit: "mm", when: (s) => isBook(s) && s.book.position === "top-gutter" },
        { kind: "info", when: isBook, render: bookInfo },
        { kind: "info", tone: "warning", render: bookWarning },
        { kind: "check", path: "chapterStartsOdd", label: "大見出し（＃）を奇数ページから始める（改丁）" },
        { kind: "number", path: "custom.marginXMm", label: "左右の余白", min: 3, max: 30, step: 0.5, unit: "mm", when: isCustom },
        { kind: "number", path: "custom.marginYMm", label: "上下の余白", min: 3, max: 40, step: 0.5, unit: "mm", when: isCustom },
        { kind: "select", path: "custom.fontSizePt", label: "文字サイズ", numeric: true, options: FONT_SIZES_PT.map((v) => [String(v), `${v}pt`]), when: isCustom },
        { kind: "select", path: "custom.lineGapPercent", label: "行間", numeric: true, options: LINE_GAPS_PERCENT.map((v) => [String(v), `${v}%`]), when: isCustom },
        {
          kind: "info",
          when: isCustom,
          render: (s) => {
            const g = customGrid(s.custom);
            return `${g.charsPerLine}字×${g.linesPerPage}行＝${g.charsPerLine * g.linesPerPage}字／ページ`;
          },
        },
        { kind: "select", path: "kinsoku", label: "行頭禁則", options: [["strong", "強い（小書きの仮名を含む）"], ["weak", "弱い"], ["none", "なし"]] },
        { kind: "check", path: "hanging", label: "行末の句読点をぶら下げる" },
        { kind: "select", path: "headingBlankAfter", label: "見出しの後の空行", numeric: true, options: [["0", "なし"], ["1", "1行"], ["2", "2行"]] },
      ],
    },
    {
      title: "約物とルビ",
      fields: [
        {
          kind: "select",
          path: "typography.mode",
          label: "約物の組み方",
          options: [
            ["grid", "ベタ組み（すべて全角。参照元と同じ）"],
            ["jis", "JIS 準拠（約物の詰め・両端揃え）"],
          ],
        },
        {
          kind: "info",
          when: (s) => s.typography.mode === "jis",
          render: () => "続く約物（」「・。」など）の間を半角にし、禁則で短くなった行は字間を広げて行末をそろえます。ルビが親文字より長いときは、前後の仮名に掛けるか親文字の字間を空けます。",
        },
        {
          kind: "select",
          path: "typography.lineHeadBracket",
          label: "行頭の始め括弧（段落の途中の行）",
          options: [["full", "全角"], ["half", "半角（天付き）"]],
          when: (s) => s.typography.mode === "jis",
        },
        { kind: "check", path: "typography.oikomi", label: "行頭禁則は、まず約物を詰めて前の行に入れる（追い込み）", when: (s) => s.typography.mode === "jis" },
        { kind: "check", path: "typography.rubyOverhang", label: "長いルビを前後の仮名に掛ける", when: (s) => s.typography.mode === "jis" },
      ],
    },
    {
      title: "自動整形",
      fields: [
        {
          kind: "select",
          path: "format.markup",
          label: "原稿の記法",
          options: [
            ["standard", "tategumi の記法（｜漢字《かんじ》・＃見出し など）"],
            ["tex", "TeX の記法（\\ruby・\\section・$数式$ など）"],
          ],
        },
        {
          kind: "info",
          when: (s) => s.format.markup === "tex",
          render: () => "空行で段落を区切ります（続く行は1つの段落）。% から行末はコメント。知らない命令は中身だけを残します。",
        },
        { kind: "button", label: "おまかせ整形を適用", action: "recommended-format" },
        { kind: "check", path: "format.symbols", label: "符号を変換する（ーー→――、...→……）" },
        { kind: "check", path: "format.indent", label: "段落の頭を字下げする" },
        { kind: "check", path: "format.dialogueBlankLines", label: "会話文の前後の空行を削除する" },
        { kind: "check", path: "format.spaceAfterMarks", label: "文中の！？の後に全角空白を入れる" },
        { kind: "check", path: "format.limitMarks", label: "3つ以上続く！？を2つにする" },
        { kind: "check", path: "format.tcyDigits", label: "2〜3桁の半角数字を縦中横にする" },
        { kind: "check", path: "format.digitsFullWidth", label: "半角数字を全角にする" },
        { kind: "check", path: "format.kanjiNumerals", label: "数字を漢数字にする" },
        { kind: "select", path: "format.halfWidth", label: "半角英字", options: [["fullwidth", "全角にして立てる"], ["rotate", "半角のまま横倒しにする"]] },
        { kind: "check", path: "format.pageBreakMark", label: "＝＝＝ の行で改ページする" },
        { kind: "button", label: "整形で変わる行を見る", action: "show-diff" },
      ],
    },
    {
      title: "付記とノンブル",
      fields: [
        { kind: "info", when: isBook, render: () => "詳しい組み方では、「柱とマスターページ」で柱とノンブルを決めます。" },
        { kind: "text", path: "note1", label: "付記1", placeholder: "作品名など", when: isSimple },
        { kind: "text", path: "note2", label: "付記2（付記1の対角に置く）", placeholder: "作者名など", when: isSimple },
        { kind: "check", path: "note2Faint", label: "付記2を薄くする", when: isSimple },
        { kind: "check", path: "nombre", label: "ページ番号（ノンブル）を付ける", when: isSimple },
        { kind: "number", path: "nombreStart", label: "開始番号", min: 1, max: 9999, step: 1 },
        {
          kind: "select",
          path: "placement",
          label: "配置",
          when: isSimple,
          options: [
            ["note-tl.nombre-bl", "付記1：左上　番号：左下"],
            ["note-tl.nombre-bc", "付記1：左上　番号：下中央"],
            ["note-bl.nombre-tl", "付記1：左下　番号：左上"],
            ["both-tl", "どちらも左上"],
            ["both-bl", "どちらも左下"],
          ],
        },
        { kind: "check", path: "spread", label: "見開き用に配置する（偶数ページは左右反転、付記なし）", when: isSimple },
        { kind: "check", path: "border", label: "枠線を付ける" },
        { kind: "check", path: "blankPageNombre", label: "白ページにもノンブルを付ける" },
      ],
    },
    {
      title: "柱とマスターページ",
      fields: [
        { kind: "info", when: isSimple, render: () => "「字組」で「詳しく」を選ぶと使えます。" },
        { kind: "text", path: "master.bookTitle", label: "書名（柱に使う。空なら書誌の書名）", placeholder: "本の題名", when: isBook },
        {
          kind: "select",
          path: "master.headPosition",
          label: "柱の位置",
          when: isBook,
          options: [
            ["top-outer", "上の余白・小口側"],
            ["top-center", "上の余白・中央"],
            ["fore-edge", "小口の余白に縦書き"],
          ],
        },
        {
          kind: "select",
          path: "master.nombrePosition",
          label: "ノンブルの位置",
          when: isBook,
          options: [
            ["bottom-outer", "下の余白・小口側"],
            ["bottom-center", "下の余白・中央"],
            ["top-outer", "上の余白・小口側"],
          ],
        },
        { kind: "number", path: "master.sizePt", label: "柱・ノンブルの文字サイズ", min: 5, max: 14, step: 0.5, unit: "pt", when: isBook },
        { kind: "number", path: "master.gapMm", label: "版面からの距離", min: 1, max: 20, step: 0.5, unit: "mm", when: isBook },
        { kind: "info", when: isBook, render: () => "本文ページ" },
        { kind: "select", path: "master.bodyOdd", label: "奇数ページ（左）の柱", options: HEAD_SOURCES, when: isBook },
        { kind: "select", path: "master.bodyEven", label: "偶数ページ（右）の柱", options: HEAD_SOURCES, when: isBook },
        { kind: "check", path: "master.bodyNombre", label: "ノンブルを付ける", when: isBook },
        { kind: "info", when: isBook, render: () => "章の始まりのページ（大見出しのあるページ）" },
        { kind: "select", path: "master.openingOdd", label: "奇数ページ（左）の柱", options: HEAD_SOURCES, when: isBook },
        { kind: "select", path: "master.openingEven", label: "偶数ページ（右）の柱", options: HEAD_SOURCES, when: isBook },
        { kind: "check", path: "master.openingNombre", label: "ノンブルを付ける", when: isBook },
      ],
    },
    {
      title: "書誌とページ構成",
      fields: [
        { kind: "text", path: "bookInfo.title", label: "書名", placeholder: "本の題名" },
        { kind: "text", path: "bookInfo.author", label: "著者名" },
        { kind: "text", path: "bookInfo.publisher", label: "発行（奥付）", placeholder: "発行者・サークル名" },
        { kind: "text", path: "bookInfo.printer", label: "印刷（奥付）", placeholder: "印刷所" },
        { kind: "text", path: "bookInfo.issued", label: "発行日と版（奥付）", placeholder: "2026年10月1日　初版発行", multiline: true },
        { kind: "text", path: "bookInfo.extra", label: "そのほか奥付に載せること", multiline: true },
        { kind: "pages" },
        { kind: "text", path: "toc.title", label: "目次の題（空なら出さない）", placeholder: "目次" },
        { kind: "select", path: "toc.levels", label: "目次に載せる見出し", numeric: true, options: [["1", "大見出し（＃）だけ"], ["2", "中見出し（＃＃）まで"]] },
        { kind: "select", path: "toc.numerals", label: "目次のページ番号", options: [["arabic", "算用数字（2〜3桁は縦中横）"], ["kanji", "漢数字"]] },
        { kind: "select", path: "toc.leader", label: "目次のリーダー", options: TOC_LEADERS },
        {
          kind: "select",
          path: "pages.padTo",
          label: "総ページ数をそろえる",
          numeric: true,
          options: [["1", "そろえない"], ["2", "2の倍数"], ["4", "4の倍数"], ["8", "8の倍数"], ["16", "16の倍数"]],
        },
        { kind: "info", render: () => "足りない分は、本文と後ろのページの間に白ページを入れます。扉・奥付などのページには柱とノンブルを付けません（ページ番号は数えます）。" },
      ],
    },
    {
      title: "色と飾り",
      fields: [
        { kind: "color", path: "paperColor", label: "紙の色", palette: PAPER_COLORS },
        { kind: "color", path: "textColor", label: "文字の色", palette: TEXT_COLORS },
        { kind: "info", tone: "warning", render: (s) => contrastWarning(s) },
        {
          kind: "info",
          when: (s) => s.paperColor.toLowerCase() !== "#ffffff" && s.pdfKind !== "screen",
          render: () => "入稿用 PDF では紙の色は刷りません（紙そのものの色として扱います）。",
        },
        { kind: "select", path: "decoration", label: "上下の飾り", options: DECORATIONS },
        { kind: "color", path: "decoColor1", label: "飾りの色1", palette: TEXT_COLORS },
        { kind: "color", path: "decoColor2", label: "飾りの色2", palette: TEXT_COLORS },
      ],
    },
    {
      title: "書体",
      fields: [{ kind: "font" }],
    },
    {
      title: "スタイル",
      fields: [{ kind: "styles" }],
    },
    {
      title: "画像",
      fields: [{ kind: "custom", id: "images" }],
    },
    {
      title: "書き出し",
      fields: [
        {
          kind: "select",
          path: "pdfKind",
          label: "PDFの種類",
          options: [
            ["print", "入稿用（PDF/X-1a・CMYK・トンボ付き）"],
            ["print-nomarks", "入稿用（PDF/X-1a・CMYK・トンボなし）"],
            ["screen", "閲覧用（RGB）"],
          ],
        },
        { kind: "select", path: "output.color", label: "色", options: [["auto", "自動（入稿用は CMYK、閲覧用・画像は RGB）"], ["gray", "グレースケール（モノクロ印刷用）"]] },
        { kind: "select", path: "output.imposition", label: "面付け", options: [["single", "単ページ"], ["spread", "見開き（閲覧用 PDF と画像）"]] },
        {
          kind: "info",
          tone: "warning",
          render: (s) => (s.output.imposition === "spread" && s.pdfKind !== "screen" ? "入稿用 PDF は単ページで書き出します。見開きになるのは閲覧用 PDF と画像です。" : null),
        },
        { kind: "select", path: "image.format", label: "画像の形式", options: [["png", "PNG"], ["jpeg", "JPEG"]] },
        { kind: "select", path: "image.dpi", label: "画像の解像度", numeric: true, options: DPI_OPTIONS },
        { kind: "number", path: "image.jpegQuality", label: "JPEGの品質", min: 0.5, max: 1, step: 0.01, when: (s) => s.image.format === "jpeg" },
        { kind: "check", path: "output.zipImages", label: "画像を1つの ZIP にまとめる" },
        { kind: "select", path: "output.paper", label: "本文用紙（背幅の計算）", options: [...Object.keys(PAPERS).map((k): Opt => [k, `${k}（1枚 ${PAPERS[k]}mm）`]), [CUSTOM_PAPER, CUSTOM_PAPER]] },
        { kind: "number", path: "output.paperThicknessMm", label: "紙1枚の厚さ", min: 0.03, max: 0.5, step: 0.005, unit: "mm", when: (s) => s.output.paper === CUSTOM_PAPER },
        {
          kind: "info",
          render: (s) =>
            pageCount > 0
              ? `背幅 約 ${spineWidthMm(pageCount, s.output).toFixed(1)}mm（${pageCount}ページ＝${Math.ceil(pageCount / 2)}枚 × ${paperThickness(s.output)}mm。表紙の厚さは含みません。紙の厚さは目安なので、入稿前に印刷所の計算で確かめてください）`
              : null,
        },
      ],
    },
    {
      title: "詳細設定",
      fields: [
        { kind: "info", render: () => "ふだんは既定のままで構いません。値を変えると、すぐに組み直します。" },
        { kind: "number", path: "advanced.rubyPercent", label: "ルビ・圏点の大きさ", min: 30, max: 80, step: 1, unit: "%" },
        { kind: "number", path: "advanced.tcyMaxDigits", label: "自動で縦中横にする桁数（上限）", min: 2, max: 4, step: 1, unit: "桁" },
        { kind: "text", path: "advanced.kinsokuStartExtra", label: "行頭に置かない字を足す", placeholder: "例：＊※" },
        { kind: "text", path: "advanced.kinsokuEndExtra", label: "行末に置かない字を足す", placeholder: "例：＄＃" },
        { kind: "number", path: "advanced.mathSpaceEm", label: "数式と和文の間", min: 0, max: 1, step: 0.05, unit: "字" },
        { kind: "number", path: "advanced.wrapGapChars", label: "画像の回り込みの間隔", min: 0, max: 5, step: 1, unit: "字" },
        { kind: "number", path: "advanced.noteScalePercent", label: "付記・ノンブルの大きさ（かんたん）", min: 50, max: 150, step: 5, unit: "%" },
        { kind: "number", path: "advanced.bleedMm", label: "塗り足し（入稿用 PDF）", min: 0, max: 10, step: 0.5, unit: "mm" },
        { kind: "number", path: "advanced.imagePpi", label: "PDF の画像の解像度（これを大きく超えたら縮める）", min: 150, max: 1200, step: 50, unit: "ppi" },
        { kind: "number", path: "advanced.safeMarginMm", label: "検査：仕上がり線から文字を離す距離", min: 0, max: 10, step: 0.5, unit: "mm" },
        { kind: "button", label: "詳細設定を既定に戻す", action: "reset-advanced" },
      ],
    },
    {
      title: "テンプレート",
      fields: [
        {
          kind: "info",
          render: () =>
            `今の設定（字組・スタイル・柱・ページ構成・詳細設定・書き出しなど、原稿と書名・著者名以外のすべて）を、自分のテンプレートとして保存できます。新規作成の既定：${defaultTemplateName || "標準の設定"}`,
        },
        { kind: "button", label: "今の設定をテンプレートとして保存…", action: "save-template" },
        { kind: "button", label: "テンプレートの一覧（適用・既定にする・削除）…", action: "open-templates" },
      ],
    },
  ];
}

/** 新規作成で使うテンプレートの名前（空なら標準の設定）。画面から知らされる。 */
let defaultTemplateName = "";

/** WCAG のコントラスト比が 4.5 未満なら警告を出す。 */
function contrastWarning(s: Settings): string | null {
  const ratio = contrastRatio(s.textColor, s.paperColor);
  return ratio < 4.5 ? `文字と紙の色のコントラストが低く、読みにくくなります（${ratio.toFixed(1)}：1。4.5：1 以上が目安）。` : null;
}

export function contrastRatio(a: string, b: string): number {
  const lum = (hex: string) => {
    const n = parseInt(hex.slice(1), 16);
    const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  };
  const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

function getPath(obj: unknown, path: Path): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], obj);
}

function setPath(obj: unknown, path: Path, value: unknown): void {
  const keys = path.split(".");
  const last = keys.pop()!;
  const target = keys.reduce<Record<string, unknown>>((o, k) => o[k] as Record<string, unknown>, obj as Record<string, unknown>);
  target[last] = value;
}

export class SettingsPanel {
  private settings!: Settings;
  private fonts: FontOption[] = [];
  private defaultFontName = "";
  private readonly refreshers: (() => void)[] = [];
  /** 設定欄の外で中身を持つ部品（画像の一覧など）。 */
  readonly custom = new Map<string, () => HTMLElement>();

  constructor(
    private readonly root: HTMLElement,
    private readonly onChange: (s: Settings) => void,
    private readonly onAction: (action: string) => void,
  ) {}

  setDefaultTemplateName(name: string) {
    defaultTemplateName = name;
    this.refresh();
  }

  setPageCount(n: number) {
    if (n === pageCount) return;
    pageCount = n;
    this.refresh();
  }

  setFonts(fonts: FontOption[], defaultFontName: string) {
    this.fonts = fonts;
    this.defaultFontName = defaultFontName;
    if (this.settings) this.render(this.settings);
  }

  render(settings: Settings) {
    this.settings = settings;
    const openState = new Map([...this.root.querySelectorAll("details")].map((d) => [d.dataset.title!, d.open]));
    this.root.replaceChildren();
    this.refreshers.length = 0;
    for (const section of sections()) {
      const details = document.createElement("details");
      details.dataset.title = section.title;
      details.open = openState.get(section.title) ?? !!section.open;
      const summary = document.createElement("summary");
      summary.textContent = section.title;
      const box = document.createElement("div");
      box.className = "fields";
      for (const field of section.fields) box.append(this.buildField(field));
      details.append(summary, box);
      this.root.append(details);
    }
    this.refresh();
  }

  /** 表示条件（when）と計算表示を、今の設定に合わせて更新する。 */
  private refresh() {
    for (const r of this.refreshers) r();
  }

  private changed(path: Path, value: unknown) {
    setPath(this.settings, path, value);
    this.refresh();
    this.onChange(this.settings);
  }

  private buildField(field: Field): HTMLElement {
    const wrap = document.createElement("label");
    wrap.className = "field";
    const title = (text: string) => {
      const span = document.createElement("span");
      span.textContent = text;
      return span;
    };
    const when = "when" in field ? field.when : undefined;
    if (when) this.refreshers.push(() => (wrap.hidden = !when(this.settings)));

    switch (field.kind) {
      case "select": {
        const select = document.createElement("select");
        const options = typeof field.options === "function" ? field.options() : field.options;
        for (const [value, label] of options) select.add(new Option(label, value));
        select.value = String(getPath(this.settings, field.path));
        select.addEventListener("change", () => this.changed(field.path, field.numeric ? Number(select.value) : select.value));
        wrap.append(title(field.label), select);
        return wrap;
      }
      case "check": {
        wrap.className = "field check";
        const input = document.createElement("input");
        input.type = "checkbox";
        input.checked = !!getPath(this.settings, field.path);
        input.addEventListener("change", () => this.changed(field.path, input.checked));
        wrap.append(input, document.createTextNode(field.label));
        return wrap;
      }
      case "number": {
        wrap.className = "field inline";
        const input = document.createElement("input");
        input.type = "number";
        Object.assign(input, { min: String(field.min), max: String(field.max), step: String(field.step) });
        input.value = String(getPath(this.settings, field.path));
        input.addEventListener("change", () => {
          const v = Math.min(field.max, Math.max(field.min, Number(input.value) || field.min));
          input.value = String(v);
          this.changed(field.path, v);
        });
        const row = document.createElement("span");
        row.className = "row";
        row.append(input, document.createTextNode(field.unit ?? ""));
        wrap.append(title(field.label), row);
        return wrap;
      }
      case "text": {
        const input: HTMLInputElement | HTMLTextAreaElement = field.multiline ? document.createElement("textarea") : document.createElement("input");
        if (input instanceof HTMLInputElement) input.type = "text";
        else input.rows = 2;
        input.placeholder = field.placeholder ?? "";
        input.value = String(getPath(this.settings, field.path) ?? "");
        input.addEventListener("input", () => this.changed(field.path, input.value));
        wrap.append(title(field.label), input);
        return wrap;
      }
      case "color":
        return this.buildColor(field.path, field.label, field.palette, title);
      case "styles":
        return this.buildStyles();
      case "custom":
        return this.custom.get(field.id)?.() ?? document.createElement("div");
      case "pages":
        return new PageStructureEditor(this.settings.pages, () => this.onChange(this.settings)).element;
      case "font":
        return this.buildFont(title);
      case "info": {
        const div = document.createElement("div");
        div.className = field.tone === "warning" ? "warning" : "computed";
        this.refreshers.push(() => {
          const text = field.when && !field.when(this.settings) ? null : field.render(this.settings);
          div.hidden = !text;
          div.textContent = text ?? "";
        });
        return div;
      }
      case "button": {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = field.label;
        button.addEventListener("click", () => {
          if (field.action === "reset-advanced") {
            this.settings.advanced = structuredClone(DEFAULT_SETTINGS.advanced);
            this.render(this.settings);
            this.onChange(this.settings);
          } else if (field.action === "recommended-format") {
            Object.assign(this.settings.format, RECOMMENDED_FORMAT);
            this.render(this.settings);
            this.onChange(this.settings);
          } else {
            this.onAction(field.action);
          }
        });
        return button;
      }
    }
  }

  private buildColor(path: Path, label: string, palette: [string, string][], title: (t: string) => HTMLElement): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "field";
    const swatches = document.createElement("div");
    swatches.className = "swatches";
    const current = () => String(getPath(this.settings, path)).toLowerCase();
    const buttons = palette.map(([name, hex]) => {
      const b = document.createElement("button");
      b.type = "button";
      b.title = name;
      b.setAttribute("aria-label", name);
      b.style.background = hex;
      b.addEventListener("click", () => {
        picker.value = hex;
        this.changed(path, hex);
      });
      return b;
    });
    const picker = document.createElement("input");
    picker.type = "color";
    picker.title = "色を指定";
    picker.value = current();
    picker.addEventListener("input", () => this.changed(path, picker.value));
    this.refreshers.push(() => {
      for (const [i, b] of buttons.entries()) b.setAttribute("aria-pressed", String(palette[i][1] === current()));
    });
    swatches.append(...buttons, picker);
    wrap.append(title(label), swatches);
    return wrap;
  }

  private buildStyles(): HTMLElement {
    const box = document.createElement("div");
    box.className = "fields";
    box.style.padding = "0";
    const editor = new StyleEditor(
      box,
      () => this.settings.styles,
      () => this.fonts.map((f) => ({ name: f.name, choice: { name: f.name, postscriptName: f.postscriptName, path: f.path, index: f.index } })),
      () => this.onChange(this.settings),
    );
    editor.render();
    return box;
  }

  private buildFont(title: (t: string) => HTMLElement): HTMLElement {
    const wrap = document.createElement("label");
    wrap.className = "field";
    const select = document.createElement("select");
    select.add(new Option(`既定（${this.defaultFontName || "読み込み中"}）`, ""));
    for (const f of this.fonts) {
      select.add(new Option(f.name, `${f.path}#${f.index}`));
    }
    const cur = this.settings.font;
    select.value = cur ? `${cur.path}#${cur.index}` : "";
    if (cur && select.value === "") {
      // 一覧にないフォント（別の PC で作った文書）。選択肢に残して、見つからないことを示す。
      select.add(new Option(`${cur.name}（見つかりません）`, `${cur.path}#${cur.index}`));
      select.value = `${cur.path}#${cur.index}`;
    }
    select.addEventListener("change", () => {
      const f = this.fonts.find((x) => `${x.path}#${x.index}` === select.value);
      this.changed("font", f ? { name: f.name, postscriptName: f.postscriptName, path: f.path, index: f.index } : null);
    });
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = "PC に入っている、縦書き用の字形を持つ日本語フォントを表示しています。";
    wrap.append(title("本文の書体"), select, hint);
    return wrap;
  }
}
