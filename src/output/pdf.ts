import fontkit from "@pdf-lib/fontkit";
import { randomBytes, randomUUID } from "node:crypto";
import {
  PDFArray,
  PDFDocument,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFString,
  beginText,
  concatTransformationMatrix,
  endText,
  appendBezierCurve,
  closePath,
  fill,
  fillAndStroke,
  lineTo,
  moveTo,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  clip,
  endPath,
  drawObject,
  setFontAndSize,
  setLineWidth,
  setDashPattern,
  setTextRenderingMode,
  TextRenderingMode,
  setTextMatrix,
  showText,
  stroke,
  type PDFFont,
  type PDFName as PDFNameType,
  type PDFRef,
  type PDFOperator,
  type PDFPage,
} from "pdf-lib";
import type { DrawItem, DrawPage, Shape } from "../engine/types.js";
import { Face } from "../engine/face.js";
import { embedCffFont, isCffFont } from "./cff-font.js";
import { embedImages, imageKey, type PdfImageSource } from "./pdf-images.js";
import { svgPathOps } from "./svg-path.js";
import { Inks, addResource, type Paint } from "./inks.js";
import type { SpotColor } from "../document/settings.js";
import { fillColor, strokeColor, type ColorMode } from "./color.js";
import { japaneseTrimMarks, marksMargin } from "./marks.js";
import { iccProblem, outputConditionId, readIcc } from "./icc.js";

const MM = 72 / 25.4;

export interface PdfOptions {
  title: string;
  /** PDF に入れる画像を、この解像度を大きく超えるなら縮める（既定 400ppi）。 */
  imagePpi?: number;
  /** 色の指定方法。PDF/X では cmyk か gray に限る。 */
  color: ColorMode;
  /** PDF/X として書き出す（standard の版で。既定は PDF/X-1a:2003）。 */
  pdfx: boolean;
  /** 文字をアウトライン化する（字形の輪郭を塗りの図形にし、フォントを埋め込まない）。 */
  outline?: boolean;
  /** PDF/X の版。x4 なら icc（印刷条件の CMYK の ICC プロファイル）が要る。 */
  standard?: PdfXStandard;
  icc?: Uint8Array;
  /** 日本式トンボを付ける。 */
  marks: boolean;
  bleedMm: number;
  /** 特色（入稿用の CMYK のときだけ、その色で描いた所を特色の版で刷る）。 */
  spots?: SpotColor[];
  /** スミ（K100%）の文字・罫をノセ（オーバープリント）にする（入稿用の CMYK のときだけ）。 */
  overprintBlack?: boolean;
  /**
   * 目次・ページ番号の参照・注番号をクリックできるリンクにする（閲覧用だけ。PDF/X では仕上がりの中に注釈を置けない）。
   * しおり（見出しの一覧）はどちらにも付ける。
   */
  links?: boolean;
}

export type PdfXStandard = "x1a" | "x4";

/** 入稿用：PDF/X-1a:2003、CMYK（本文は K100%）、トンボと塗り足し 3mm。 */
export const PRINT_PDF: Omit<PdfOptions, "title"> = { color: "cmyk", pdfx: true, marks: true, bleedMm: 3 };
/** 閲覧用：RGB、トンボなし。 */
export const SCREEN_PDF: Omit<PdfOptions, "title"> = { color: "rgb", pdfx: false, marks: false, bleedMm: 0 };

/**
 * 印刷条件。Japan Color 2001 Coated は ICC の登録済みの印刷条件なので、
 * PDF/X-1a では ICC プロファイルを埋め込まずに識別子だけで指定できる。
 */
const OUTPUT_INTENT = {
  identifier: "JC200103",
  condition: "Japan Color 2001 Coated",
  registry: "http://www.color.org",
};

/**
 * ページを PDF にする。文字は画像にせず、フォントを埋め込んだ文字として書く。
 * 同じフォントを2回埋め込む：縦書き用字形（OpenType の vert）を選ぶものと、通常の字形を選ぶもの。
 * どちらも実際に使った字形だけを埋め込む（サブセット化）。
 */
export async function renderPdf(
  pages: DrawPage[],
  fontBytes: Uint8Array | Uint8Array[],
  options: PdfOptions,
  onProgress?: (done: number, total: number) => void,
  images: PdfImageSource[] = [],
): Promise<Uint8Array> {
  if (options.pdfx && options.color === "rgb") throw new Error("PDF/X では RGB の色を使えません。");
  const x4 = options.pdfx && options.standard === "x4";
  const icc = x4 ? checkedIcc(options.icc) : undefined;

  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  doc.setTitle(options.title, { showInWindowTitleBar: false });
  doc.setCreator("Kolophon");
  doc.setProducer("Kolophon (pdf-lib)");
  const now = new Date();
  doc.setCreationDate(now);
  doc.setModificationDate(now);

  // フォントごと（本文・スタイルで指定した書体）に埋め込む。使っていないフォントは埋め込まない。
  const bytesList = Array.isArray(fontBytes) ? fontBytes : [fontBytes];
  // アウトライン化するときはフォントを埋め込まず、字形の輪郭を1度ずつ Form XObject にして使い回す。
  const outlines = options.outline ? new GlyphForms(doc, bytesList) : undefined;
  const faceFonts = outlines
    ? []
    : await Promise.all(
        bytesList.map((bytes, face) => {
          const own = pages.map((p) => ({ ...p, items: p.items.filter((it) => it.face === face) }));
          return own.some((p) => p.items.length > 0) ? embedFonts(doc, bytes, own) : Promise.resolve(undefined);
        }),
      );
  const registration = options.marks ? registrationColorSpace(doc) : undefined;
  const inks = new Inks(doc, options.color, { spots: options.spots, overprintBlack: options.overprintBlack });
  const imageRefs = await embedImages(doc, images, pages, options.color, options.imagePpi);
  const bleed = options.bleedMm * MM;

  const pdfPages: { page: PDFPage; margin: number }[] = [];
  for (const page of pages) {
    // 仕上がりの外側に、トンボ（または塗り足し）の分の余白を取る。
    const margin = options.marks ? marksMargin(bleed) : bleed;
    const pdfPage = doc.addPage([page.width + margin * 2, page.height + margin * 2]);
    pdfPages.push({ page: pdfPage, margin });
    const trim = { x0: margin, y0: margin, x1: margin + page.width, y1: margin + page.height };
    pdfPage.setTrimBox(trim.x0, trim.y0, page.width, page.height);
    pdfPage.setBleedBox(trim.x0 - bleed, trim.y0 - bleed, page.width + bleed * 2, page.height + bleed * 2);

    // ページの Resources には、そのページで使うフォントだけを登録する。
    const keys = new Map<number, { vert: FontPair; horiz: FontPair }>();
    const fontsOf = (face: number) => {
      let k = keys.get(face);
      if (!k) {
        const f = faceFonts[face] ?? faceFonts[0]!;
        const vertKey = pdfPage.node.newFontDictionary(f.vert.tag, f.vert.ref);
        const horizKey = f.horiz === f.vert ? vertKey : pdfPage.node.newFontDictionary(f.horiz.tag, f.horiz.ref);
        k = { vert: [f.vert, vertKey], horiz: [f.horiz, horizKey] };
        keys.set(face, k);
      }
      return k;
    };

    const ops: PDFOperator[] = [];
    const paint = inks.forPage(pdfPage);
    if (registration) {
      const key = setColorSpace(pdfPage, "Reg", registration);
      ops.push(...japaneseTrimMarks(trim, bleed, key));
    }

    // ここから先の座標は、仕上がりの左下を原点にする。
    ops.push(pushGraphicsState(), concatTransformationMatrix(1, 0, 0, 1, margin, margin));
    // 入稿用では紙の色は刷らない（紙そのものの色）。閲覧用では背景として塗る。
    if (!options.pdfx && page.paper.toLowerCase() !== "#ffffff") {
      ops.push(fillColor(page.paper, options.color), rectangle(-bleed, -bleed, page.width + bleed * 2, page.height + bleed * 2), fill());
    }
    // 図形は並びの順に描く（画面と同じ。本文のページでは画像が先頭なので、文字や飾りの下になる）。
    for (const shape of page.shapes) {
      if (shape.kind !== "image") {
        ops.push(...shapeOps(shape, page.height, paint));
        continue;
      }
      // 閲覧用（RGB）は透明のまま入れるので、下の色で分けない。
      const ref = imageRefs.get(options.color === "rgb" ? shape.name : imageKey(shape.name, shape.matte));
      if (ref) ops.push(...imageOps(shape, page.height, pdfPage.node.newXObject("Im", ref)));
      else ops.push(...missingImageOps(shape, page.height, paint));
    }
    ops.push(...(outlines ? outlines.ops(page, pdfPage, paint) : textOps(page, fontsOf, paint)));
    ops.push(popGraphicsState());
    pdfPage.pushOperators(...ops);
    onProgress?.(page.index + 1, pages.length);
  }

  addOutline(doc, pages, pdfPages.map((p) => p.page));
  if (options.links) addLinks(doc, pages, pdfPages);

  if (!options.pdfx) return doc.save();

  if (icc) {
    applyPdfX4(doc, icc, options.title, now);
    // PDF/X-4 は PDF 1.6。読む側を選ばないよう、オブジェクトストリームは使わない。
    return setHeaderVersion(await doc.save({ useObjectStreams: false }), "1.6");
  }
  applyPdfX1a(doc);
  // PDF/X-1a:2003 は PDF 1.4 まで。オブジェクトストリーム（PDF 1.5 以降の機能）は使わない。
  const bytes = await doc.save({ useObjectStreams: false });
  return setHeaderVersion(bytes, "1.4");
}

/**
 * pdf-lib はヘッダーを常に %PDF-1.7 で書くので、書き出したあとで版を書き換える。
 * 同じ長さの文字列に置き換えるので、相互参照表の位置はずれない。
 */
function setHeaderVersion(bytes: Uint8Array, version: string): Uint8Array {
  const expected = "%PDF-1.7";
  const actual = Buffer.from(bytes.subarray(0, expected.length)).toString("latin1");
  if (actual !== expected) throw new Error(`想定外の PDF ヘッダー：${actual}`);
  bytes.set(Buffer.from(`%PDF-${version}`, "latin1"), 0);
  return bytes;
}

/** サブセット化したフォントの名前。PDF の仕様どおり、英大文字6字の接頭辞と + を付ける。 */
function subsetName(postscriptName: string): string {
  const tag = Array.from(randomBytes(6), (b) => String.fromCharCode(65 + (b % 26))).join("");
  return `${tag}+${postscriptName}`;
}

/** PDF に埋め込んだフォント。encode は描画命令を PDF の文字列にする。 */
interface PdfFont {
  ref: PDFRef;
  /** ページの Resources に登録するときの名前の元。 */
  tag: string;
  encode(item: DrawItem): PDFHexString;
}

type FontPair = [PdfFont, PDFNameType];

/**
 * フォントを埋め込む。TrueType は pdf-lib で、縦書き用字形（vert）を選ぶものと通常の字形を選ぶものの2つを埋め込む。
 * CFF（PostScript 系）は自前で1つだけ埋め込み、組版で選んだ字形番号をそのまま使う。
 */
async function embedFonts(doc: PDFDocument, fontBytes: Uint8Array, pages: DrawPage[]): Promise<{ vert: PdfFont; horiz: PdfFont }> {
  const postscriptName = fontkit.create(fontBytes).postscriptName ?? "Font";
  if (isCffFont(fontBytes)) {
    const name = subsetName(postscriptName);
    const f = embedCffFont(doc, fontBytes, pages, name);
    const font = { ref: f.ref, tag: postscriptName, encode: f.encode };
    return { vert: font, horiz: font };
  }
  const wrap = (f: PDFFont): PdfFont => ({ ref: f.ref, tag: f.name, encode: (item) => f.encodeText(item.text) });
  return {
    vert: wrap(await doc.embedFont(fontBytes, { subset: true, features: { vert: true }, customName: subsetName(postscriptName) })),
    horiz: wrap(await doc.embedFont(fontBytes, { subset: true, customName: subsetName(postscriptName) })),
  };
}

/** 擬似ボールドの輪郭の太さ（文字サイズに対する割合）。 */
const BOLD_STROKE = 0.035;

function textOps(page: DrawPage, fontsOf: (face: number) => { vert: FontPair; horiz: FontPair }, paint: Paint): PDFOperator[] {
  const ops: PDFOperator[] = [beginText()];
  let color: string | undefined;
  let bold = false;
  for (const item of page.items) {
    const [font, key] = fontsOf(item.face)[item.font];
    if (item.color !== color) {
      ops.push(...paint.fill(item.color), ...paint.stroke(item.color));
      color = item.color;
    }
    // 擬似ボールド：塗りに加えて、同じ色で輪郭を描く（文字描画モード 2）。
    if (!!item.bold !== bold || item.bold) {
      bold = !!item.bold;
      ops.push(setTextRenderingMode(bold ? TextRenderingMode.FillAndOutline : TextRenderingMode.Fill));
      if (bold) ops.push(setLineWidth(item.size * BOLD_STROKE));
    }
    // PDF の座標は左下が原点で y 軸が上向き。横倒しは、送り方向が下、字形の上が右を向くように回す。
    const matrix = item.rotate
      ? setTextMatrix(0, -item.sx, item.sy ?? 1, 0, item.x, page.height - item.y)
      : setTextMatrix(item.sx, 0, 0, item.sy ?? 1, item.x, page.height - item.y);
    ops.push(setFontAndSize(key, item.size), matrix, showText(font.encode(item)));
  }
  ops.push(endText());
  return ops;
}

/**
 * アウトライン化した文字。字形ごとに、輪郭を塗る Form XObject（擬似ボールドなら塗りと輪郭）を1度だけ作り、
 * 字の位置と大きさの行列を掛けて置く。輪郭の座標はフォント単位（y 軸が上向き）。
 */
class GlyphForms {
  private readonly faces: Face[] = [];
  private readonly forms = new Map<string, PDFRef>();

  constructor(
    private readonly doc: PDFDocument,
    private readonly bytes: Uint8Array[],
  ) {}

  private face(i: number): Face {
    return (this.faces[i] ??= new Face(this.bytes[i] ?? this.bytes[0]));
  }

  private form(faceIndex: number, gid: number, bold: boolean): PDFRef | undefined {
    const key = `${faceIndex}:${gid}:${bold ? 1 : 0}`;
    let ref = this.forms.get(key);
    if (ref) return ref;
    const face = this.face(faceIndex);
    const d = face.path(gid);
    if (!d) return undefined;
    const u = face.upem;
    const body = svgPathOps(d);
    // 色と（擬似ボールドの）線の太さは、置くときの描画の状態のものを使う。
    const stream = this.doc.context.formXObject([...body, bold ? fillAndStroke() : fill()], { BBox: [-u * 2, -u * 2, u * 3, u * 3] });
    ref = this.doc.context.register(stream);
    this.forms.set(key, ref);
    return ref;
  }

  ops(page: DrawPage, pdfPage: PDFPage, paint: Paint): PDFOperator[] {
    const ops: PDFOperator[] = [];
    const names = new Map<PDFRef, PDFNameType>();
    let color: string | undefined;
    for (const item of page.items) {
      const face = this.face(item.face);
      const s = item.size / face.upem;
      if (item.color !== color) {
        ops.push(...paint.fill(item.color), ...paint.stroke(item.color));
        color = item.color;
      }
      for (const g of item.glyphs) {
        const ref = this.form(item.face, g.gid, !!item.bold);
        if (!ref) continue;
        let name = names.get(ref);
        if (!name) names.set(ref, (name = pdfPage.node.newXObject("G", ref)));
        // 画面の描き方（draw.ts）と同じ置き方。PDF は y 軸が上向きなので、ページの高さから引く。
        const m = item.rotate
          ? [0, -s * item.sx, s * (item.sy ?? 1), 0, item.x, page.height - (item.y + g.dx * s * item.sx)]
          : [s * item.sx, 0, 0, s * (item.sy ?? 1), item.x + g.dx * s * item.sx, page.height - item.y];
        ops.push(pushGraphicsState(), concatTransformationMatrix(m[0], m[1], m[2], m[3], m[4], m[5]));
        // 擬似ボールドの線の太さ（字の大きさに対する割合）を、フォント単位にして指定する。
        if (item.bold) ops.push(setLineWidth(BOLD_STROKE * face.upem));
        ops.push(drawObject(name), popGraphicsState());
      }
    }
    return ops;
  }
}

/** 画像を置く。clip があれば、その範囲で切る（全面の画像を塗り足しの外で切る）。 */
function imageOps(shape: Extract<Shape, { kind: "image" }>, pageHeight: number, key: PDFName): PDFOperator[] {
  const ops: PDFOperator[] = [pushGraphicsState()];
  if (shape.clip) ops.push(rectangle(shape.clip.x, pageHeight - shape.clip.y - shape.clip.h, shape.clip.w, shape.clip.h), clip(), endPath());
  ops.push(concatTransformationMatrix(shape.w, 0, 0, shape.h, shape.x, pageHeight - shape.y - shape.h), drawObject(key), popGraphicsState());
  return ops;
}

/** 文書にない画像：置き場所が分かるよう、灰色の枠と×印を描く（書き出す前の検査でも知らせる）。 */
function missingImageOps(shape: Extract<Shape, { kind: "image" }>, pageHeight: number, paint: Paint): PDFOperator[] {
  const top = pageHeight - shape.y;
  const bottom = top - shape.h;
  return [
    ...paint.stroke("#999999"),
    setLineWidth(0.5),
    rectangle(shape.x, bottom, shape.w, shape.h),
    stroke(),
    moveTo(shape.x, top),
    lineTo(shape.x + shape.w, bottom),
    moveTo(shape.x + shape.w, top),
    lineTo(shape.x, bottom),
    stroke(),
  ];
}

/** 円を4本のベジェ曲線で近似するときの係数。 */
const KAPPA = 0.5522847498;

function shapeOps(shape: Shape, pageHeight: number, paint: Paint): PDFOperator[] {
  const Y = (y: number) => pageHeight - y;
  switch (shape.kind) {
    case "path": {
      // 数式の輪郭：ページの座標（y は下向き）を PDF の座標（y は上向き）に写してから、行列を当てて塗る。
      const [a, b, c, d, e, f] = shape.m;
      return [
        pushGraphicsState(),
        ...paint.fill(shape.color),
        concatTransformationMatrix(a, -b, c, -d, e, pageHeight - f),
        ...svgPathOps(shape.d),
        fill(),
        popGraphicsState(),
      ];
    }
    case "line":
      return [
        ...paint.stroke(shape.color),
        setLineWidth(shape.width),
        setDashPattern(shape.dash ?? [], 0),
        moveTo(shape.x1, Y(shape.y1)),
        lineTo(shape.x2, Y(shape.y2)),
        stroke(),
        ...(shape.dash ? [setDashPattern([], 0)] : []),
      ];
    case "rect": {
      const ops: PDFOperator[] = [];
      if (shape.fill) ops.push(...paint.fill(shape.fill), rectangle(shape.x, Y(shape.y + shape.h), shape.w, shape.h), fill());
      if (shape.stroke) {
        ops.push(
          ...paint.stroke(shape.stroke.color),
          setLineWidth(shape.stroke.width),
          rectangle(shape.x, Y(shape.y + shape.h), shape.w, shape.h),
          stroke(),
        );
      }
      return ops;
    }
    case "circle": {
      const { cx, r } = shape;
      const cy = Y(shape.cy);
      const k = r * KAPPA;
      return [
        ...paint.fill(shape.fill),
        moveTo(cx + r, cy),
        appendBezierCurve(cx + r, cy + k, cx + k, cy + r, cx, cy + r),
        appendBezierCurve(cx - k, cy + r, cx - r, cy + k, cx - r, cy),
        appendBezierCurve(cx - r, cy - k, cx - k, cy - r, cx, cy - r),
        appendBezierCurve(cx + k, cy - r, cx + r, cy - k, cx + r, cy),
        closePath(),
        fill(),
      ];
    }
    case "diamond": {
      const { cx, r } = shape;
      const cy = Y(shape.cy);
      return [...paint.fill(shape.fill), moveTo(cx, cy + r), lineTo(cx + r, cy), lineTo(cx, cy - r), lineTo(cx - r, cy), closePath(), fill()];
    }
    case "image":
      // 画像は imageOps で描く（XObject の名前が要るため）。
      return [];
    case "link":
      // リンクは描かない（注釈として付ける）。
      return [];
  }
}

/** レジストレーション色（全版に 100% で出る色）の Separation 色空間。 */
function registrationColorSpace(doc: PDFDocument) {
  const tint = doc.context.register(
    doc.context.obj({ FunctionType: 2, Domain: [0, 1], C0: [0, 0, 0, 0], C1: [1, 1, 1, 1], N: 1 }),
  );
  return doc.context.register(doc.context.obj([PDFName.of("Separation"), PDFName.of("All"), PDFName.of("DeviceCMYK"), tint]));
}

function setColorSpace(page: PDFPage, name: string, ref: ReturnType<typeof registrationColorSpace>): string {
  addResource(page, "ColorSpace", name, ref);
  return name;
}

/** PDF/X-4 に埋め込む ICC プロファイルを確かめる。 */
function checkedIcc(bytes: Uint8Array | undefined): { bytes: Uint8Array; name: string } {
  if (!bytes) throw new Error("PDF/X-4 には、印刷条件の ICC プロファイル（CMYK）が要ります。設定の「書き出し」で選んでください。");
  const info = readIcc(bytes);
  const problem = iccProblem(info);
  if (problem) throw new Error(`この ICC プロファイルは PDF/X-4 に使えません：${problem}`);
  return { bytes, name: info.name || "CMYK" };
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** XMP の日時（文書情報の CreationDate・ModDate と同じ時刻。秒まで、UTC）。 */
const xmpDate = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * PDF/X-4（ISO 15930-7）に必要なもの：XMP メタデータ（GTS_PDFXVersion・版の情報）、
 * ICC プロファイルを埋め込んだ出力インテント、文書情報の Trapped、ファイル識別子。
 */
function applyPdfX4(doc: PDFDocument, icc: { bytes: Uint8Array; name: string }, title: string, date: Date) {
  const { context, catalog } = doc;
  const info = context.lookup(context.trailerInfo.Info, PDFDict);
  info.set(PDFName.of("GTS_PDFXVersion"), PDFString.of("PDF/X-4"));
  info.set(PDFName.of("Trapped"), PDFName.of("False"));

  const profile = context.flateStream(icc.bytes, { N: 4 });
  const id = outputConditionId(icc.name);
  const intent = context.obj({
    Type: "OutputIntent",
    S: "GTS_PDFX",
    OutputConditionIdentifier: PDFString.of(id),
    OutputCondition: PDFString.of(icc.name),
    ...(id !== icc.name ? { RegistryName: PDFString.of(OUTPUT_INTENT.registry) } : {}),
    Info: PDFString.of(icc.name),
    DestOutputProfile: context.register(profile),
  });
  catalog.set(PDFName.of("OutputIntents"), context.obj([context.register(intent)]));

  const uuid = randomUUID();
  const when = xmpDate(date);
  const packet = `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about=""
 xmlns:dc="http://purl.org/dc/elements/1.1/"
 xmlns:xmp="http://ns.adobe.com/xap/1.0/"
 xmlns:pdf="http://ns.adobe.com/pdf/1.3/"
 xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/"
 xmlns:pdfxid="http://www.npes.org/pdfx/ns/id/">
<dc:format>application/pdf</dc:format>
<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${xml(title)}</rdf:li></rdf:Alt></dc:title>
<xmp:CreateDate>${when}</xmp:CreateDate>
<xmp:ModifyDate>${when}</xmp:ModifyDate>
<xmp:MetadataDate>${when}</xmp:MetadataDate>
<xmp:CreatorTool>Kolophon</xmp:CreatorTool>
<pdf:Producer>Kolophon (pdf-lib)</pdf:Producer>
<pdf:Trapped>False</pdf:Trapped>
<xmpMM:DocumentID>uuid:${uuid}</xmpMM:DocumentID>
<xmpMM:InstanceID>uuid:${uuid}</xmpMM:InstanceID>
<xmpMM:VersionID>1</xmpMM:VersionID>
<xmpMM:RenditionClass>default</xmpMM:RenditionClass>
<pdfxid:GTS_PDFXVersion>PDF/X-4</pdfxid:GTS_PDFXVersion>
</rdf:Description>
</rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
  // メタデータは圧縮しない（読む側が中身を探せるように）。
  const metadata = context.stream(new TextEncoder().encode(packet), { Type: "Metadata", Subtype: "XML" });
  catalog.set(PDFName.of("Metadata"), context.register(metadata));

  const fileId = PDFHexString.of(randomBytes(16).toString("hex"));
  context.trailerInfo.ID = PDFArray.withContext(context);
  (context.trailerInfo.ID as PDFArray).push(fileId);
  (context.trailerInfo.ID as PDFArray).push(fileId);
}

/** PDF/X-1a:2003 に必要な文書情報・出力インテント・ファイル識別子を付ける。 */
function applyPdfX1a(doc: PDFDocument) {
  const { context, catalog } = doc;
  const info = context.lookup(context.trailerInfo.Info, PDFDict);
  info.set(PDFName.of("GTS_PDFXVersion"), PDFString.of("PDF/X-1a:2003"));
  info.set(PDFName.of("Trapped"), PDFName.of("False"));

  const intent = context.obj({
    Type: "OutputIntent",
    S: "GTS_PDFX",
    OutputConditionIdentifier: PDFString.of(OUTPUT_INTENT.identifier),
    OutputCondition: PDFString.of(OUTPUT_INTENT.condition),
    RegistryName: PDFString.of(OUTPUT_INTENT.registry),
    Info: PDFString.of(OUTPUT_INTENT.condition),
  });
  catalog.set(PDFName.of("OutputIntents"), context.obj([context.register(intent)]));

  const id = PDFHexString.of(randomBytes(16).toString("hex"));
  context.trailerInfo.ID = PDFArray.withContext(context);
  (context.trailerInfo.ID as PDFArray).push(id);
  (context.trailerInfo.ID as PDFArray).push(id);
}

/** ページの頭へ飛ぶ行き先（ページ全体を見せる）。 */
const fitDest = (doc: PDFDocument, page: PDFPage) => doc.context.obj([page.ref, PDFName.of("Fit")]);

/**
 * しおり（PDF の目次の欄）：見出しを出てくる順に並べ、中見出しは直前の大見出しの下に入れる。押すとそのページへ飛ぶ。
 */
function addOutline(doc: PDFDocument, pages: DrawPage[], pdfPages: PDFPage[]): void {
  type Node = { title: string; page: PDFPage; children: Node[] };
  const top: Node[] = [];
  pages.forEach((p, i) => {
    for (const h of p.headings ?? []) {
      const title = h.text.trim();
      if (!title) continue;
      const node: Node = { title, page: pdfPages[i], children: [] };
      const parent = h.level === 2 ? top[top.length - 1] : undefined;
      (parent ? parent.children : top).push(node);
    }
  });
  if (top.length === 0) return;
  const ctx = doc.context;
  const rootRef = ctx.nextRef();
  /** 兄弟の並びを辞書にして、最初と最後の参照と、開いたときに見える数を返す。 */
  const build = (nodes: Node[], parent: PDFRef): { first: PDFRef; last: PDFRef; count: number } => {
    const refs = nodes.map(() => ctx.nextRef());
    let count = 0;
    nodes.forEach((n, i) => {
      const dict: Record<string, unknown> = { Title: PDFHexString.fromText(n.title), Parent: parent, Dest: fitDest(doc, n.page) };
      if (i > 0) dict.Prev = refs[i - 1];
      if (i < nodes.length - 1) dict.Next = refs[i + 1];
      if (n.children.length > 0) {
        const sub = build(n.children, refs[i]);
        dict.First = sub.first;
        dict.Last = sub.last;
        dict.Count = sub.count;
        count += sub.count;
      }
      ctx.assign(refs[i], ctx.obj(dict as never));
      count++;
    });
    return { first: refs[0], last: refs[refs.length - 1], count };
  };
  const root = build(top, rootRef);
  ctx.assign(rootRef, ctx.obj({ Type: "Outlines", First: root.first, Last: root.last, Count: root.count }));
  doc.catalog.set(PDFName.of("Outlines"), rootRef);
  // 開いたときに、しおりの欄を見せる。
  doc.catalog.set(PDFName.of("PageMode"), PDFName.of("UseOutlines"));
}

/** リンク：紙面のリンクの範囲（Shape の link）に、飛び先のページへの注釈を付ける。 */
function addLinks(doc: PDFDocument, pages: DrawPage[], pdfPages: { page: PDFPage; margin: number }[]): void {
  const labelPage = new Map<string, number>();
  pages.forEach((p, i) => {
    for (const l of p.labels ?? []) if (!labelPage.has(l)) labelPage.set(l, i);
  });
  const headingPage = pages.flatMap((p, i) => (p.headings ?? []).map(() => i));
  const targetOf = (t: string): number | undefined => (t.startsWith("h:") ? headingPage[Number(t.slice(2))] : t.startsWith("l:") ? labelPage.get(t.slice(2)) : undefined);
  pages.forEach((p, i) => {
    const { page, margin } = pdfPages[i];
    const annots: PDFRef[] = [];
    for (const s of p.shapes) {
      if (s.kind !== "link") continue;
      const to = targetOf(s.target);
      if (to === undefined || !pdfPages[to]) continue;
      const rect = [margin + s.x, margin + p.height - (s.y + s.h), margin + s.x + s.w, margin + p.height - s.y];
      annots.push(doc.context.register(doc.context.obj({ Type: "Annot", Subtype: "Link", Rect: rect, Border: [0, 0, 0], Dest: fitDest(doc, pdfPages[to].page) })));
    }
    if (annots.length > 0) page.node.set(PDFName.of("Annots"), doc.context.obj(annots));
  });
}
