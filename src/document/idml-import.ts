import { cmykToRgb } from "../engine/ink-color.js";
import { readZip } from "../output/zip.js";
import { DEFAULT_SETTINGS, FREE_TRIM, normalizeSettings, tintHex, type Settings, type SpotColor } from "./settings.js";
import { DEFAULT_STYLES, newCharacterStyle, newParagraphStyle, type CharacterStyle, type GlyphForm, type NestedStyle, type ParagraphStyle } from "./styles.js";
import { childElements, findAll, parseXml, type XmlElement, type XmlNode } from "./xml.js";

// IDML（InDesign の受け渡し用の形式）の読み込み。InDesign で「IDML として書き出し」したファイルから、
// 文章（流れの順）・段落スタイル・文字スタイル・色・判型と版面・組み方向を Kolophon の文書にする。
// 文章は Kolophon の記法にする：段落スタイルは行頭の［＃名前］（大見出し・中見出しは ＃・＃＃）、文字スタイルは［＃名前］…［＃／名前］、
// ルビ・圏点・傍線・縦中横・割注・字間・改ページ（改丁）・注・表。
// 読まないもの（読み込みの結果で知らせる）：画像・図形・マスターページの中身（柱・ノンブル）・テキストフレームの細かな置き方。

export interface IdmlImport {
  text: string;
  settings: Settings;
  /** 書体の名前（ファミリー）。呼び出し側が PC の書体に読み替える。 */
  fonts: { body?: string; paragraph: Record<string, string>; character: Record<string, string> };
  /** 読み込めなかったもの（知らせる）。 */
  notes: string[];
}

const MM = 72 / 25.4;
const KENTEN_NAMES: Record<string, string> = {
  KentenSesameDot: "ゴマ",
  KentenWhiteSesameDot: "白ゴマ",
  KentenBlackCircle: "丸",
  KentenSmallBlackCircle: "丸",
  KentenWhiteCircle: "白丸",
  KentenSmallWhiteCircle: "白丸",
  KentenBullseye: "二重丸",
  KentenFishEye: "蛇の目",
  KentenBlackTriangle: "三角",
  KentenWhiteTriangle: "白三角",
};
const GLYPH_FORMS: Record<string, GlyphForm> = {
  JIS78Form: "jp78",
  JIS83Form: "jp83",
  JIS90Form: "jp90",
  JIS04Form: "jp04",
  NLCForm: "nlck",
  TraditionalForm: "trad",
  ExpertForm: "expt",
};

/** Self の名前（ParagraphStyle/本文 → 本文。%3a などを戻し、$ID/ を外す）。 */
function refName(ref: string): string {
  const slash = ref.indexOf("/");
  const raw = slash >= 0 ? ref.slice(slash + 1) : ref;
  return decodeURIComponentSafe(raw).replace(/^\$ID\//, "");
}
function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s.replace(/%(?![0-9a-fA-F]{2})/g, "%25"));
  } catch {
    return s;
  }
}

/** 既定の（スタイルのない）ことを表す名前か。 */
const isDefaultStyle = (name: string) => /^\[(No paragraph style|No character style|段落スタイルなし|なし)\]$/.test(name) || name === "";

/** 要素の属性と、Properties の中の値（BasedOn・Leading・AppliedFont など）を1つにする。 */
function propsOf(el: XmlElement): Record<string, string> {
  const out: Record<string, string> = { ...el.attrs };
  const props = childElements(el, "Properties")[0];
  if (props) for (const p of childElements(props)) if (!p.name.startsWith("All")) out[p.name] = p.children.filter((c): c is string => typeof c === "string").join("");
  return out;
}

/** リストの Properties（AllNestedStyles など）の各項目を、名前 → 値にする。 */
function listOf(el: XmlElement, name: string): Record<string, string>[] {
  const props = childElements(el, "Properties")[0];
  const list = props ? childElements(props, name)[0] : undefined;
  if (!list) return [];
  return childElements(list, "ListItem").map((item) => {
    const rec: Record<string, string> = {};
    for (const f of childElements(item)) rec[f.name] = f.children.filter((c): c is string => typeof c === "string").join("");
    // 区切りの字が「すべての字」などの決まった種類か（enumeration）。
    const delim = childElements(item, "Delimiter")[0];
    if (delim?.attrs.type === "enumeration") rec.DelimiterKind = rec.Delimiter;
    return rec;
  });
}

interface RawStyle {
  el: XmlElement;
  props: Record<string, string>;
}

/** スタイルの一覧（入れ子のグループの中も）。BasedOn をたどって値を足し合わせる。 */
function collectStyles(root: XmlElement | undefined, kind: "ParagraphStyle" | "CharacterStyle"): Map<string, RawStyle> {
  const raw = new Map<string, RawStyle>();
  if (!root) return raw;
  for (const el of findAll(root, kind)) raw.set(el.attrs.Self, { el, props: propsOf(el) });
  const resolved = new Map<string, RawStyle>();
  const resolve = (self: string, depth = 0): Record<string, string> => {
    const s = raw.get(self);
    if (!s) return {};
    const base = s.props.BasedOn;
    if (!base || depth > 20) return s.props;
    const baseSelf = base.startsWith(`${kind}/`) ? base : `${kind}/${base}`;
    return { ...resolve(baseSelf, depth + 1), ...s.props };
  };
  for (const [self, s] of raw) resolved.set(self, { el: s.el, props: resolve(self) });
  return resolved;
}

const num = (v: string | undefined) => {
  const x = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(x) ? x : undefined;
};

export function importIdml(bytes: Uint8Array): IdmlImport {
  const files = readZip(bytes);
  const xml = (name: string) => {
    const data = files.get(name);
    return data ? parseXml(new TextDecoder().decode(data)) : undefined;
  };
  const designmap = xml("designmap.xml");
  if (!designmap) throw new Error("IDML ではありません（designmap.xml がありません）。");
  const notes = new Set<string>();
  const srcOf = (name: string) => childElements(designmap, name).map((e) => e.attrs.src);

  // ---- 色 ----
  const colors = new Map<string, string>();
  const spots = new Map<string, SpotColor>();
  const hex2 = (v: number) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0");
  const toHex = (r: number, g: number, b: number) => `#${hex2(r)}${hex2(g)}${hex2(b)}`;
  const graphic = srcOf("idPkg:Graphic")[0] ? xml(srcOf("idPkg:Graphic")[0]) : undefined;
  if (graphic) {
    for (const c of findAll(graphic, "Color")) {
      const v = (c.attrs.ColorValue ?? "").split(/\s+/).map(Number);
      let hex: string;
      if (c.attrs.Space === "RGB" && v.length >= 3) hex = toHex(v[0], v[1], v[2]);
      else if (c.attrs.Space === "LAB" && v.length >= 1) hex = toHex((v[0] / 100) * 255, (v[0] / 100) * 255, (v[0] / 100) * 255);
      else if (v.length >= 4) hex = toHex(...cmykToRgb(v[0] / 100, v[1] / 100, v[2] / 100, v[3] / 100));
      else continue;
      if (c.attrs.Self === "Color/Paper") hex = "#ffffff";
      if (c.attrs.Model === "Spot" && v.length >= 4) {
        const name = c.attrs.Name ?? refName(c.attrs.Self);
        // 特色は画面の色で見分けるので、ほかの特色と同じ色なら少しずらす。
        while ([...spots.values()].some((s) => s.color === hex)) hex = toHex(parseInt(hex.slice(1, 3), 16) - 1, parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16));
        spots.set(c.attrs.Self, { name, color: hex, cmyk: [v[0], v[1], v[2], v[3]].map((x) => Math.round(x)) as SpotColor["cmyk"], overprint: false, tints: [] });
      }
      colors.set(c.attrs.Self, hex);
    }
    for (const t of findAll(graphic, "Tint")) {
      const base = t.attrs.BaseColor;
      const tint = Math.round(num(t.attrs.TintValue) ?? 100);
      const baseHex = colors.get(base);
      if (!baseHex) continue;
      const spot = spots.get(base);
      if (spot && tint >= 1 && tint <= 99) spot.tints = [...new Set([...(spot.tints ?? []), tint])].sort((a, b) => b - a);
      colors.set(t.attrs.Self, tintHex(baseHex, tint));
    }
  }
  const colorOf = (ref: string | undefined): string | null => {
    if (!ref || ref === "Color/Black" || ref.startsWith("Swatch/None")) return null;
    return colors.get(ref) ?? null;
  };

  // ---- スタイル ----
  const stylesXml = srcOf("idPkg:Styles")[0] ? xml(srcOf("idPkg:Styles")[0]) : undefined;
  const rawParagraphs = collectStyles(stylesXml && findAll(stylesXml, "RootParagraphStyleGroup")[0], "ParagraphStyle");
  const rawCharacters = collectStyles(stylesXml && findAll(stylesXml, "RootCharacterStyleGroup")[0], "CharacterStyle");
  const paraName = (self: string) => {
    const name = refName(self);
    return name === "NormalParagraphStyle" ? "基本段落" : name;
  };

  // ---- 組み方向・判型 ----
  const prefs = srcOf("idPkg:Preferences")[0] ? xml(srcOf("idPkg:Preferences")[0]) : undefined;
  const docPref = prefs ? findAll(prefs, "DocumentPreference")[0]?.attrs : undefined;
  const pageW = num(docPref?.PageWidth) ?? 595.276;
  const pageH = num(docPref?.PageHeight) ?? 841.89;
  const defaultVertical = (prefs ? findAll(prefs, "StoryPreference")[0]?.attrs.StoryOrientation : undefined) === "Vertical";

  // ---- ページとテキストフレーム（流れの順） ----
  interface Frame {
    story: string;
    x: number;
    y: number;
    w: number;
    h: number;
    columns: number;
    gutter: number;
    page?: { x: number; y: number; w: number; h: number };
  }
  const frames: Frame[] = [];
  let images = 0;
  for (const src of srcOf("idPkg:Spread")) {
    const spread = xml(src);
    if (!spread) continue;
    const pages = findAll(spread, "Page").map((p) => {
      const t = (p.attrs.ItemTransform ?? "1 0 0 1 0 0").split(/\s+/).map(Number);
      const b = (p.attrs.GeometricBounds ?? `0 0 ${pageH} ${pageW}`).split(/\s+/).map(Number);
      return { x: t[4] + b[1], y: t[5] + b[0], w: b[3] - b[1], h: b[2] - b[0] };
    });
    images += findAll(spread, "Image").length + findAll(spread, "PDF").length + findAll(spread, "EPS").length;
    for (const f of findAll(spread, "TextFrame")) {
      const t = (f.attrs.ItemTransform ?? "1 0 0 1 0 0").split(/\s+/).map(Number);
      const anchors = findAll(f, "PathPointType").map((p) => (p.attrs.Anchor ?? "0 0").split(/\s+/).map(Number));
      if (anchors.length === 0) continue;
      const xs = anchors.map(([x, y]) => t[0] * x + t[2] * y + t[4]);
      const ys = anchors.map(([x, y]) => t[1] * x + t[3] * y + t[5]);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      const w = Math.max(...xs) - x;
      const h = Math.max(...ys) - y;
      const pref = childElements(f, "TextFramePreference")[0]?.attrs ?? {};
      const cx = x + w / 2;
      frames.push({
        story: f.attrs.ParentStory,
        x,
        y,
        w,
        h,
        columns: Math.max(1, Math.round(num(pref.TextColumnCount) ?? 1)),
        gutter: num(pref.TextColumnGutter) ?? 12,
        page: pages.find((p) => cx >= p.x && cx <= p.x + p.w) ?? pages[0],
      });
    }
  }
  if (images > 0) notes.add(`画像（${images}個）`);
  // 流れの順：ストーリーが最初に出てくるフレームの順。いちばん多くのフレームを流れるストーリーを本文とみなす。
  const storyOrder = [...new Set(frames.map((f) => f.story))];
  const frameCount = new Map<string, number>();
  for (const f of frames) frameCount.set(f.story, (frameCount.get(f.story) ?? 0) + 1);
  const main = [...frameCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const mainFrame = frames.find((f) => f.story === main);

  // ---- 本文 ----
  const storyFiles = new Map<string, XmlElement>();
  for (const src of srcOf("idPkg:Story")) {
    const doc = xml(src);
    const story = doc ? findAll(doc, "Story")[0] : undefined;
    if (story) storyFiles.set(story.attrs.Self, story);
  }
  const usage = new Map<string, number>();
  let vertical = defaultVertical;
  const mainStory = main ? storyFiles.get(main) : undefined;
  const orientation = mainStory ? childElements(mainStory, "StoryPreference")[0]?.attrs.StoryOrientation : undefined;
  if (orientation) vertical = orientation === "Vertical";

  /** 段落：段落スタイル（Self）と字（記法）。 */
  type Para = { style: string; text: string; breakBefore?: string; raw?: boolean };
  const paras: Para[] = [];
  let footnotes = 0;
  let tables = 0;
  const storyText = (story: XmlElement) => {
    let cur: Para | undefined;
    let style = "ParagraphStyle/$ID/NormalParagraphStyle";
    let pendingBreak: string | undefined;
    const begin = () => {
      if (!cur) {
        cur = { style, text: "", breakBefore: pendingBreak };
        pendingBreak = undefined;
      }
      return cur;
    };
    const end = () => {
      const p = begin();
      paras.push(p);
      usage.set(p.style, (usage.get(p.style) ?? 0) + [...p.text].length);
      cur = undefined;
    };
    /** CharacterStyleRange の書式で、字を記法に包む。 */
    const wrap = (text: string, a: Record<string, string>): string => {
      if (!text) return text;
      let t = text;
      if (a.RubyFlag === "true" && a.RubyString) {
        const parts = a.RubyString.trim().split(/\s+/);
        const reading = a.RubyType === "PerCharacterRuby" && parts.length === [...t].length ? parts.join("|") : parts.join("");
        t = `｜${t}《${reading}》`;
      } else if (a.KentenKind && a.KentenKind !== "None" && KENTEN_NAMES[a.KentenKind]) t = `｜${t}《${KENTEN_NAMES[a.KentenKind]}》`;
      else if (a.Underline === "true") t = `｜${t}《傍線》`;
      if (a.Tatechuyoko === "true") t = `［＃縦中横］${t}［＃／縦中横］`;
      if (a.Warichu === "true") t = `［＃割注］${t}［＃／割注］`;
      const tracking = num(a.Tracking);
      if (tracking) t = `［＃字間：${Math.round(tracking)}］${t}［＃／字間］`;
      const kern = a.KerningMethod === "$ID/Manual" ? num(a.KerningValue) : undefined;
      if (kern) t = `${t}［＃カーニング：${Math.round(kern)}］`;
      const cs = a.AppliedCharacterStyle ? refName(a.AppliedCharacterStyle) : "";
      if (cs && !isDefaultStyle(cs)) t = `［＃${cs}］${t}［＃／${cs}］`;
      return t;
    };
    /** 段落の中の字（Content・処理命令）を集める。改行（Br・U+2028）で段落を分ける。 */
    const walkRange = (el: XmlElement, a: Record<string, string>) => {
      let buf = "";
      const flush = () => {
        if (buf) begin().text += wrap(buf, a);
        buf = "";
      };
      const visit = (nodes: XmlNode[]) => {
        for (const node of nodes) {
          if (typeof node === "string") continue;
          if ("pi" in node) continue;
          switch (node.name) {
            case "Content": {
              for (const c of node.children) {
                if (typeof c !== "string") continue;
                const parts = c.replace(/\t/g, "　").split(" ");
                parts.forEach((part, i) => {
                  if (i > 0) {
                    flush();
                    end();
                  }
                  buf += part;
                });
              }
              break;
            }
            case "Br":
              flush();
              end();
              break;
            case "Footnote": {
              flush();
              const body = findAll(node, "Content")
                .map((c) => c.children.filter((x): x is string => typeof x === "string").join(""))
                .join("")
                .replace(/[［］]/g, "");
              begin().text += `［＃注：${body}］`;
              footnotes++;
              break;
            }
            case "Table": {
              flush();
              if (cur && cur.text) end();
              tables++;
              table(node);
              break;
            }
            case "CharacterStyleRange":
              // リンク（HyperlinkTextSource）などの中の字の並び：その書式で包む。
              flush();
              walkRange(node, propsOf(node));
              break;
            case "HyperlinkTextSource":
            case "XMLElement":
            case "Change":
              if (node.attrs.ChangeType !== "DeletedText") visit(node.children);
              break;
            default:
              break;
          }
        }
      };
      visit(el.children);
      flush();
    };
    const table = (t: XmlElement) => {
      const cells = findAll(t, "Cell");
      const header = Math.round(num(t.attrs.HeaderRowCount) ?? 0);
      const grid: string[][] = [];
      for (const c of cells) {
        const [col, row] = (c.attrs.Name ?? "0:0").split(":").map(Number);
        const text = findAll(c, "Content")
          .map((x) => x.children.filter((y): y is string => typeof y === "string").join(""))
          .join("")
          .replace(/[|｜]/g, "／");
        (grid[row] ??= [])[col] = text;
      }
      paras.push({ style: "", text: "［＃表］", raw: true });
      grid.forEach((row, r) => {
        paras.push({ style: "", text: `| ${Array.from({ length: row.length }, (_, k) => row[k] ?? "").join(" | ")} |`, raw: true });
        if (r === header - 1) paras.push({ style: "", text: `|${Array.from({ length: row.length }, () => "---").join("|")}|`, raw: true });
      });
      paras.push({ style: "", text: "［＃／表］", raw: true });
    };
    for (const psr of childElements(story).filter((e) => e.name === "ParagraphStyleRange" || e.name === "XMLElement")) {
      const ranges = psr.name === "XMLElement" ? findAll(psr, "ParagraphStyleRange") : [psr];
      for (const range of ranges) {
        const props = propsOf(range);
        style = props.AppliedParagraphStyle ?? style;
        const start = props.StartParagraph;
        if (start === "NextPage" || start === "NextEvenPage") pendingBreak ??= "［＃改ページ］";
        else if (start === "NextOddPage") pendingBreak ??= "［＃改丁］";
        if (cur) cur.style = style;
        for (const csr of childElements(range)) {
          if (csr.name === "CharacterStyleRange") walkRange(csr, propsOf(csr));
          else walkRange({ name: "#", attrs: {}, children: [csr] }, {});
        }
      }
    }
    if (cur && (cur as Para).text) end();
  };
  for (const s of storyOrder) {
    const story = storyFiles.get(s);
    if (!story) continue;
    if (paras.length > 0) paras.push({ style: "", text: "［＃改ページ］", raw: true });
    storyText(story);
  }
  if (footnotes > 0) notes.add(`脚注（${footnotes}個。［＃注：…］にした）`);
  if (tables > 0) notes.add(`表（${tables}個。罫と欄の幅は読まない）`);

  // 本文：いちばん多くの字に当たっている段落スタイル。
  const bodySelf = [...usage.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "ParagraphStyle/$ID/NormalParagraphStyle";
  const bodyRaw = rawParagraphs.get(bodySelf)?.props ?? {};
  const bodySize = num(bodyRaw.PointSize) ?? 12;
  const bodyLeading = num(bodyRaw.Leading) ?? bodySize * 1.75;

  // ---- スタイルを Kolophon のスタイルにする ----
  const fonts: IdmlImport["fonts"] = { paragraph: {}, character: {} };
  if (bodyRaw.AppliedFont) fonts.body = bodyRaw.AppliedFont;
  const bold = (p: Record<string, string>) => /bold|ボールド|heavy|black|W[6-9]|B$/i.test(p.FontStyle ?? "");
  const deformOf = (p: Record<string, string>) => {
    const hs = num(p.HorizontalScale);
    const vs = num(p.VerticalScale);
    if (hs !== undefined && hs < 100) return { deform: "condensed" as const, deformRatio: Math.round(hs) };
    if (vs !== undefined && vs < 100) return { deform: "flat" as const, deformRatio: Math.round(vs) };
    return {};
  };
  const characterStyles: CharacterStyle[] = [];
  for (const [self, s] of rawCharacters) {
    const name = refName(self);
    if (isDefaultStyle(name)) continue;
    const p = s.props;
    const size = num(p.PointSize);
    if (p.AppliedFont) fonts.character[name] = p.AppliedFont;
    characterStyles.push({
      ...newCharacterStyle(name),
      scale: size ? Math.round((size / bodySize) * 100) / 100 : 1,
      color: colorOf(p.FillColor),
      bold: bold(p),
      glyphForm: GLYPH_FORMS[p.GlyphForm ?? ""] ?? "",
      proportional: p.OTFProportionalMetrics === "true",
      tracking: Math.round(num(p.Tracking) ?? 0),
      ...deformOf(p),
    });
  }
  const characterNames = new Set(characterStyles.map((c) => c.name));
  const paragraphStyles: ParagraphStyle[] = [];
  // 本文とみなした段落スタイルは「本文」に。ほかに「本文」という名前のスタイルがあれば、名前を変えて残す。
  const kolophonName = (self: string) => (self === bodySelf ? "本文" : paraName(self) === "本文" ? "本文（InDesign）" : paraName(self));
  for (const [self, s] of rawParagraphs) {
    const name = kolophonName(self);
    if (isDefaultStyle(paraName(self))) continue;
    const p = s.props;
    const size = num(p.PointSize) ?? bodySize;
    const leading = num(p.Leading) ?? size * (bodyLeading / bodySize);
    if (p.AppliedFont) fonts.paragraph[name] = p.AppliedFont;
    const just = p.Justification ?? "";
    const nested: NestedStyle[] = [];
    for (const item of listOf(s.el, "AllNestedStyles")) {
      const cs = item.AppliedCharacterStyle ? refName(item.AppliedCharacterStyle) : "";
      const style = isDefaultStyle(cs) ? "" : cs;
      const count = Math.max(1, Math.round(num(item.Repetition) ?? 1));
      if (item.DelimiterKind) {
        if (item.DelimiterKind === "AnyCharacter") nested.push({ style, until: "chars", count, chars: "" });
        else notes.add("先頭文字スタイルの区切りの一部（文字・単語・文などの種類）");
      } else nested.push({ style, until: item.Inclusive === "false" ? "before" : "through", count, chars: item.Delimiter || "　" });
    }
    const grep = listOf(s.el, "AllGREPStyles")
      .map((g) => ({ pattern: g.GrepExpression ?? "", style: g.AppliedCharacterStyle ? refName(g.AppliedCharacterStyle) : "" }))
      .filter((g) => g.pattern && characterNames.has(g.style));
    const line = listOf(s.el, "AllLineStyles")[0];
    paragraphStyles.push({
      ...newParagraphStyle(name),
      scale: Math.round((size / bodySize) * 100) / 100,
      linePitch: Math.min(3, Math.max(0.5, Math.round((leading / size / (bodyLeading / bodySize)) * 20) / 20)),
      align: /^Center/.test(just) ? "center" : /^Right/.test(just) ? "end" : "start",
      indent: Math.min(40, Math.max(0, Math.round(((num(p.LeftIndent) ?? 0) / size) * 2) / 2)),
      spaceBefore: Math.min(10, Math.round((num(p.SpaceBefore) ?? 0) / bodyLeading)),
      spaceAfter: Math.min(10, Math.round((num(p.SpaceAfter) ?? 0) / bodyLeading)),
      keepWithNext: (num(p.KeepWithNext) ?? 0) > 0,
      keepLines: p.KeepLinesTogether === "true",
      color: colorOf(p.FillColor),
      bold: bold(p),
      glyphForm: GLYPH_FORMS[p.GlyphForm ?? ""] ?? "",
      proportional: p.OTFProportionalMetrics === "true",
      tracking: Math.round(num(p.Tracking) ?? 0),
      ...deformOf(p),
      dropCap: { lines: (num(p.DropCapLines) ?? 0) >= 2 ? Math.min(5, Math.round(num(p.DropCapLines)!)) : 0, chars: Math.min(5, Math.max(1, Math.round(num(p.DropCapCharacters) ?? 1))), style: "" },
      nested,
      grep,
      lineStyle: line && line.AppliedCharacterStyle ? { style: refName(line.AppliedCharacterStyle), lines: Math.min(20, Math.round(num(line.LineCount) ?? 1)) } : { style: "", lines: 0 },
    });
  }
  // 本文・大見出し・中見出しは必ずある（なければ Kolophon の既定のもの）。
  for (const def of DEFAULT_STYLES.paragraph) if (!paragraphStyles.some((p) => p.name === def.name)) paragraphStyles.push(structuredClone(def));

  // ---- 原稿 ----
  const lines: string[] = [];
  for (const p of paras) {
    if (p.breakBefore) lines.push(p.breakBefore);
    if (p.raw) {
      lines.push(p.text);
      continue;
    }
    const name = kolophonName(p.style);
    // 行頭の「＃」は見出しの記法と重なるので、全角の空白の字下げを足さずに字のまま残せない。前に何もない字にする。
    const text = p.text.replace(/^[#＃]/u, (m) => `［＃字間：0］${m}［＃／字間］`);
    if (!p.text) lines.push("");
    else if (name === "大見出し") lines.push(`＃${text}`);
    else if (name === "中見出し") lines.push(`＃＃${text}`);
    else if (name === "本文" || isDefaultStyle(paraName(p.style))) lines.push(text);
    else lines.push(`［＃${name}］${text}`);
  }

  // ---- 設定 ----
  const s = structuredClone(DEFAULT_SETTINGS);
  s.layoutMode = "book";
  s.book.trim = FREE_TRIM;
  s.book.widthMm = Math.round((pageW / MM) * 10) / 10;
  s.book.heightMm = Math.round((pageH / MM) * 10) / 10;
  s.book.writingMode = vertical ? "vertical" : "horizontal";
  s.book.fontSizePt = Math.round(bodySize * 100) / 100;
  s.book.lineGapPercent = Math.round((bodyLeading / bodySize) * 100);
  if (mainFrame) {
    const cols = mainFrame.columns;
    const along = vertical ? mainFrame.h : mainFrame.w;
    const across = vertical ? mainFrame.w : mainFrame.h;
    s.book.columns = Math.min(4, cols);
    s.book.columnGapChars = Math.round((mainFrame.gutter / bodySize) * 2) / 2;
    // 字数・行数：IDML の数は丸めてあるので、少しの誤差は切り捨てない。
    s.book.charsPerLine = Math.max(5, Math.floor((along - (cols - 1) * mainFrame.gutter) / cols / bodySize + 0.01));
    s.book.linesPerPage = Math.max(1, Math.floor((across - bodySize) / bodyLeading + 0.01) + 1);
    const page = mainFrame.page;
    if (page) {
      s.book.position = "top-gutter";
      s.book.topMm = Math.round(((mainFrame.y - page.y) / MM) * 10) / 10;
      // ノド：見開きの左のページ（ページの右端が綴じ側）なら右の余白、右のページなら左の余白。
      const leftPage = page.x + page.w <= 1;
      const gutter = leftPage ? page.x + page.w - (mainFrame.x + mainFrame.w) : mainFrame.x - page.x;
      s.book.gutterMm = Math.round((gutter / MM) * 10) / 10;
    }
  }
  const bleed = num(docPref?.DocumentBleedTopOffset);
  if (bleed !== undefined) s.advanced.bleedMm = Math.round((bleed / MM) * 10) / 10;
  const section = childElements(designmap, "Section")[0];
  const start = num(section?.attrs.PageNumberStart);
  if (start) s.nombreStart = start;
  s.output.spotColors = [...spots.values()];
  // 本文の色は文書の文字の色に。段落スタイルの色がそれと同じなら、スタイルには色を持たせない。
  const textColor = colorOf(bodyRaw.FillColor);
  if (textColor && !spots.has(bodyRaw.FillColor)) {
    s.textColor = textColor;
    for (const p of paragraphStyles) if (p.color === textColor) p.color = null;
  }
  s.styles = { paragraph: paragraphStyles, character: characterStyles };
  s.typography = { ...s.typography, mode: "jis" };
  // InDesign と同じに：縦組みの半角の英数字は横倒し、縦中横は IDML で指定した所だけ（自動の縦中横はしない）。
  s.format.halfWidth = "rotate";
  s.format.tcyDigits = false;
  const masters = srcOf("idPkg:MasterSpread").map((src) => xml(src)).filter((m): m is XmlElement => !!m);
  if (masters.some((m) => findAll(m, "TextFrame").length > 0)) notes.add("マスターページの中身（柱・ノンブルは「柱とマスターページ」で作り直してください）");

  return { text: lines.join("\n"), settings: normalizeSettings(s), fonts, notes: [...notes] };
}
