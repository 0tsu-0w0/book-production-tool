import { horizontalPunctuation, leftBound, spotInks, toFormatOptions, toLayoutSpec, toParseOptions, type FontChoice, type Settings, type SpotColor } from "../document/settings.js";
import { INDEX_ENTRY_STYLE, NOTE_STYLE, TOC_ENTRY_STYLES, TOC_TITLE_STYLE, hasDecoration, type CharacterStyle, type GlyphForm, type ParagraphRule, type ParagraphStyle, type RuleKind } from "../document/styles.js";
import { storyFingerprint, type KolophonHint } from "../document/idml-import.js";
import { escapeXml, findAll, parseXml } from "../document/xml.js";
import { bookPageBlocks } from "../engine/book-pages.js";
import { formatText } from "../engine/format.js";
import { hexToCmyk } from "../engine/ink-color.js";
import { KENTEN_MARKS, parse } from "../engine/parse.js";
import { texToMarkup } from "../engine/tex.js";
import type { Atom, Block, NombrePlace, PageMark, TableBlock } from "../engine/types.js";
import type { DocImage } from "../document/document.js";
import { linkBaseName } from "../document/image-link.js";
import { expandXrefs } from "../engine/xref.js";

// IDML（InDesign Markup Language）の書き出し。InDesign の受け渡し用の形式で、InDesign で開くと文書になる。
// 入れるもの：判型・綴じ方向・組み方向、ページと版面（テキストフレームを1ページに1つ、つないで流す）、
// 段落スタイル・文字スタイル（大きさ・行送り・字下げ・揃え・前後の空き・色・字間・長体平体・字形・
// ドロップキャップ・先頭文字スタイル・正規表現スタイル・行スタイル）、色（CMYK・特色・特色の濃さ）、
// 本文（ルビ・圏点・傍線・縦中横・割注・字間・カーニング・改ページ・改丁）、注（章末か巻末の段落）、
// ページ番号の参照・相互参照（Kolophon で組んだページ番号の字）、段落の罫線（前・後）・囲み罫・網掛け、
// 目次（Kolophon で組んだ目次の字と、InDesign で作り直すための目次スタイル）、
// 索引（Kolophon で組んだ索引の字と、本文の語の所の索引の項目。InDesign の索引パネルで作り直せる）。
// 入れないもの（書き出しの結果で知らせる）：数式の形。
// InDesign は受け取った文章を自分で組み直すので、行の分かれ目とページの区切りは Kolophon と同じにはならない。

export interface IdmlFile {
  name: string;
  data: Uint8Array;
}

/** Kolophon で組んだページのうち、IDML に要るもの（画像の置き場所とノンブルの所）。座標はページの左上から pt。 */
export interface IdmlPage {
  images: { name: string; x: number; y: number; w: number; h: number; clip?: { x: number; y: number; w: number; h: number } }[];
  nombre?: NombrePlace;
  /** 余白に置いた柱・ノンブル・付記（なければ nombre からノンブルだけ）。 */
  marks?: PageMark[];
  /** 章の始まりの飾り方のページか。 */
  opening?: boolean;
  /** Kolophon でこのページに本文の字が入ったか（入らなかったページで画像のあるページには、テキストフレームを置かない）。 */
  hasText?: boolean;
}

export interface IdmlOptions {
  /** テキストフレームを置くページ数（Kolophon で組んだページ数。pages があればその数）。 */
  pageCount: number;
  /** Kolophon で組んだページ（画像とノンブルを置くのに使う）。 */
  pages?: IdmlPage[];
  /** 文書の画像（リンクのファイルにする）。 */
  images?: DocImage[];
  /** リンクのファイルを書き出す場所（ファイル名 → 絶対パス）。なければ画像は置かない。 */
  linkPath?: (fileName: string) => string;
  /** 前付けを別の番号で数えるときの、本文の最初のページ（0始まり）。 */
  bodyStart?: number;
  /** ラベルのあるページの番号（［＃ページ：名前］に入れる字）。 */
  pageOf?: (label: string) => string | undefined;
  /** Kolophon で組んだ目次と索引の段落（ページ番号を入れたもの）。なければ目次・索引は入れない。 */
  generated?: { toc?: Block[]; index?: Block[] };
  /** 書体の名前（ファミリーとスタイル）。分からなければ書体を指定しない（InDesign の既定の書体）。 */
  fontName?: (f: FontChoice | null) => { family: string; style: string; postscriptName?: string; cff?: boolean } | undefined;
}

export interface IdmlResult {
  files: IdmlFile[];
  /** 書き出すリンクのファイル（画像）。 */
  links: { path: string; data: Uint8Array }[];
  /** 書き出さなかったもの（知らせる）。 */
  skipped: string[];
}

const DOM = "16.0";
const NS = 'xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"';
const MM = 72 / 25.4;
const NO_PARA = "ParagraphStyle/$ID/[No paragraph style]";
const NO_CHAR = "CharacterStyle/$ID/[No character style]";
/**
 * 段落の組み方：日本語段落コンポーザー。InDesign は日本語のコンポーザーでないと、ルビ・圏点・縦中横・割注や
 * 日本語の約物の詰めを組まない（#1。クラウドの InDesign Server で確かめた）。
 * 段落スタイル「なし」（[No paragraph style]）に付けると、InDesign が文書を開けない（書き出しが失敗する）ので、ほかの段落スタイルにだけ付ける。
 */
const COMPOSER = "$ID/HL Composer J";

/** 数を短く書く（小数3桁まで）。 */
const n = (v: number) => String(Math.round(v * 1000) / 1000);
/** InDesign の Self に使う名前（: と / は %3a・%2f に）。 */
const selfName = (s: string) => s.replace(/%/g, "%25").replace(/:/g, "%3a").replace(/\//g, "%2f");
const attr = (name: string, value: string | number | boolean | undefined) => (value === undefined ? "" : ` ${name}="${escapeXml(String(value))}"`);
const xmlFile = (body: string) => new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${body}\n`);

/** 字形の切り替え（Kolophon の GlyphForm → InDesign の GlyphForm）。 */
const GLYPH_FORMS: Partial<Record<GlyphForm, string>> = {
  jp78: "JIS78Form",
  jp83: "JIS83Form",
  jp90: "JIS90Form",
  jp04: "JIS04Form",
  nlck: "NLCForm",
  trad: "TraditionalForm",
  expt: "ExpertForm",
};

/** 圏点の記号 → InDesign の圏点の種類。 */
const KENTEN_KINDS: Record<string, string> = {
  "﹅": "KentenSesameDot",
  "﹆": "KentenWhiteSesameDot",
  "●": "KentenBlackCircle",
  "○": "KentenWhiteCircle",
  "◎": "KentenBullseye",
  "◉": "KentenFishEye",
  "▲": "KentenBlackTriangle",
  "△": "KentenWhiteTriangle",
};
export const KENTEN_FROM_KIND = Object.fromEntries(Object.entries(KENTEN_KINDS).map(([k, v]) => [v, k]));
// 圏点の名前（原稿の記法）を、記号から引けるようにしておく（読み込みで使う）。
export const KENTEN_NAME = Object.fromEntries(Object.entries(KENTEN_MARKS).map(([name, mark]) => [mark, name]));

export function buildIdml(text: string, settings: Settings, opts: IdmlOptions): IdmlResult {
  const skipped = new Set<string>();
  const vertical = !leftBound(settings);
  const spec = toLayoutSpec(settings);
  const size = spec.fontSizePt;
  const pitch = size * spec.lineGap;
  const parseOpts = toParseOptions(settings);
  const tex = settings.format.markup === "tex" ? texToMarkup(text) : null;
  const formatted = horizontalPunctuation(formatText(tex ? tex.text : text, toFormatOptions(settings)).text, settings);
  const book = bookPageBlocks(settings.pages, settings.bookInfo, parseOpts);
  const blocks = expandXrefs([...book.front, ...parse(formatted, parseOpts), ...book.back]);
  let ids = 0;
  const id = (prefix = "u") => `${prefix}${(++ids).toString(16)}`;

  // ---- 色 ----
  const spots = settings.output.spotColors;
  const inks = spotInks(spots);
  const colorXml: string[] = [];
  const swatches = new Map<string, string>();
  const spotSelf = (sp: SpotColor) => `Color/${selfName(sp.name)}`;
  const cmykValue = (hex: string) => hexToCmyk(hex).map((v) => Math.round(v * 100)).join(" ");
  const swatchOf = (hex: string | null | undefined): string | undefined => {
    if (!hex) return undefined;
    const key = hex.toLowerCase();
    if (key === "#000000") return "Color/Black";
    const known = swatches.get(key);
    if (known) return known;
    const ink = inks.find((i) => i.hex === key);
    let self: string;
    if (ink) {
      const base = spotSelf(ink.spot);
      if (!swatches.has(ink.spot.color.toLowerCase())) {
        colorXml.push(
          `<Color Self="${escapeXml(base)}" Model="Spot" Space="CMYK" ColorValue="${ink.spot.cmyk.join(" ")}" ColorOverride="Normal" AlternateSpace="NoAlternateColor" AlternateColorValue="" Name="${escapeXml(ink.spot.name)}" ColorEditable="true" ColorRemovable="true" Visible="true" SwatchCreatorID="7937"/>`,
        );
        swatches.set(ink.spot.color.toLowerCase(), base);
      }
      if (ink.tint === 1) return base;
      // 名前の「%」は InDesign が別の字の書き表し（%3a など）として読むので使わない。
      self = `Tint/${selfName(ink.spot.name)} ${Math.round(ink.tint * 100)}`;
      colorXml.push(
        `<Tint Self="${escapeXml(self)}" Model="Spot" Space="CMYK" ColorValue="${ink.spot.cmyk.join(" ")}" ColorOverride="Normal" AlternateSpace="NoAlternateColor" AlternateColorValue="" Name="$ID/" ColorEditable="true" ColorRemovable="true" Visible="true" SwatchCreatorID="7937" TintValue="${Math.round(ink.tint * 100)}" BaseColor="${escapeXml(base)}"/>`,
      );
    } else {
      const [c, m, y, k] = hexToCmyk(key).map((v) => Math.round(v * 100));
      const name = `C=${c} M=${m} Y=${y} K=${k}`;
      self = `Color/${name}`;
      if (![...swatches.values()].includes(self)) {
        colorXml.push(
          `<Color Self="${escapeXml(self)}" Model="Process" Space="CMYK" ColorValue="${cmykValue(key)}" ColorOverride="Normal" AlternateSpace="NoAlternateColor" AlternateColorValue="" Name="${name}" ColorEditable="true" ColorRemovable="true" Visible="true" SwatchCreatorID="7937"/>`,
        );
      }
    }
    swatches.set(key, self);
    return self;
  };

  // ---- 書体 ----
  const fontXml = new Map<string, string>();
  const fontProps = (f: FontChoice | null): { family?: string; style?: string } => {
    const name = opts.fontName?.(f);
    if (!name) return {};
    if (!fontXml.has(`${name.family}\u0000${name.style}`)) {
      const fam = id("di");
      fontXml.set(
        `${name.family}\u0000${name.style}`,
        `<FontFamily Self="${fam}" Name="${escapeXml(name.family)}"><Font Self="${fam}f" FontFamily="${escapeXml(name.family)}" Name="${escapeXml(`${name.family}\t${name.style}`)}" PostScriptName="${escapeXml(name.postscriptName ?? "")}" Status="Installed" FontStyleName="${escapeXml(name.style)}" FontType="${name.cff ? "OpenTypeCFF" : "OpenTypeTT"}" WritingScript="1" FullName="${escapeXml(`${name.family} ${name.style}`)}" FullNameNative="${escapeXml(`${name.family} ${name.style}`)}" FontStyleNameNative="${escapeXml(name.style)}" PlatformName="$ID/" Version="" TypekitID="$ID/"/></FontFamily>`,
      );
    }
    return { family: name.family, style: name.style };
  };
  const bodyFont = fontProps(settings.font);

  // ---- スタイル ----
  const characterNames = new Set(settings.styles.character.map((c) => c.name));
  const paragraphNames = new Set(settings.styles.paragraph.map((p) => p.name));
  const charSelf = (name: string) => `CharacterStyle/${selfName(name)}`;
  const paraSelf = (name: string) => `ParagraphStyle/${selfName(name)}`;
  const justification = (p: ParagraphStyle) => (p.align === "center" ? "CenterAlign" : p.align === "end" ? "RightAlign" : "LeftJustified");
  const charStyleXml = (c: CharacterStyle) => {
    const font = c.font ? fontProps(c.font) : {};
    const props = [`<BasedOn type="string">$ID/[No character style]</BasedOn>`, font.family ? `<AppliedFont type="string">${escapeXml(font.family)}</AppliedFont>` : ""].join("");
    return `<CharacterStyle${attr("Self", charSelf(c.name))}${attr("Name", c.name)} Imported="false" KeyboardShortcut="0 0"${c.scale !== 1 ? attr("PointSize", n(size * c.scale)) : ""}${attr("FillColor", swatchOf(c.color))}${attr("FontStyle", font.style)}${c.tracking ? attr("Tracking", c.tracking) : ""}${c.deform === "condensed" ? attr("HorizontalScale", c.deformRatio) : ""}${c.deform === "flat" ? attr("VerticalScale", c.deformRatio) : ""}${c.proportional ? ' OTFProportionalMetrics="true"' : ""}${attr("GlyphForm", GLYPH_FORMS[c.glyphForm])}><Properties>${props}</Properties></CharacterStyle>`;
  };
  /**
   * 段落の罫線・網掛け（Kolophon → InDesign の段落境界線・段落の囲み罫・段落の背景色）。
   * 縦組みでも InDesign の「前」は1行目の外側（右）なので、Kolophon と同じ側になる。
   * 罫と字の間（gap）は本文の字の大きさに対する割合。前の罫は1行目のベースラインからの高さ（字の頭はベースラインの約 0.88 字上）。
   */
  const STROKE_TYPES: Record<RuleKind, string> = { solid: "StrokeStyle/$ID/Solid", double: "StrokeStyle/$ID/ThinThin", dotted: "StrokeStyle/$ID/Dotted", dashed: "StrokeStyle/$ID/Dashed" };
  const ruleColor = (r: ParagraphRule, p: ParagraphStyle) => swatchOf(r.color ?? p.color ?? settings.textColor) ?? "Color/Black";
  const decorationAttrs = (p: ParagraphStyle, pointSize: number) => {
    const d = p.decoration;
    if (!hasDecoration(d)) return "";
    const width = d.length === "text" ? "TextWidth" : "ColumnWidth";
    let out = "";
    if (d.ruleBefore.on) {
      const r = d.ruleBefore;
      out += ` RuleAbove="true"${attr("RuleAboveLineWeight", n(r.width))}${attr("RuleAboveType", STROKE_TYPES[r.kind])}${attr("RuleAboveColor", ruleColor(r, p))}${attr("RuleAboveOffset", n(pointSize * 0.88 + r.gap * size))} RuleAboveWidth="${width}"`;
    }
    if (d.ruleAfter.on) {
      const r = d.ruleAfter;
      out += ` RuleBelow="true"${attr("RuleBelowLineWeight", n(r.width))}${attr("RuleBelowType", STROKE_TYPES[r.kind])}${attr("RuleBelowColor", ruleColor(r, p))}${attr("RuleBelowOffset", n(pointSize * 0.12 + r.gap * size))} RuleBelowWidth="${width}"`;
    }
    const pad = n(d.pad * size);
    if (d.border.on) {
      const r = d.border;
      const w = n(r.width);
      out += ` ParagraphBorderOn="true"${attr("ParagraphBorderType", STROKE_TYPES[r.kind])}${attr("ParagraphBorderColor", ruleColor(r, p))} ParagraphBorderTopLineWeight="${w}" ParagraphBorderBottomLineWeight="${w}" ParagraphBorderLeftLineWeight="${w}" ParagraphBorderRightLineWeight="${w}" ParagraphBorderTopOffset="${pad}" ParagraphBorderBottomOffset="${pad}" ParagraphBorderLeftOffset="${pad}" ParagraphBorderRightOffset="${pad}"`;
    }
    if (d.shading) {
      out += ` ParagraphShadingOn="true"${attr("ParagraphShadingColor", swatchOf(d.shading))} ParagraphShadingWidth="${width}" ParagraphShadingTopOffset="${pad}" ParagraphShadingBottomOffset="${pad}" ParagraphShadingLeftOffset="${pad}" ParagraphShadingRightOffset="${pad}"`;
    }
    return out;
  };
  const listItems = (name: string, items: string[]) => (items.length > 0 ? `<${name} type="list">${items.map((i) => `<ListItem type="record">${i}</ListItem>`).join("")}</${name}>` : "");
  const paraStyleXml = (p: ParagraphStyle) => {
    const font = p.font ? fontProps(p.font) : bodyFont;
    const pointSize = size * p.scale;
    const leading = pitch * (p.linePitch ?? 1) * p.scale;
    const nested = p.nested
      .filter((r) => !r.style || characterNames.has(r.style))
      .map(
        (r) =>
          `<AppliedCharacterStyle type="object">${r.style ? escapeXml(charSelf(r.style)) : NO_CHAR}</AppliedCharacterStyle>${r.until === "chars" ? `<Delimiter type="enumeration">AnyCharacter</Delimiter>` : `<Delimiter type="string">${escapeXml(r.chars || "　")}</Delimiter>`}<Repetition type="long">${r.count}</Repetition><Inclusive type="boolean">${r.until !== "before"}</Inclusive>`,
      );
    const grep = p.grep
      .filter((r) => r.pattern && characterNames.has(r.style))
      .map((r) => `<AppliedCharacterStyle type="object">${escapeXml(charSelf(r.style))}</AppliedCharacterStyle><GrepExpression type="string">${escapeXml(r.pattern)}</GrepExpression>`);
    const lines =
      p.lineStyle.lines > 0 && characterNames.has(p.lineStyle.style)
        ? [`<AppliedCharacterStyle type="object">${escapeXml(charSelf(p.lineStyle.style))}</AppliedCharacterStyle><LineCount type="long">${p.lineStyle.lines}</LineCount>`]
        : [];
    // 目次・索引の項目：見出しとページ番号の間はタブ。行の終わりに右揃えのタブを置き、リーダーで埋める。
    const leader = (TOC_ENTRY_STYLES as readonly string[]).includes(p.name) ? settings.toc.leader || "…" : p.name === INDEX_ENTRY_STYLE ? "…" : undefined;
    const tabs = leader
      ? `<TabList type="list"><ListItem type="record"><Alignment type="enumeration">RightAlign</Alignment><AlignmentCharacter type="string">.</AlignmentCharacter><Leader type="string">${escapeXml(leader)}</Leader><Position type="unit">${n(spec.charsPerLine * size)}</Position></ListItem></TabList>`
      : "";
    const props = [
      `<BasedOn type="string">$ID/[No paragraph style]</BasedOn>`,
      `<Leading type="unit">${n(leading)}</Leading>`,
      font.family ? `<AppliedFont type="string">${escapeXml(font.family)}</AppliedFont>` : "",
      listItems("AllNestedStyles", nested),
      listItems("AllGREPStyles", grep),
      listItems("AllLineStyles", lines),
      tabs,
    ].join("");
    return `<ParagraphStyle${attr("Self", paraSelf(p.name))}${attr("Name", p.name)} Imported="false" Composer="${COMPOSER}"${attr("NextStyle", paraSelf(p.name))} KeyboardShortcut="0 0"${attr("PointSize", n(pointSize))}${attr("FontStyle", font.style)}${attr("Justification", justification(p))}${p.indent ? attr("LeftIndent", n(p.indent * pointSize)) : ""}${p.spaceBefore ? attr("SpaceBefore", n(p.spaceBefore * pitch)) : ""}${p.spaceAfter ? attr("SpaceAfter", n(p.spaceAfter * pitch)) : ""}${attr("FillColor", swatchOf(p.color ?? settings.textColor))}${p.tracking ? attr("Tracking", p.tracking) : ""}${p.deform === "condensed" ? attr("HorizontalScale", p.deformRatio) : ""}${p.deform === "flat" ? attr("VerticalScale", p.deformRatio) : ""}${p.proportional ? ' OTFProportionalMetrics="true"' : ""}${attr("GlyphForm", GLYPH_FORMS[p.glyphForm])}${p.keepWithNext ? ' KeepWithNext="1"' : ""}${p.spanColumns ? ' SpanColumnType="SpanColumns" SpanSplitColumnCount="All"' : ""}${p.keepLines ? ' KeepLinesTogether="true" KeepFirstLines="2" KeepLastLines="2"' : ""}${p.dropCap.lines >= 2 ? attr("DropCapLines", p.dropCap.lines) + attr("DropCapCharacters", p.dropCap.chars) : ""}${decorationAttrs(p, pointSize)}><Properties>${props}</Properties></ParagraphStyle>`;
  };
  const paragraphStyles = settings.styles.paragraph.map(paraStyleXml);
  // 目次スタイル：InDesign の「目次を更新」で、見出しの段落スタイルから目次を作り直せるように。
  const tocEntries = (["大見出し", "中見出し"] as const)
    .slice(0, Math.max(1, Math.min(2, settings.toc.levels)))
    .flatMap((h, i) =>
      paragraphNames.has(h) && paragraphNames.has(TOC_ENTRY_STYLES[i])
        ? [`<TOCStyleEntry Self="TOCStyle/Kolophon目次TOCStyleEntry${i}" Name="${escapeXml(h)}" FormatStyle="${escapeXml(paraSelf(TOC_ENTRY_STYLES[i]))}" Level="${i + 1}" PageNumberPosition="AfterEntry" Separator="^t"/>`]
        : [],
    );
  const tocStyleXml =
    tocEntries.length > 0
      ? `<TOCStyle Self="TOCStyle/Kolophon目次" Name="Kolophon目次" Title="${escapeXml(settings.toc.title)}" TitleStyle="${escapeXml(paragraphNames.has(TOC_TITLE_STYLE) ? paraSelf(TOC_TITLE_STYLE) : NO_PARA)}" RunIn="false" IncludeHidden="false" IncludeBookDocuments="false" SetStoryDirection="${vertical ? "Vertical" : "Horizontal"}">${tocEntries.join("")}</TOCStyle>`
      : "";
  const paraScale = new Map(settings.styles.paragraph.map((p) => [p.name, p.scale]));
  const charScale = new Map(settings.styles.character.map((c) => [c.name, c.scale]));
  const characterStyles = settings.styles.character.map(charStyleXml);

  // ---- 画像（リンクのファイル） ----
  const imageByName = new Map((opts.images ?? []).map((img) => [img.name, img]));
  const canPlace = !!(opts.pages && opts.linkPath);
  const placeable = (name: string) => canPlace && imageByName.has(name);
  const linkFiles = new Map<string, { path: string; data: Uint8Array; img: DocImage }>();
  const usedFileNames = new Set<string>();
  const linkOf = (name: string) => {
    let link = linkFiles.get(name);
    if (!link) {
      const img = imageByName.get(name)!;
      const ext = img.mime === "image/png" ? "png" : "jpg";
      // ファイル名に使えない字は置き換え、同じ名前は番号で分ける。
      const base = linkBaseName(img).replace(/[\\/:*?"<>|]/g, "_").trim() || "画像";
      let file = `${base}.${ext}`;
      for (let k = 2; usedFileNames.has(file.toLowerCase()); k++) file = `${base}_${k}.${ext}`;
      usedFileNames.add(file.toLowerCase());
      link = { path: opts.linkPath!(file), data: new Uint8Array(Buffer.from(img.data, "base64")), img };
      linkFiles.set(name, link);
    }
    return link;
  };

  // ---- 本文（1つのストーリー） ----
  const paras: string[] = [];
  let pendingBreak: "NextPage" | "NextOddPage" | undefined;
  let noteNo = 0;
  let notes: { no: number; atoms: Atom[] }[] = [];
  const noteStyle = paragraphNames.has(NOTE_STYLE) ? NOTE_STYLE : "本文";
  const atomText = (a: Atom): string => {
    if (a.pageRef !== undefined) return opts.pageOf?.(a.pageRef) ?? "？";
    if (a.warichu !== undefined) return a.warichu;
    return a.cells
      .map((c) => {
        if (c.math) {
          skipped.add("数式（TeX の式を字で入れた）");
          return `［数式：${c.text}］`;
        }
        return c.text;
      })
      .join("");
  };
  /** 段落の字を、書式の同じ字の並び（CharacterStyleRange）にする。lineStyle は行頭の［＃名前］が文字スタイルのとき。 */
  // ルビの揃え・側（Kolophon → InDesign）。1-2-1 は JIS、肩付きは親文字の頭（縦組みの上・横組みの左）に揃える。
  const RUBY_ALIGNMENT = { "121": "RubyJIS", center: "RubyCenter", shoulder: "RubyLeft" } as const;
  const charRuby = new Map(settings.styles.character.map((c) => [c.name, c]));
  const paraRuby = new Map(settings.styles.paragraph.map((p) => [p.name, p]));
  const rubyAttrs = (charStyle: string | undefined, paraName: string | undefined) => {
    const c = charStyle ? charRuby.get(charStyle) : undefined;
    const p = paraName ? paraRuby.get(paraName) : undefined;
    const align = c?.rubyAlign || p?.rubyAlign || settings.typography.rubyAlign || "121";
    const side = c?.rubySide || p?.rubySide || settings.typography.rubySide || "right";
    return ` RubyAlignment="${RUBY_ALIGNMENT[align]}" RubyPosition="${side === "left" ? "BelowLeft" : "AboveRight"}"`;
  };
  const runs = (atoms: Atom[], lineStyle?: string, paraScale = 1, paraName?: string): string[] => {
    const out: { key: string; open: string; text: string; pre: string }[] = [];
    for (const a of atoms) {
      if (a.leader) {
        // 目次・索引の項目のリーダー：タブにする（リーダーの字は段落スタイルのタブで入る）。
        const prev = out[out.length - 1];
        if (prev) prev.text += "\t";
        else out.push({ key: "tab", open: `<CharacterStyleRange AppliedCharacterStyle="${NO_CHAR}">`, text: "\t", pre: "" });
        continue;
      }
      if (a.note) {
        noteNo++;
        notes.push({ no: noteNo, atoms: a.note });
      }
      const style = a.style && characterNames.has(a.style) ? a.style : lineStyle;
      const first = a.cells[0];
      const last = a.cells[a.cells.length - 1];
      const tracking = first?.tracking;
      const kern = last?.kern;
      const local =
        (a.ruby ? ` RubyFlag="true"${attr("RubyString", a.ruby.replace(/[|｜]/g, ""))} RubyType="GroupRuby"${rubyAttrs(a.style && characterNames.has(a.style) ? a.style : lineStyle, paraName)}` : "") +
        (a.kenten ? attr("KentenKind", KENTEN_KINDS[a.kenten] ?? "KentenSesameDot") : "") +
        (a.sideline ? ' Underline="true"' : "") +
        (vertical && first?.tcy && a.pageRef === undefined && !a.note ? ' Tatechuyoko="true"' : "") +
        (a.warichu !== undefined ? ' Warichu="true"' : "") +
        (tracking !== undefined ? attr("Tracking", tracking) : "") +
        (kern ? ` KerningMethod="$ID/Manual"${attr("KerningValue", kern)}` : "") +
        // 文字スタイルの大きさは本文に対する倍率なので、段落の大きさが本文と違えば、その字に大きさを直接付ける。
        (style && paraScale !== 1 && charScale.get(style) !== 1 ? attr("PointSize", n(size * paraScale * (charScale.get(style) ?? 1))) : "");
      const open = `<CharacterStyleRange${attr("AppliedCharacterStyle", style ? charSelf(style) : NO_CHAR)}${local}>`;
      const text = a.note ? `注${noteNo}` : atomText(a);
      // 索引の語：その字の前に、索引の項目（ページの参照）を置く。
      const pre = (a.index ?? []).map((e) => `<PageReference Self="${id("pr")}" PageReferenceType="CurrentPage" ReferencedTopic="${topicOf(e.term, e.reading)}"/>`).join("");
      // ルビ・割注・カーニング・索引のある字は、それだけで1つの並びにする（隣と混ざらないように）。
      const key = a.ruby || a.warichu !== undefined || kern || pre ? `${open}\u0000${out.length}` : open;
      const prev = out[out.length - 1];
      if (prev && prev.key === key) prev.text += text;
      else out.push({ key, open, text, pre });
    }
    return out.map((r) => `${r.open}${r.pre}<Content>${escapeXml(r.text)}</Content>`);
  };
  // 索引の項目（Topic）：表記と読みが同じ語は1つ。
  const topics = new Map<string, { self: string; term: string; reading: string }>();
  const topicOf = (term: string, reading: string) => {
    const key = `${term}\u0000${reading}`;
    let t = topics.get(key);
    if (!t) topics.set(key, (t = { self: `diTopic${topics.size + 1}`, term, reading }));
    return t.self;
  };
  const paragraph = (styleName: string, atoms: Atom[], lineStyle?: string) => {
    const parts = runs(atoms, lineStyle, paraScale.get(styleName) ?? 1, styleName);
    const start = pendingBreak && paras.length > 0 ? attr("StartParagraph", pendingBreak) : "";
    pendingBreak = undefined;
    paras.push(`<ParagraphStyleRange${attr("AppliedParagraphStyle", paraSelf(styleName))}${start}>${parts.length > 0 ? parts.map((p) => `${p}\u0001</CharacterStyleRange>`).join("") : `<CharacterStyleRange AppliedCharacterStyle="${NO_CHAR}">\u0001</CharacterStyleRange>`}</ParagraphStyleRange>`);
  };
  const flushNotes = () => {
    for (const note of notes) paragraph(noteStyle, [{ cells: [...`注${note.no}　`].map((ch) => ({ text: ch })) }, ...note.atoms]);
    notes = [];
  };
  const styleOf = (b: { style?: string }, fallback: string) => (b.style && paragraphNames.has(b.style) ? b.style : fallback);
  const lineStyleOf = (b: { style?: string }) => (b.style && !paragraphNames.has(b.style) && characterNames.has(b.style) ? b.style : undefined);
  /**
   * 表：InDesign の表を、1つの段落の中に置く。見出しの行・欄の揃え・つないだ欄（「<」は左と、「^」は上と）・罫（すべて・行の境目だけ・なし）・
   * 見出しのあとの二重線を移す。欄の幅は、欄の字の多さで行の長さを分ける。
   */
  const table = (t: TableBlock) => {
    const tid = id("tb");
    const count = Math.max(1, ...t.rows.map((r) => r.cells.length));
    const plain = (atoms: Atom[]) => atoms.map((a) => a.cells.map((c) => c.text).join("")).join("").trim();
    // 欄のまとまり（EPUB と同じ求め方）。
    type Group = { from: number; to: number; rowspan: number; up: boolean; atoms: Atom[] };
    const rows: Group[][] = t.rows.map((row) => {
      const out: Group[] = [];
      for (let c = 0; c < count; c++) {
        const text = plain(row.cells[c]?.atoms ?? []);
        if ((text === "<" || text === "＜") && out.length > 0) {
          out[out.length - 1].to = c + 1;
          continue;
        }
        out.push({ from: c, to: c + 1, rowspan: 1, up: text === "^" || text === "＾", atoms: row.cells[c]?.atoms ?? [] });
      }
      return out;
    });
    rows.forEach((gs, r) => {
      for (const g of gs) {
        if (!g.up) continue;
        for (let k = r - 1; k >= 0; k--) {
          const above = rows[k].find((x) => x.from === g.from);
          if (above && !above.up) {
            above.rowspan++;
            break;
          }
        }
      }
    });
    // 欄の幅：欄の中のいちばん長い字の数（2字より短くはしない）で、行の長さを分ける。
    const lengths = Array.from({ length: count }, (_, c) => Math.max(2, ...t.rows.map((r) => [...plain(r.cells[c]?.atoms ?? [])].length + 1)));
    const total = lengths.reduce((a, b) => a + b, 0);
    const lineLength = spec.charsPerLine * size;
    const rule = t.rules ?? "all";
    const weight = (on: boolean) => (on ? 0.5 : 0);
    const cells = rows
      .flatMap((gs, r) =>
        gs
          .filter((g) => !g.up)
          .map((g) => {
            const lastHeader = t.header > 0 && r + g.rowspan - 1 === t.header - 1;
            const align = t.align?.[g.from];
            const just = align === "center" ? "CenterAlign" : align === "end" ? "RightAlign" : "LeftAlign";
            const styleName = r < t.header && paragraphNames.has("表の見出し") ? "表の見出し" : paragraphNames.has("表") ? "表" : "本文";
            const content = runs(g.atoms, undefined, paraScale.get(styleName) ?? 1, styleName).map((p) => `${p}</CharacterStyleRange>`).join("");
            const bottom = lastHeader && t.headerDouble ? ` BottomEdgeStrokeWeight="1.5" BottomEdgeStrokeType="StrokeStyle/$ID/ThinThin"` : ` BottomEdgeStrokeWeight="${weight(rule !== "none")}"`;
            return `<Cell Self="${tid}i${g.from}i${r}" Name="${g.from}:${r}" RowSpan="${g.rowspan}" ColumnSpan="${g.to - g.from}" AppliedCellStyle="CellStyle/$ID/[None]" AppliedCellStylePriority="0" TopEdgeStrokeWeight="${weight(rule !== "none")}" LeftEdgeStrokeWeight="${weight(rule === "all")}" RightEdgeStrokeWeight="${weight(rule === "all")}"${bottom}><ParagraphStyleRange${attr("AppliedParagraphStyle", paraSelf(styleName))} Justification="${just}">${content || `<CharacterStyleRange AppliedCharacterStyle="${NO_CHAR}"/>`}</ParagraphStyleRange></Cell>`;
          }),
      )
      .join("");
    const rowXml = t.rows.map((_, r) => `<Row Self="${tid}Row${r}" Name="${r}" MinimumHeight="${n(pitch)}" AutoGrow="true"/>`).join("");
    const colXml = lengths.map((l, c) => `<Column Self="${tid}Column${c}" Name="${c}" SingleColumnWidth="${n((lineLength * l) / total)}"/>`).join("");
    const tableXml = `<Table Self="${tid}" HeaderRowCount="${Math.min(t.header, t.rows.length)}" FooterRowCount="0" BodyRowCount="${Math.max(0, t.rows.length - t.header)}" ColumnCount="${count}" AppliedTableStyle="TableStyle/$ID/[Basic Table]" TableDirection="LeftToRightDirection">${rowXml}${colXml}${cells}</Table>`;
    const start = pendingBreak && paras.length > 0 ? attr("StartParagraph", pendingBreak) : "";
    pendingBreak = undefined;
    // 表のあとに1行ぶん空ける：InDesign は表のすぐあとの行を表の端に寄せて置き、縦組みでは字が表に重なる（#1）。
    paras.push(`<ParagraphStyleRange${attr("AppliedParagraphStyle", paraSelf("本文"))}${start}${attr("SpaceAfter", n(pitch))}><CharacterStyleRange AppliedCharacterStyle="${NO_CHAR}">${tableXml}\u0001</CharacterStyleRange></ParagraphStyleRange>`);
  };
  const emit = (list: Block[]) => {
    for (const b of list) {
      switch (b.kind) {
        case "heading":
          if (b.level === 1) {
            if (settings.notes.placement !== "end") flushNotes();
            if (settings.chapterStartsOdd) pendingBreak = "NextOddPage";
          }
          paragraph(styleOf(b, b.level === 1 ? "大見出し" : "中見出し"), b.atoms, lineStyleOf(b));
          break;
        case "para":
          paragraph(styleOf(b, "本文"), b.atoms, lineStyleOf(b));
          break;
        case "blank":
          paragraph("本文", []);
          break;
        case "pagebreak":
          pendingBreak = b.odd ? "NextOddPage" : "NextPage";
          break;
        case "blankpage":
          pendingBreak = "NextPage";
          paragraph("本文", []);
          pendingBreak = "NextPage";
          break;
        case "pagegroup":
        case "section":
          pendingBreak = "NextPage";
          emit(b.blocks);
          pendingBreak = "NextPage";
          break;
        case "toc":
        case "indexpage": {
          // Kolophon で組んだ目次・索引の段落（ページ番号を入れたもの）を、新しいページから入れる。
          const content = b.kind === "toc" ? opts.generated?.toc : opts.generated?.index;
          if (!content) {
            skipped.add(b.kind === "toc" ? "目次（InDesign の目次の機能で作り直してください）" : "索引");
            break;
          }
          pendingBreak = "NextPage";
          emit(content);
          pendingBreak = "NextPage";
          break;
        }
        case "image":
          // ページに置ける画像は、本文には何も入れない（Kolophon で置いた所に、リンクの画像として置く）。
          if (placeable(b.name)) break;
          skipped.add("画像（置き場所に［画像：名前］の字を入れた）");
          paragraph("本文", [...`［画像：${b.name}］`].map((ch) => ({ cells: [{ text: ch }] })));
          break;
        case "table":
          table(b);
          break;
        default:
          break;
      }
    }
  };
  emit(blocks);
  flushNotes();
  // 段落の終わり（Br）は、最後の段落のあとには付けない。
  const storyBody = paras.map((p, i) => p.replace(/\u0001/g, (_, offset: number, s: string) => (i < paras.length - 1 && offset === s.lastIndexOf("\u0001") ? "<Br/>" : ""))).join("\n");
  const fixedBody = storyBody;

  // ---- ページと版面 ----
  const W = spec.pageWidthMm * MM;
  const H = spec.pageHeightMm * MM;
  const pageCount = Math.max(1, opts.pages?.length ?? opts.pageCount);
  /** 版面（ページの左上から、pt）。layout.ts の placePage と同じ求め方。 */
  const textArea = (index: number) => {
    const along = spec.columns * spec.charsPerLine * size + (spec.columns - 1) * spec.columnGapPt;
    const across = (spec.linesPerPage - 1) * pitch + size;
    const bw = vertical ? across : along;
    const bh = vertical ? along : across;
    const odd = (spec.firstPageNumber + index) % 2 !== 0;
    if (!spec.margins) return { x: (W - bw) / 2, y: (H - bh) / 2, w: bw, h: bh };
    const gutter = spec.margins.gutterMm * MM;
    // 右綴じ（縦組み）の奇数ページは左ページで右側がノド。左綴じ（横組み）の奇数ページは右ページで左側がノド。
    const x = vertical ? (odd ? W - gutter - bw : gutter) : odd ? gutter : W - gutter - bw;
    return { x, y: spec.margins.topMm * MM, w: bw, h: bh };
  };
  /** そのページが左ページか（右綴じは奇数ページ、左綴じは偶数ページが左）。 */
  const isLeft = (index: number) => ((spec.firstPageNumber + index) % 2 !== 0) === vertical;
  // 見開き：読む順に、最初のページが片側だけなら1ページ、あとは2ページずつ。
  const spreads: number[][] = [];
  for (let i = 0; i < pageCount; i++) {
    const cur = spreads[spreads.length - 1];
    // 読む順で見開きの1ページ目になるのは、右綴じでは右ページ、左綴じでは左ページ。
    const opensSpread = vertical ? !isLeft(i) : isLeft(i);
    if (!cur || opensSpread || cur.length >= 2) spreads.push([i]);
    else cur.push(i);
  }
  /** ページに置く画像（文書にある画像だけ）。 */
  const imagesOn = (i: number) => (canPlace ? (opts.pages?.[i]?.images ?? []).filter((im) => imageByName.has(im.name)) : []);
  /** 画像が版面のほとんどを覆うページ（全面・1ページの画像）には、テキストフレームを置かない（文字が画像に重ならないように）。 */
  const hasFrame = (i: number) => {
    const a = textArea(i);
    const imgs = imagesOn(i);
    // 1ページに1枚置いた画像のページ：Kolophon では字を入れないので、フレームも置かない。
    if (imgs.length > 0 && opts.pages?.[i]?.hasText === false) return false;
    return !imgs.some((im) => {
      const r = im.clip ?? im;
      const w = Math.max(0, Math.min(a.x + a.w, r.x + r.w) - Math.max(a.x, r.x));
      const h = Math.max(0, Math.min(a.y + a.h, r.y + r.h) - Math.max(a.y, r.y));
      return w * h >= a.w * a.h * 0.8;
    });
  };
  const framePages = Array.from({ length: pageCount }, (_, i) => i).filter(hasFrame);
  const storyId = "u1";
  const frameId = (i: number) => `tf${i + 1}`;
  const margin = (i: number) => {
    const a = textArea(i);
    // ページの段は1つ（段組みはテキストフレームの段で表す）。ColumnsPositions は段の始まりと終わりの組。
    return `<MarginPreference ColumnCount="1" ColumnGutter="${n(spec.columnGapPt || 12)}" Top="${n(a.y)}" Bottom="${n(H - a.y - a.h)}" Left="${n(a.x)}" Right="${n(W - a.x - a.w)}" ColumnDirection="${vertical ? "Vertical" : "Horizontal"}" ColumnsPositions="0 ${n(vertical ? a.h : a.w)}"/>`;
  };
  const pt = (x: number, y: number) => `<PathPointType Anchor="${n(x)} ${n(y)}" LeftDirection="${n(x)} ${n(y)}" RightDirection="${n(x)} ${n(y)}"/>`;
  /** 四角の輪郭（左上・左下・右下・右上）。 */
  const pathOf = (x: number, y: number, w: number, h: number) =>
    `<PathGeometry><GeometryPathType PathOpen="false"><PathPointArray>${pt(x, y)}${pt(x, y + h)}${pt(x + w, y + h)}${pt(x + w, y)}</PathPointArray></GeometryPathType></PathGeometry>`;
  const wrapGap = (settings.advanced.wrapGapChars ?? 1) * size;
  /** ページの画像：リンクの画像を入れた四角。画像の枠は、見せる範囲（clip）か画像の大きさ。本文の中の画像には回り込みを付ける。 */
  const imageXml = (i: number, tx: number, ty: number) =>
    imagesOn(i)
      .map((im) => {
        const link = linkOf(im.name);
        const frame = im.clip ?? im;
        const iw = Math.max(1, link.img.width);
        const ih = Math.max(1, link.img.height);
        const wrap = hasFrame(i)
          ? `<TextWrapPreference Inverse="false" ApplyToMasterPageOnly="false" TextWrapSide="BothSides" TextWrapMode="BoundingBoxTextWrap"><Properties><TextWrapOffset Top="${n(wrapGap)}" Left="${n(wrapGap)}" Bottom="${n(wrapGap)}" Right="${n(wrapGap)}"/></Properties></TextWrapPreference>`
          : "";
        const uri = `file:${encodeURI(link.path.replace(/\\/g, "/"))}`;
        const format = link.img.mime === "image/png" ? "$ID/Portable Network Graphics (PNG)" : "$ID/JPEG";
        return `<Rectangle Self="${id("r")}" ContentType="GraphicType" ItemLayer="uL" Locked="false" ItemTransform="1 0 0 1 0 0"><Properties>${pathOf(tx + frame.x, ty + frame.y, frame.w, frame.h)}</Properties>${wrap}<Image Self="${id("im")}" ItemTransform="${n(im.w / iw)} 0 0 ${n(im.h / ih)} ${n(tx + im.x)} ${n(ty + im.y)}"><Properties><GraphicBounds Left="0" Top="0" Right="${iw}" Bottom="${ih}"/></Properties><Link Self="${id("lk")}" LinkResourceURI="${escapeXml(uri)}" LinkResourceFormat="${format}" StoredState="Normal" LinkClassID="35906" LinkClientID="257" LinkResourceModified="false" LinkObjectModified="false" ShowInUI="true" CanEmbed="true" CanUnembed="true" CanPackage="true" ImportPolicy="NoAutoImport" ExportPolicy="NoAutoExport"/></Image></Rectangle>`;
      })
      .join("");
  // マスター：Kolophon で柱・ノンブル・付記を置いたページを、本文（A）と章の始まり（C）に分け、置いていないページは B にする。
  const marksOf = (i: number): PageMark[] => {
    const p = opts.pages?.[i];
    if (!p) return [];
    if (p.marks) return p.marks;
    return p.nombre ? [{ parts: [{ kind: "nombre" }], x: p.nombre.x, y: p.nombre.y, size: p.nombre.size, align: p.nombre.align, color: p.nombre.color }] : [];
  };
  const masterOf = (i: number) => (marksOf(i).length === 0 ? "un" : opts.pages?.[i]?.opening ? "uo" : "um");
  const spreadFiles = spreads.map((pages, si) => {
    const body = pages.map((i) => {
      const tx = isLeft(i) ? -W : 0;
      const ty = -H / 2;
      const a = textArea(i);
      const page = `<Page Self="p${i + 1}" Name="${spec.firstPageNumber + i}" AppliedMaster="${masterOf(i)}" OverrideList="" TabOrder="" GridStartingPoint="TopOutside" UseMasterGrid="true" GeometricBounds="0 0 ${n(H)} ${n(W)}" ItemTransform="1 0 0 1 ${n(tx)} ${n(ty)}" MasterPageTransform="1 0 0 1 0 0"><Properties><PageColor type="enumeration">UseMasterColor</PageColor></Properties>${margin(i)}</Page>`;
      const k = framePages.indexOf(i);
      const frame =
        k < 0
          ? ""
          : `<TextFrame Self="${frameId(i)}" ParentStory="${storyId}" PreviousTextFrame="${k > 0 ? frameId(framePages[k - 1]) : "n"}" NextTextFrame="${k < framePages.length - 1 ? frameId(framePages[k + 1]) : "n"}" ContentType="TextType" ItemLayer="uL" Locked="false" ItemTransform="1 0 0 1 0 0"><Properties>${pathOf(tx + a.x, ty + a.y, a.w, a.h)}</Properties><TextFramePreference TextColumnCount="${spec.columns}" TextColumnGutter="${n(spec.columnGapPt || 12)}"/></TextFrame>`;
      return { page, items: imageXml(i, tx, ty) + frame };
    });
    // 綴じの位置：見開きの中で何ページ目のあとにノドがあるか。
    const binding = pages.length === 2 ? 1 : isLeft(pages[0]) ? 1 : 0;
    const xml = `<idPkg:Spread ${NS} DOMVersion="${DOM}"><Spread Self="s${si + 1}" PageTransitionType="None" PageTransitionDirection="NotApplicable" PageTransitionDuration="Medium" ShowMasterItems="true" PageCount="${pages.length}" BindingLocation="${binding}" AllowPageShuffle="true" ItemTransform="1 0 0 1 0 0" FlattenerOverride="Default">${body.map((b) => b.page).join("")}${body.map((b) => b.items).join("")}</Spread></idPkg:Spread>`;
    return { name: `Spreads/Spread_s${si + 1}.xml`, data: xmlFile(xml) };
  });

  // ---- マスターページの柱・ノンブル・付記 ----
  // 左ページ・右ページそれぞれ、そのマスターを当てるページのうち最初に見つかったページの置き方で、小さなテキストフレームを置く。
  // ノンブルは自動のページ番号（<?ACE 18?>）、章・節の柱はその見出しの段落スタイルを拾うテキスト変数、書名と付記は字のまま。
  const markStories: { id: string; xml: string }[] = [];
  const variables = new Map<string, { name: string; style: string }>();
  const variableOf = (source: "chapter" | "section") => {
    const name = source === "chapter" ? "柱（章）" : "柱（節）";
    const style = source === "chapter" ? "大見出し" : "中見出し";
    if (!variables.has(name)) variables.set(name, { name, style });
    return name;
  };
  const markContent = (m: PageMark) =>
    m.parts
      .map((part, k) => {
        const sep = k > 0 ? "<Content>　</Content>" : "";
        if (part.kind === "nombre") return `${sep}<Content><?ACE 18?></Content>`;
        if (part.kind === "head" && part.source !== "book-title") {
          const name = variableOf(part.source);
          return `${sep}<TextVariableInstance Self="${id("tv")}" Name="${escapeXml(name)}" ResultText="${escapeXml(part.text)}" AssociatedTextVariable="dTextVariablen${escapeXml(name)}"/>`;
        }
        return `${sep}<Content>${escapeXml(part.text)}</Content>`;
      })
      .join("");
  const markFrame = (m: PageMark, tx: number, ty: number) => {
    const s = m.size;
    const sid = id("un");
    let x: number;
    let y: number;
    let w: number;
    let h: number;
    if (m.vertical) {
      // 小口の縦書きの柱：字の中心 x、版面の天から置ける長さまで。
      w = s * 1.5;
      h = m.height ?? s * 20;
      x = m.x - w / 2;
      y = m.y;
    } else {
      const chars = m.parts.reduce((sum, part) => sum + (part.kind === "nombre" ? 4 : [...part.text].length + 1), 0);
      w = Math.min(W * 0.8, Math.max(20 * MM, s * (chars + 4)));
      h = s * 1.5;
      x = m.align === "left" ? m.x : m.align === "right" ? m.x - w : m.x - w / 2;
      // 横組みの1行目のベースラインは、だいたい字の大きさの 0.88 下（InDesign の既定の「仮想ボディの上」）。
      y = m.y - s * 0.88;
    }
    const just = m.vertical || m.align === "left" ? "LeftAlign" : m.align === "right" ? "RightAlign" : "CenterAlign";
    markStories.push({
      id: sid,
      xml: `<idPkg:Story ${NS} DOMVersion="${DOM}"><Story Self="${sid}" AppliedTOCStyle="n" TrackChanges="false" StoryTitle="$ID/" AppliedNamedGrid="n"><StoryPreference OpticalMarginAlignment="false" OpticalMarginSize="12" FrameType="TextFrameType" StoryOrientation="${m.vertical ? "Vertical" : "Horizontal"}" StoryDirection="LeftToRightDirection"/><ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/$ID/NormalParagraphStyle" Justification="${just}"><CharacterStyleRange AppliedCharacterStyle="${NO_CHAR}" PointSize="${n(s)}"${attr("FillColor", swatchOf(m.color))}>${markContent(m)}</CharacterStyleRange></ParagraphStyleRange></Story></idPkg:Story>`,
    });
    return `<TextFrame Self="${id("nf")}" ParentStory="${sid}" PreviousTextFrame="n" NextTextFrame="n" ContentType="TextType" ItemLayer="uL" Locked="false" ItemTransform="1 0 0 1 0 0"><Properties>${pathOf(tx + x, ty + y, w, h)}</Properties><TextFramePreference TextColumnCount="1"/></TextFrame>`;
  };
  /** そのマスターを当てるページのうち、左（右）ページで最初のものの柱・ノンブル・付記。 */
  const sample = (master: string, left: boolean) => {
    for (let i = 0; i < pageCount; i++) if (isLeft(i) === left && masterOf(i) === master) return marksOf(i);
    return [];
  };
  // マスターのページは、読む順（右綴じは右ページから）に並べる。位置は左ページがノドの左。
  const masterPage = (self: string, name: string, tx: number, sideIndex: number) =>
    `<Page Self="${self}" Name="${name}" OverrideList="" TabOrder="" GridStartingPoint="TopOutside" UseMasterGrid="true" GeometricBounds="0 0 ${n(H)} ${n(W)}" ItemTransform="1 0 0 1 ${n(tx)} ${n(-H / 2)}" MasterPageTransform="1 0 0 1 0 0"><Properties><PageColor type="enumeration">UseMasterColor</PageColor></Properties>${margin(sideIndex)}</Page>`;
  // 左ページになるページ番号の例（版面の位置を決めるのに使う）：右綴じは奇数、左綴じは偶数。
  const leftIndex = isLeft(0) ? 0 : 1;
  const rightIndex = 1 - leftIndex;
  const masterSpread = (self: string, prefix: string, base: string) => {
    const left = masterPage(`${self}p1`, "L", -W, leftIndex);
    const right = masterPage(`${self}p2`, "R", 0, rightIndex);
    const pagesXml = vertical ? right + left : left + right;
    const items = [...sample(self, true).map((m) => markFrame(m, -W, -H / 2)), ...sample(self, false).map((m) => markFrame(m, 0, -H / 2))].join("");
    return { self, xml: `<idPkg:MasterSpread ${NS} DOMVersion="${DOM}"><MasterSpread Self="${self}" ItemTransform="1 0 0 1 0 0" OverriddenPageItemProps="" Name="${prefix}-${base}" NamePrefix="${prefix}" BaseName="${base}" ShowMasterItems="true" PageCount="2">${pagesXml}${items}</MasterSpread></idPkg:MasterSpread>` };
  };
  const hasOpening = Array.from({ length: pageCount }, (_, i) => masterOf(i)).includes("uo");
  const masterSpreads = [masterSpread("um", "A", "本文"), masterSpread("un", "B", "柱・ノンブルなし"), ...(hasOpening ? [masterSpread("uo", "C", "章の始まり")] : [])];
  // テキスト変数（柱）：その見出しの段落スタイルの、ページの最後の段落（なければ前のページから続く）の字。
  const textVariables = [...variables.values()]
    .map(
      (v) =>
        `<TextVariable Self="dTextVariablen${escapeXml(v.name)}" Name="${escapeXml(v.name)}" VariableType="MatchParagraphStyleType"><MatchParagraphStylePreference TextBefore="" TextAfter="" AppliedParagraphStyle="${escapeXml(paraSelf(paragraphNames.has(v.style) ? v.style : "本文"))}" SearchStrategy="LastOnPage" ChangeCase="None" DeleteEndPunctuation="false"/></TextVariable>`,
    )
    .join("");

  // 索引：本文の語の所に置いた項目の一覧（InDesign の索引パネルで「索引を生成」すると作り直せる）。
  const indexXml =
    topics.size > 0 ? `<Index Self="di">${[...topics.values()].map((t) => `<Topic Self="${t.self}" SortOrder="${escapeXml(t.reading)}" Name="${escapeXml(t.term)}"/>`).join("")}</Index>` : "";

  // ---- セクション（ページ番号の付け方）----
  const numerals = settings.nombreStyle.numerals === "kanji" ? "Kanji" : settings.nombreStyle.numerals === "fullwidth" ? "FullWidthArabic" : "Arabic";
  const front = settings.nombreStyle.front;
  const bodyStart = opts.bodyStart !== undefined && opts.bodyStart > 0 && opts.bodyStart < pageCount && front !== "continue" ? opts.bodyStart : 0;
  const sections =
    bodyStart > 0
      ? `<Section Self="sec1" Length="${bodyStart}" Name="" ContinueNumbering="false" IncludeSectionPrefix="false" PageNumberStyle="${front === "roman-upper" ? "UpperRoman" : "LowerRoman"}" PageStart="p1" SectionPrefix="" PageNumberStart="1"/><Section Self="sec2" Length="${pageCount - bodyStart}" Name="" ContinueNumbering="false" IncludeSectionPrefix="false" PageNumberStyle="${numerals}" PageStart="p${bodyStart + 1}" SectionPrefix="" PageNumberStart="${spec.firstPageNumber}"/>`
      : `<Section Self="sec1" Length="${pageCount}" Name="" ContinueNumbering="false" IncludeSectionPrefix="false" PageNumberStyle="${numerals}" PageStart="p1" SectionPrefix="" PageNumberStart="${spec.firstPageNumber}"/>`;

  // ---- まとめる ----
  const orientation = `<StoryPreference OpticalMarginAlignment="false" OpticalMarginSize="12" FrameType="TextFrameType" StoryOrientation="${vertical ? "Vertical" : "Horizontal"}" StoryDirection="LeftToRightDirection"/>`;
  const story = `<idPkg:Story ${NS} DOMVersion="${DOM}"><Story Self="${storyId}" AppliedTOCStyle="n" TrackChanges="false" StoryTitle="$ID/" AppliedNamedGrid="n">${orientation}<InCopyExportOption IncludeGraphicProxies="true" IncludeAllResources="false"/>\n${fixedBody}\n</Story></idPkg:Story>`;
  // Kolophon で読み込み直したときに元の原稿に戻すための控え（InDesign は META-INF の中の知らないファイルを使わない）。
  const hint: KolophonHint = {
    app: "Kolophon",
    version: 1,
    fingerprint: storyFingerprint(findAll(parseXml(story), "Story")[0]),
    text,
    settings,
    spots: Object.fromEntries(spots.map((sp) => [sp.name, sp.color.toLowerCase()])),
    links: Object.fromEntries([...linkFiles.values()].map((l) => [l.path.split(/[\\/]/).pop()!, l.img.name])),
    notes: noteNo > 0,
  };
  const bleed = n(settings.advanced.bleedMm * MM);
  // ページ数は 1 にする：InDesign は PagesPerDocument の数だけ白いページを先に作り、そのあとに Spreads のページを足す（#1）。
  const preferences = `<idPkg:Preferences ${NS} DOMVersion="${DOM}"><DocumentPreference PageHeight="${n(H)}" PageWidth="${n(W)}" PagesPerDocument="1" FacingPages="true" DocumentBleedTopOffset="${bleed}" DocumentBleedBottomOffset="${bleed}" DocumentBleedInsideOrLeftOffset="${bleed}" DocumentBleedOutsideOrRightOffset="${bleed}" DocumentBleedUniformSize="true" PageBinding="${vertical ? "RightToLeft" : "LeftToRight"}" ColumnDirection="${vertical ? "Vertical" : "Horizontal"}" AllowPageShuffle="true" Intent="PrintIntent"/>${margin(0)}${orientation}</idPkg:Preferences>`;
  const processInks = [
    ["Process Cyan", 75, 0.61, 1],
    ["Process Magenta", 15, 0.76, 2],
    ["Process Yellow", 0, 0.16, 3],
    ["Process Black", 45, 1.7, 4],
  ]
    .map(([name, angle, density, order]) => `<Ink Self="Ink/$ID/${name}" Name="$ID/${name}" Angle="${angle}" ConvertToProcess="false" Frequency="70" NeutralDensity="${density}" PrintInk="true" TrapOrder="${order}" InkType="Normal"/>`)
    .join("");
  // 色はスタイルと本文で使ったものを集めたあとで書く（ここまでで swatchOf が集めている）。
  const usedSpotInks = spots
    .filter((sp) => swatches.has(sp.color.toLowerCase()))
    .map((sp, k) => `<Ink Self="Ink/${escapeXml(selfName(sp.name))}" Name="${escapeXml(sp.name)}" Angle="45" ConvertToProcess="false" Frequency="70" NeutralDensity="1" PrintInk="true" TrapOrder="${5 + k}" InkType="Normal"/>`)
    .join("");
  const graphic = `<idPkg:Graphic ${NS} DOMVersion="${DOM}"><Color Self="Color/Black" Model="Process" Space="CMYK" ColorValue="0 0 0 100" ColorOverride="Specialblack" AlternateSpace="NoAlternateColor" AlternateColorValue="" Name="Black" ColorEditable="false" ColorRemovable="false" Visible="true" SwatchCreatorID="7937"/><Color Self="Color/Paper" Model="Process" Space="CMYK" ColorValue="0 0 0 0" ColorOverride="Specialpaper" AlternateSpace="NoAlternateColor" AlternateColorValue="" Name="Paper" ColorEditable="true" ColorRemovable="false" Visible="true" SwatchCreatorID="7937"/><Color Self="Color/Registration" Model="Registration" Space="CMYK" ColorValue="100 100 100 100" ColorOverride="Specialregistration" AlternateSpace="NoAlternateColor" AlternateColorValue="" Name="Registration" ColorEditable="false" ColorRemovable="false" Visible="true" SwatchCreatorID="7937"/>${colorXml.join("")}${processInks}${usedSpotInks}<Swatch Self="Swatch/None" Name="None" ColorEditable="false" ColorRemovable="false" Visible="true" SwatchCreatorID="7937"/><StrokeStyle Self="StrokeStyle/$ID/Solid" Name="$ID/Solid"/><StrokeStyle Self="StrokeStyle/$ID/ThinThin" Name="$ID/ThinThin"/><StrokeStyle Self="StrokeStyle/$ID/Dotted" Name="$ID/Dotted"/><StrokeStyle Self="StrokeStyle/$ID/Dashed" Name="$ID/Dashed"/></idPkg:Graphic>`;
  const styles = `<idPkg:Styles ${NS} DOMVersion="${DOM}"><RootCharacterStyleGroup Self="uc"><CharacterStyle Self="${NO_CHAR}" Imported="false" Name="$ID/[No character style]"/>${characterStyles.join("")}</RootCharacterStyleGroup><RootParagraphStyleGroup Self="up"><ParagraphStyle Self="${NO_PARA}" Name="$ID/[No paragraph style]" Imported="false" NextStyle="${NO_PARA}" KeyboardShortcut="0 0"${attr("PointSize", n(size))}><Properties><Leading type="unit">${n(pitch)}</Leading>${bodyFont.family ? `<AppliedFont type="string">${escapeXml(bodyFont.family)}</AppliedFont>` : ""}</Properties></ParagraphStyle><ParagraphStyle Self="ParagraphStyle/$ID/NormalParagraphStyle" Name="$ID/NormalParagraphStyle" Imported="false" NextStyle="ParagraphStyle/$ID/NormalParagraphStyle" KeyboardShortcut="0 0"><Properties><BasedOn type="string">$ID/[No paragraph style]</BasedOn></Properties></ParagraphStyle>${paragraphStyles.join("")}</RootParagraphStyleGroup><RootCellStyleGroup Self="ucs"><CellStyle Self="CellStyle/$ID/[None]" Name="$ID/[None]"/></RootCellStyleGroup><RootTableStyleGroup Self="uts"><TableStyle Self="TableStyle/$ID/[Basic Table]" Name="$ID/[Basic Table]"/></RootTableStyleGroup>${tocStyleXml}</idPkg:Styles>`;
  const fonts = `<idPkg:Fonts ${NS} DOMVersion="${DOM}">${[...fontXml.values()].join("")}</idPkg:Fonts>`;
  const tags = `<idPkg:Tags ${NS} DOMVersion="${DOM}"><XMLTag Self="XMLTag/Root" Name="Root"><Properties><TagColor type="enumeration">LightBlue</TagColor></Properties></XMLTag></idPkg:Tags>`;
  const backing = `<idPkg:BackingStory ${NS} DOMVersion="${DOM}"><XmlStory Self="ub" AppliedTOCStyle="n" TrackChanges="false" StoryTitle="$ID/" AppliedNamedGrid="n"><ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/$ID/NormalParagraphStyle"><CharacterStyleRange AppliedCharacterStyle="${NO_CHAR}"/></ParagraphStyleRange></XmlStory></idPkg:BackingStory>`;
  const designmap = `<?aid style="50" type="document" readerVersion="6.0" featureSet="257" product="${DOM}(0)" ?>
<Document ${NS} DOMVersion="${DOM}" Self="d" StoryList="${[storyId, ...markStories.map((st) => st.id), "ub"].join(" ")}" ZeroPoint="0 0" ActiveLayer="uL" CMYKProfile="Japan Color 2001 Coated" RGBProfile="sRGB IEC61966-2.1" SolidColorIntent="UseColorSettings" AfterBlendingIntent="UseColorSettings" DefaultImageIntent="UseColorSettings" RGBPolicy="PreserveEmbeddedProfiles" CMYKPolicy="CombinationOfPreserveAndSafeCmyk" AccurateLABSpots="false"><idPkg:Graphic src="Resources/Graphic.xml"/><idPkg:Fonts src="Resources/Fonts.xml"/><idPkg:Styles src="Resources/Styles.xml"/><idPkg:Preferences src="Resources/Preferences.xml"/><idPkg:Tags src="XML/Tags.xml"/><Layer Self="uL" Name="レイヤー 1" Visible="true" Locked="false" IgnoreWrap="false" ShowGuides="true" LockGuides="false" UI="true" Expendable="true" Printable="true"><Properties><LayerColor type="enumeration">LightBlue</LayerColor></Properties></Layer>${masterSpreads.map((m) => `<idPkg:MasterSpread src="MasterSpreads/MasterSpread_${m.self}.xml"/>`).join("")}${spreadFiles.map((f) => `<idPkg:Spread src="${f.name}"/>`).join("")}${sections}${textVariables}${indexXml}<idPkg:BackingStory src="XML/BackingStory.xml"/><idPkg:Story src="Stories/Story_${storyId}.xml"/>${markStories.map((st) => `<idPkg:Story src="Stories/Story_${st.id}.xml"/>`).join("")}</Document>`;
  return {
    files: [
      { name: "mimetype", data: new TextEncoder().encode("application/vnd.adobe.indesign-idml-package") },
      {
        name: "META-INF/container.xml",
        data: xmlFile(`<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="designmap.xml" media-type="text/xml"/></rootfiles></container>`),
      },
      { name: "META-INF/kolophon.json", data: new TextEncoder().encode(JSON.stringify(hint)) },
      { name: "designmap.xml", data: xmlFile(designmap) },
      { name: "Resources/Graphic.xml", data: xmlFile(graphic) },
      { name: "Resources/Fonts.xml", data: xmlFile(fonts) },
      { name: "Resources/Styles.xml", data: xmlFile(styles) },
      { name: "Resources/Preferences.xml", data: xmlFile(preferences) },
      { name: "XML/Tags.xml", data: xmlFile(tags) },
      { name: "XML/BackingStory.xml", data: xmlFile(backing) },
      ...masterSpreads.map((m) => ({ name: `MasterSpreads/MasterSpread_${m.self}.xml`, data: xmlFile(m.xml) })),
      ...spreadFiles,
      { name: `Stories/Story_${storyId}.xml`, data: xmlFile(story) },
      ...markStories.map((st) => ({ name: `Stories/Story_${st.id}.xml`, data: xmlFile(st.xml) })),
    ],
    links: [...linkFiles.values()].map((l) => ({ path: l.path, data: l.data })),
    skipped: [...skipped],
  };
}
