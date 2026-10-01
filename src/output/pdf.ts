import fontkit from "@pdf-lib/fontkit";
import { randomBytes } from "node:crypto";
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
import { embedCffFont, isCffFont } from "./cff-font.js";
import { embedImages, type PdfImageSource } from "./pdf-images.js";
import { svgPathOps } from "./svg-path.js";
import { fillColor, strokeColor, type ColorMode } from "./color.js";
import { japaneseTrimMarks, marksMargin } from "./marks.js";

const MM = 72 / 25.4;

export interface PdfOptions {
  title: string;
  /** PDF に入れる画像を、この解像度を大きく超えるなら縮める（既定 400ppi）。 */
  imagePpi?: number;
  /** 色の指定方法。PDF/X-1a では cmyk か gray に限る。 */
  color: ColorMode;
  /** PDF/X-1a:2003 として書き出す。 */
  pdfx: boolean;
  /** 日本式トンボを付ける。 */
  marks: boolean;
  bleedMm: number;
}

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
  if (options.pdfx && options.color === "rgb") throw new Error("PDF/X-1a では RGB の色を使えません。");

  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  doc.setTitle(options.title, { showInWindowTitleBar: false });
  doc.setCreator("tategumi");
  doc.setProducer("tategumi (pdf-lib)");
  const now = new Date();
  doc.setCreationDate(now);
  doc.setModificationDate(now);

  // フォントごと（本文・スタイルで指定した書体）に埋め込む。使っていないフォントは埋め込まない。
  const bytesList = Array.isArray(fontBytes) ? fontBytes : [fontBytes];
  const faceFonts = await Promise.all(
    bytesList.map((bytes, face) => {
      const own = pages.map((p) => ({ ...p, items: p.items.filter((it) => it.face === face) }));
      return own.some((p) => p.items.length > 0) ? embedFonts(doc, bytes, own) : Promise.resolve(undefined);
    }),
  );
  const registration = options.marks ? registrationColorSpace(doc) : undefined;
  const imageRefs = await embedImages(doc, images, pages, options.color, options.imagePpi);
  const bleed = options.bleedMm * MM;

  for (const page of pages) {
    // 仕上がりの外側に、トンボ（または塗り足し）の分の余白を取る。
    const margin = options.marks ? marksMargin(bleed) : bleed;
    const pdfPage = doc.addPage([page.width + margin * 2, page.height + margin * 2]);
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
    // 画像は文字や飾りの下に描く。
    for (const shape of page.shapes) {
      if (shape.kind !== "image") continue;
      const ref = imageRefs.get(shape.name);
      if (ref) ops.push(...imageOps(shape, page.height, pdfPage.node.newXObject("Im", ref)));
      else ops.push(...missingImageOps(shape, page.height, options.color));
    }
    for (const shape of page.shapes) ops.push(...shapeOps(shape, page.height, options.color));
    ops.push(...textOps(page, fontsOf, options.color));
    ops.push(popGraphicsState());
    pdfPage.pushOperators(...ops);
    onProgress?.(page.index + 1, pages.length);
  }

  if (!options.pdfx) return doc.save();

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

function textOps(page: DrawPage, fontsOf: (face: number) => { vert: FontPair; horiz: FontPair }, mode: ColorMode): PDFOperator[] {
  const ops: PDFOperator[] = [beginText()];
  let color: string | undefined;
  let bold = false;
  for (const item of page.items) {
    const [font, key] = fontsOf(item.face)[item.font];
    if (item.color !== color) {
      ops.push(fillColor(item.color, mode), strokeColor(item.color, mode));
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
      ? setTextMatrix(0, -1, 1, 0, item.x, page.height - item.y)
      : setTextMatrix(item.sx, 0, 0, 1, item.x, page.height - item.y);
    ops.push(setFontAndSize(key, item.size), matrix, showText(font.encode(item)));
  }
  ops.push(endText());
  return ops;
}

/** 画像を置く。clip があれば、その範囲で切る（全面の画像を塗り足しの外で切る）。 */
function imageOps(shape: Extract<Shape, { kind: "image" }>, pageHeight: number, key: PDFName): PDFOperator[] {
  const ops: PDFOperator[] = [pushGraphicsState()];
  if (shape.clip) ops.push(rectangle(shape.clip.x, pageHeight - shape.clip.y - shape.clip.h, shape.clip.w, shape.clip.h), clip(), endPath());
  ops.push(concatTransformationMatrix(shape.w, 0, 0, shape.h, shape.x, pageHeight - shape.y - shape.h), drawObject(key), popGraphicsState());
  return ops;
}

/** 文書にない画像：置き場所が分かるよう、灰色の枠と×印を描く（書き出す前の検査でも知らせる）。 */
function missingImageOps(shape: Extract<Shape, { kind: "image" }>, pageHeight: number, mode: ColorMode): PDFOperator[] {
  const top = pageHeight - shape.y;
  const bottom = top - shape.h;
  return [
    strokeColor("#999999", mode),
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

function shapeOps(shape: Shape, pageHeight: number, mode: ColorMode): PDFOperator[] {
  const Y = (y: number) => pageHeight - y;
  switch (shape.kind) {
    case "path": {
      // 数式の輪郭：ページの座標（y は下向き）を PDF の座標（y は上向き）に写してから、行列を当てて塗る。
      const [a, b, c, d, e, f] = shape.m;
      return [
        pushGraphicsState(),
        fillColor(shape.color, mode),
        concatTransformationMatrix(a, -b, c, -d, e, pageHeight - f),
        ...svgPathOps(shape.d),
        fill(),
        popGraphicsState(),
      ];
    }
    case "line":
      return [
        strokeColor(shape.color, mode),
        setLineWidth(shape.width),
        setDashPattern(shape.dash ?? [], 0),
        moveTo(shape.x1, Y(shape.y1)),
        lineTo(shape.x2, Y(shape.y2)),
        stroke(),
        ...(shape.dash ? [setDashPattern([], 0)] : []),
      ];
    case "rect": {
      const ops: PDFOperator[] = [];
      if (shape.fill) ops.push(fillColor(shape.fill, mode), rectangle(shape.x, Y(shape.y + shape.h), shape.w, shape.h), fill());
      if (shape.stroke) {
        ops.push(
          strokeColor(shape.stroke.color, mode),
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
        fillColor(shape.fill, mode),
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
      return [fillColor(shape.fill, mode), moveTo(cx, cy + r), lineTo(cx + r, cy), lineTo(cx, cy - r), lineTo(cx - r, cy), closePath(), fill()];
    }
    case "image":
      // 画像は imageOps で描く（XObject の名前が要るため）。
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
  const resources = page.node.Resources()!;
  resources.set(PDFName.of("ColorSpace"), page.doc.context.obj({ [name]: ref }));
  return name;
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
