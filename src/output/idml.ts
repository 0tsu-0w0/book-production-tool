import { horizontalPunctuation, leftBound, spotInks, toFormatOptions, toLayoutSpec, toParseOptions, type FontChoice, type Settings, type SpotColor } from "../document/settings.js";
import { NOTE_STYLE, hasDecoration, type CharacterStyle, type GlyphForm, type ParagraphStyle } from "../document/styles.js";
import { escapeXml } from "../document/xml.js";
import { bookPageBlocks } from "../engine/book-pages.js";
import { formatText } from "../engine/format.js";
import { hexToCmyk } from "../engine/ink-color.js";
import { KENTEN_MARKS, parse } from "../engine/parse.js";
import { texToMarkup } from "../engine/tex.js";
import type { Atom, Block } from "../engine/types.js";
import { expandXrefs } from "../engine/xref.js";

// IDML（InDesign Markup Language）の書き出し。InDesign の受け渡し用の形式で、InDesign で開くと文書になる。
// 入れるもの：判型・綴じ方向・組み方向、ページと版面（テキストフレームを1ページに1つ、つないで流す）、
// 段落スタイル・文字スタイル（大きさ・行送り・字下げ・揃え・前後の空き・色・字間・長体平体・字形・
// ドロップキャップ・先頭文字スタイル・正規表現スタイル・行スタイル）、色（CMYK・特色・特色の濃さ）、
// 本文（ルビ・圏点・傍線・縦中横・割注・字間・カーニング・改ページ・改丁）、注（章末か巻末の段落）、
// ページ番号の参照・相互参照（Kolophon で組んだページ番号の字）。
// 入れないもの（書き出しの結果で知らせる）：画像・表の罫・目次・索引・柱とノンブル・段落の罫線と網掛け・数式の形。
// InDesign は受け取った文章を自分で組み直すので、行の分かれ目とページの区切りは Kolophon と同じにはならない。

export interface IdmlFile {
  name: string;
  data: Uint8Array;
}

export interface IdmlOptions {
  /** テキストフレームを置くページ数（Kolophon で組んだページ数）。 */
  pageCount: number;
  /** ラベルのあるページの番号（［＃ページ：名前］に入れる字）。 */
  pageOf?: (label: string) => string | undefined;
  /** 書体の名前（ファミリーとスタイル）。分からなければ書体を指定しない（InDesign の既定の書体）。 */
  fontName?: (f: FontChoice | null) => { family: string; style: string; postscriptName?: string; cff?: boolean } | undefined;
}

export interface IdmlResult {
  files: IdmlFile[];
  /** 書き出さなかったもの（知らせる）。 */
  skipped: string[];
}

const DOM = "16.0";
const NS = 'xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"';
const MM = 72 / 25.4;
const NO_PARA = "ParagraphStyle/$ID/[No paragraph style]";
const NO_CHAR = "CharacterStyle/$ID/[No character style]";

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
    if (hasDecoration(p.decoration)) skipped.add("段落の罫線・網掛け");
    const props = [
      `<BasedOn type="string">$ID/[No paragraph style]</BasedOn>`,
      `<Leading type="unit">${n(leading)}</Leading>`,
      font.family ? `<AppliedFont type="string">${escapeXml(font.family)}</AppliedFont>` : "",
      listItems("AllNestedStyles", nested),
      listItems("AllGREPStyles", grep),
      listItems("AllLineStyles", lines),
    ].join("");
    return `<ParagraphStyle${attr("Self", paraSelf(p.name))}${attr("Name", p.name)} Imported="false"${attr("NextStyle", paraSelf(p.name))} KeyboardShortcut="0 0"${attr("PointSize", n(pointSize))}${attr("FontStyle", font.style)}${attr("Justification", justification(p))}${p.indent ? attr("LeftIndent", n(p.indent * pointSize)) : ""}${p.spaceBefore ? attr("SpaceBefore", n(p.spaceBefore * pitch)) : ""}${p.spaceAfter ? attr("SpaceAfter", n(p.spaceAfter * pitch)) : ""}${attr("FillColor", swatchOf(p.color ?? settings.textColor))}${p.tracking ? attr("Tracking", p.tracking) : ""}${p.deform === "condensed" ? attr("HorizontalScale", p.deformRatio) : ""}${p.deform === "flat" ? attr("VerticalScale", p.deformRatio) : ""}${p.proportional ? ' OTFProportionalMetrics="true"' : ""}${attr("GlyphForm", GLYPH_FORMS[p.glyphForm])}${p.keepWithNext ? ' KeepWithNext="1"' : ""}${p.keepLines ? ' KeepLinesTogether="true" KeepFirstLines="2" KeepLastLines="2"' : ""}${p.dropCap.lines >= 2 ? attr("DropCapLines", p.dropCap.lines) + attr("DropCapCharacters", p.dropCap.chars) : ""}><Properties>${props}</Properties></ParagraphStyle>`;
  };
  const paragraphStyles = settings.styles.paragraph.map(paraStyleXml);
  const characterStyles = settings.styles.character.map(charStyleXml);

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
  const runs = (atoms: Atom[], lineStyle?: string): string[] => {
    const out: { key: string; open: string; text: string }[] = [];
    for (const a of atoms) {
      if (a.leader) continue;
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
        (a.ruby ? ` RubyFlag="true"${attr("RubyString", a.ruby.replace(/[|｜]/g, ""))} RubyType="GroupRuby"` : "") +
        (a.kenten ? attr("KentenKind", KENTEN_KINDS[a.kenten] ?? "KentenSesameDot") : "") +
        (a.sideline ? ' Underline="true"' : "") +
        (vertical && first?.tcy && a.pageRef === undefined && !a.note ? ' Tatechuyoko="true"' : "") +
        (a.warichu !== undefined ? ' Warichu="true"' : "") +
        (tracking !== undefined ? attr("Tracking", tracking) : "") +
        (kern ? ` KerningMethod="$ID/Manual"${attr("KerningValue", kern)}` : "");
      const open = `<CharacterStyleRange${attr("AppliedCharacterStyle", style ? charSelf(style) : NO_CHAR)}${local}>`;
      const text = a.note ? `注${noteNo}` : atomText(a);
      // ルビ・割注・カーニングのある字は、それだけで1つの並びにする（隣と混ざらないように）。
      const key = a.ruby || a.warichu !== undefined || kern ? `${open}\u0000${out.length}` : open;
      const prev = out[out.length - 1];
      if (prev && prev.key === key) prev.text += text;
      else out.push({ key, open, text });
    }
    return out.map((r) => `${r.open}<Content>${escapeXml(r.text)}</Content>`);
  };
  const paragraph = (styleName: string, atoms: Atom[], lineStyle?: string) => {
    const parts = runs(atoms, lineStyle);
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
          skipped.add("目次（InDesign の目次の機能で作り直してください）");
          break;
        case "indexpage":
          skipped.add("索引");
          break;
        case "image":
          skipped.add("画像（置き場所に［画像：名前］の字を入れた）");
          paragraph("本文", [...`［画像：${b.name}］`].map((ch) => ({ cells: [{ text: ch }] })));
          break;
        case "table":
          skipped.add("表の罫（表は欄を全角の空白で区切った段落にした）");
          for (const row of b.rows) {
            const atoms: Atom[] = [];
            row.cells.forEach((cell, i) => {
              if (i > 0) atoms.push({ cells: [{ text: "　" }] });
              atoms.push(...cell.atoms);
            });
            paragraph(b.rows.indexOf(row) < b.header ? "表の見出し" : "表", atoms);
          }
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
  // 表の段落スタイルがなければ本文にする。
  const fixedBody = storyBody.replace(/AppliedParagraphStyle="ParagraphStyle\/(表の見出し|表)"/g, (m, name: string) => (paragraphNames.has(name) ? m : `AppliedParagraphStyle="${paraSelf("本文")}"`));

  // ---- ページと版面 ----
  const W = spec.pageWidthMm * MM;
  const H = spec.pageHeightMm * MM;
  const pageCount = Math.max(1, opts.pageCount);
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
  const storyId = "u1";
  const frameId = (i: number) => `tf${i + 1}`;
  const margin = (i: number) => {
    const a = textArea(i);
    // ページの段は1つ（段組みはテキストフレームの段で表す）。ColumnsPositions は段の始まりと終わりの組。
    return `<MarginPreference ColumnCount="1" ColumnGutter="${n(spec.columnGapPt || 12)}" Top="${n(a.y)}" Bottom="${n(H - a.y - a.h)}" Left="${n(a.x)}" Right="${n(W - a.x - a.w)}" ColumnDirection="${vertical ? "Vertical" : "Horizontal"}" ColumnsPositions="0 ${n(vertical ? a.h : a.w)}"/>`;
  };
  const spreadFiles = spreads.map((pages, si) => {
    const body = pages
      .map((i) => {
        const tx = isLeft(i) ? -W : 0;
        const ty = -H / 2;
        const a = textArea(i);
        const [x1, y1, x2, y2] = [tx + a.x, ty + a.y, tx + a.x + a.w, ty + a.y + a.h];
        const pt = (x: number, y: number) => `<PathPointType Anchor="${n(x)} ${n(y)}" LeftDirection="${n(x)} ${n(y)}" RightDirection="${n(x)} ${n(y)}"/>`;
        const page = `<Page Self="p${i + 1}" Name="${spec.firstPageNumber + i}" AppliedMaster="um" OverrideList="" TabOrder="" GridStartingPoint="TopOutside" UseMasterGrid="true" GeometricBounds="0 0 ${n(H)} ${n(W)}" ItemTransform="1 0 0 1 ${n(tx)} ${n(ty)}" MasterPageTransform="1 0 0 1 0 0"><Properties><PageColor type="enumeration">UseMasterColor</PageColor></Properties>${margin(i)}</Page>`;
        const frame = `<TextFrame Self="${frameId(i)}" ParentStory="${storyId}" PreviousTextFrame="${i > 0 ? frameId(i - 1) : "n"}" NextTextFrame="${i < pageCount - 1 ? frameId(i + 1) : "n"}" ContentType="TextType" ItemLayer="uL" Locked="false" ItemTransform="1 0 0 1 0 0"><Properties><PathGeometry><GeometryPathType PathOpen="false"><PathPointArray>${pt(x1, y1)}${pt(x1, y2)}${pt(x2, y2)}${pt(x2, y1)}</PathPointArray></GeometryPathType></PathGeometry></Properties><TextFramePreference TextColumnCount="${spec.columns}" TextColumnGutter="${n(spec.columnGapPt || 12)}"/></TextFrame>`;
        return { page, frame };
      });
    // 綴じの位置：見開きの中で何ページ目のあとにノドがあるか。
    const binding = pages.length === 2 ? 1 : isLeft(pages[0]) ? 1 : 0;
    const xml = `<idPkg:Spread ${NS} DOMVersion="${DOM}"><Spread Self="s${si + 1}" PageTransitionType="None" PageTransitionDirection="NotApplicable" PageTransitionDuration="Medium" ShowMasterItems="true" PageCount="${pages.length}" BindingLocation="${binding}" AllowPageShuffle="true" ItemTransform="1 0 0 1 0 0" FlattenerOverride="Default">${body.map((b) => b.page).join("")}${body.map((b) => b.frame).join("")}</Spread></idPkg:Spread>`;
    return { name: `Spreads/Spread_s${si + 1}.xml`, data: xmlFile(xml) };
  });
  const masterPage = (self: string, name: string, tx: number) =>
    `<Page Self="${self}" Name="${name}" OverrideList="" TabOrder="" GridStartingPoint="TopOutside" UseMasterGrid="true" GeometricBounds="0 0 ${n(H)} ${n(W)}" ItemTransform="1 0 0 1 ${n(tx)} ${n(-H / 2)}" MasterPageTransform="1 0 0 1 0 0"><Properties><PageColor type="enumeration">UseMasterColor</PageColor></Properties>${margin(vertical ? (tx < 0 ? 0 : 1) : tx < 0 ? 1 : 0)}</Page>`;
  const master = `<idPkg:MasterSpread ${NS} DOMVersion="${DOM}"><MasterSpread Self="um" ItemTransform="1 0 0 1 0 0" OverriddenPageItemProps="" Name="A-マスター" NamePrefix="A" BaseName="マスター" ShowMasterItems="true" PageCount="2">${masterPage("ump1", "L", -W)}${masterPage("ump2", "R", 0)}</MasterSpread></idPkg:MasterSpread>`;

  // ---- まとめる ----
  const orientation = `<StoryPreference OpticalMarginAlignment="false" OpticalMarginSize="12" FrameType="TextFrameType" StoryOrientation="${vertical ? "Vertical" : "Horizontal"}" StoryDirection="LeftToRightDirection"/>`;
  const story = `<idPkg:Story ${NS} DOMVersion="${DOM}"><Story Self="${storyId}" AppliedTOCStyle="n" TrackChanges="false" StoryTitle="$ID/" AppliedNamedGrid="n">${orientation}<InCopyExportOption IncludeGraphicProxies="true" IncludeAllResources="false"/>\n${fixedBody}\n</Story></idPkg:Story>`;
  const bleed = n(settings.advanced.bleedMm * MM);
  const preferences = `<idPkg:Preferences ${NS} DOMVersion="${DOM}"><DocumentPreference PageHeight="${n(H)}" PageWidth="${n(W)}" PagesPerDocument="${pageCount}" FacingPages="true" DocumentBleedTopOffset="${bleed}" DocumentBleedBottomOffset="${bleed}" DocumentBleedInsideOrLeftOffset="${bleed}" DocumentBleedOutsideOrRightOffset="${bleed}" DocumentBleedUniformSize="true" PageBinding="${vertical ? "RightToLeft" : "LeftToRight"}" ColumnDirection="${vertical ? "Vertical" : "Horizontal"}" AllowPageShuffle="true" Intent="PrintIntent"/>${margin(0)}${orientation}</idPkg:Preferences>`;
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
  const graphic = `<idPkg:Graphic ${NS} DOMVersion="${DOM}"><Color Self="Color/Black" Model="Process" Space="CMYK" ColorValue="0 0 0 100" ColorOverride="Specialblack" AlternateSpace="NoAlternateColor" AlternateColorValue="" Name="Black" ColorEditable="false" ColorRemovable="false" Visible="true" SwatchCreatorID="7937"/><Color Self="Color/Paper" Model="Process" Space="CMYK" ColorValue="0 0 0 0" ColorOverride="Specialpaper" AlternateSpace="NoAlternateColor" AlternateColorValue="" Name="Paper" ColorEditable="true" ColorRemovable="false" Visible="true" SwatchCreatorID="7937"/><Color Self="Color/Registration" Model="Registration" Space="CMYK" ColorValue="100 100 100 100" ColorOverride="Specialregistration" AlternateSpace="NoAlternateColor" AlternateColorValue="" Name="Registration" ColorEditable="false" ColorRemovable="false" Visible="true" SwatchCreatorID="7937"/>${colorXml.join("")}${processInks}${usedSpotInks}<Swatch Self="Swatch/None" Name="None" ColorEditable="false" ColorRemovable="false" Visible="true" SwatchCreatorID="7937"/></idPkg:Graphic>`;
  const styles = `<idPkg:Styles ${NS} DOMVersion="${DOM}"><RootCharacterStyleGroup Self="uc"><CharacterStyle Self="${NO_CHAR}" Imported="false" Name="$ID/[No character style]"/>${characterStyles.join("")}</RootCharacterStyleGroup><RootParagraphStyleGroup Self="up"><ParagraphStyle Self="${NO_PARA}" Name="$ID/[No paragraph style]" Imported="false" NextStyle="${NO_PARA}" KeyboardShortcut="0 0"${attr("PointSize", n(size))}><Properties><Leading type="unit">${n(pitch)}</Leading>${bodyFont.family ? `<AppliedFont type="string">${escapeXml(bodyFont.family)}</AppliedFont>` : ""}</Properties></ParagraphStyle><ParagraphStyle Self="ParagraphStyle/$ID/NormalParagraphStyle" Name="$ID/NormalParagraphStyle" Imported="false" NextStyle="ParagraphStyle/$ID/NormalParagraphStyle" KeyboardShortcut="0 0"><Properties><BasedOn type="string">$ID/[No paragraph style]</BasedOn></Properties></ParagraphStyle>${paragraphStyles.join("")}</RootParagraphStyleGroup></idPkg:Styles>`;
  const fonts = `<idPkg:Fonts ${NS} DOMVersion="${DOM}">${[...fontXml.values()].join("")}</idPkg:Fonts>`;
  const tags = `<idPkg:Tags ${NS} DOMVersion="${DOM}"><XMLTag Self="XMLTag/Root" Name="Root"><Properties><TagColor type="enumeration">LightBlue</TagColor></Properties></XMLTag></idPkg:Tags>`;
  const backing = `<idPkg:BackingStory ${NS} DOMVersion="${DOM}"><XmlStory Self="ub" AppliedTOCStyle="n" TrackChanges="false" StoryTitle="$ID/" AppliedNamedGrid="n"><ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/$ID/NormalParagraphStyle"><CharacterStyleRange AppliedCharacterStyle="${NO_CHAR}"/></ParagraphStyleRange></XmlStory></idPkg:BackingStory>`;
  const designmap = `<?aid style="50" type="document" readerVersion="6.0" featureSet="257" product="${DOM}(0)" ?>
<Document ${NS} DOMVersion="${DOM}" Self="d" StoryList="${storyId} ub" ZeroPoint="0 0" ActiveLayer="uL" CMYKProfile="Japan Color 2001 Coated" RGBProfile="sRGB IEC61966-2.1" SolidColorIntent="UseColorSettings" AfterBlendingIntent="UseColorSettings" DefaultImageIntent="UseColorSettings" RGBPolicy="PreserveEmbeddedProfiles" CMYKPolicy="CombinationOfPreserveAndSafeCmyk" AccurateLABSpots="false"><idPkg:Graphic src="Resources/Graphic.xml"/><idPkg:Fonts src="Resources/Fonts.xml"/><idPkg:Styles src="Resources/Styles.xml"/><idPkg:Preferences src="Resources/Preferences.xml"/><idPkg:Tags src="XML/Tags.xml"/><Layer Self="uL" Name="レイヤー 1" Visible="true" Locked="false" IgnoreWrap="false" ShowGuides="true" LockGuides="false" UI="true" Expendable="true" Printable="true"><Properties><LayerColor type="enumeration">LightBlue</LayerColor></Properties></Layer><idPkg:MasterSpread src="MasterSpreads/MasterSpread_um.xml"/>${spreadFiles.map((f) => `<idPkg:Spread src="${f.name}"/>`).join("")}<Section Self="sec1" Length="${pageCount}" Name="" ContinueNumbering="false" IncludeSectionPrefix="false" PageNumberStyle="Arabic" PageStart="p1" SectionPrefix="" PageNumberStart="${spec.firstPageNumber}"/><idPkg:BackingStory src="XML/BackingStory.xml"/><idPkg:Story src="Stories/Story_${storyId}.xml"/></Document>`;
  return {
    files: [
      { name: "mimetype", data: new TextEncoder().encode("application/vnd.adobe.indesign-idml-package") },
      {
        name: "META-INF/container.xml",
        data: xmlFile(`<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="designmap.xml" media-type="text/xml"/></rootfiles></container>`),
      },
      { name: "designmap.xml", data: xmlFile(designmap) },
      { name: "Resources/Graphic.xml", data: xmlFile(graphic) },
      { name: "Resources/Fonts.xml", data: xmlFile(fonts) },
      { name: "Resources/Styles.xml", data: xmlFile(styles) },
      { name: "Resources/Preferences.xml", data: xmlFile(preferences) },
      { name: "XML/Tags.xml", data: xmlFile(tags) },
      { name: "XML/BackingStory.xml", data: xmlFile(backing) },
      { name: "MasterSpreads/MasterSpread_um.xml", data: xmlFile(master) },
      ...spreadFiles,
      { name: `Stories/Story_${storyId}.xml`, data: xmlFile(story) },
    ],
    skipped: [...skipped],
  };
}
