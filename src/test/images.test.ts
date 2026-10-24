import assert from "node:assert/strict";
import { describe, it } from "node:test";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { PDFDocument, PDFName, PDFRawStream } from "pdf-lib";
import { imageInfos, parseDocument, serializeDocument, type DocImage } from "../document/document.js";
import { DEFAULT_SETTINGS, type Settings } from "../document/settings.js";
import { typeset, type DrawPage } from "../engine/index.js";
import { DEFAULT_SPEC, MM, layoutDocument } from "../engine/layout.js";
import { parse } from "../engine/parse.js";
import type { LayoutSpec } from "../engine/types.js";
import { FontService } from "../fonts/service.js";
import { exportPdf } from "../output/export-pdf.js";
import { preflight } from "../output/preflight.js";
import { embedImages, toDeviceColor } from "../output/pdf-images.js";

const body = new FontService().load(null);
const face = body.face;
const fonts = [{ key: "body", bytes: body.bytes }];
const settings = (edit: (s: Settings) => void = () => {}): Settings => {
  const s = structuredClone(DEFAULT_SETTINGS);
  edit(s);
  return s;
};
const spec = (over: Partial<LayoutSpec> = {}): LayoutSpec => ({ ...DEFAULT_SPEC, images: { 絵: { width: 400, height: 300 } }, ...over });
const imageShapes = (p: { shapes: DrawPage["shapes"] }) => p.shapes.filter((s): s is Extract<DrawPage["shapes"][number], { kind: "image" }> => s.kind === "image");

/** 赤一色の PNG。 */
function redPng(width: number, height: number): DocImage {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) png.data.set([255, 0, 0, 255], i * 4);
  return { name: "絵", mime: "image/png", data: PNG.sync.write(png).toString("base64"), width, height };
}
function grayJpeg(width: number, height: number): DocImage {
  const data = Buffer.alloc(width * height * 4, 128);
  return { name: "写真", mime: "image/jpeg", data: Buffer.from(jpeg.encode({ data, width, height }, 90).data).toString("base64"), width, height };
}

describe("画像の記法（DTP-12）", () => {
  it("置き方を読む：版面（既定）・全面・N行・回り込み・天地", () => {
    const [a, b, c, d] = parse("［＃画像：絵］\n［＃画像：絵　全面］\n［＃画像：絵　５行　回り込み　天］\n［＃画像：絵 3行］");
    assert.deepEqual(a, { kind: "image", name: "絵", mode: "block", lines: 1, wrap: false, position: "center" });
    assert.equal(b.kind === "image" && b.mode, "full");
    assert.deepEqual(c, { kind: "image", name: "絵", mode: "lines", lines: 5, wrap: true, position: "top" });
    assert.ok(d.kind === "image" && d.lines === 3 && !d.wrap);
  });
});

describe("画像の配置（DTP-12）", () => {
  it("全面の画像は1ページを取り、塗り足しまで覆って切る。柱もノンブルも付かない", () => {
    const pages = layoutDocument(parse("前\n［＃画像：絵　全面］\n後"), spec());
    assert.equal(pages.length, 3);
    assert.equal(pages[1].role, "image");
    const [img] = imageShapes(pages[1]);
    const bleed = 3 * MM;
    assert.deepEqual(img.clip, { x: -bleed, y: -bleed, w: pages[1].width + bleed * 2, h: pages[1].height + bleed * 2 });
    // 横長（4:3）なので高さに合わせ、幅ははみ出す（切られる）。
    assert.ok(Math.abs(img.h - (pages[1].height + bleed * 2)) < 1e-6 && img.w > img.clip!.w);
  });

  it("版面の画像は、縦横比を保って版面に収め、中央に置く", () => {
    const [page] = layoutDocument(parse("［＃画像：絵］"), spec());
    const [img] = imageShapes(page);
    assert.ok(Math.abs(img.w - page.block.width) < 1e-6, "横長なので幅いっぱい");
    assert.ok(Math.abs(img.h / img.w - 0.75) < 1e-9);
    assert.ok(Math.abs(img.y + img.h / 2 - (page.block.top + page.block.height / 2)) < 1e-6);
  });

  it("N行の画像は、その行数の幅を取り、本文はそのあとの行から続く", () => {
    const s = spec();
    const [page] = layoutDocument(parse("あ\n［＃画像：絵　４行］\nい"), s);
    const [img] = imageShapes(page);
    const pitch = s.fontSizePt * s.lineGap;
    assert.ok(Math.abs(img.w - (3 * pitch + s.fontSizePt)) < 1e-6);
    const x = (t: string) => page.glyphs.find((g) => g.text === t)!.x;
    assert.ok(Math.abs(x("あ") - x("い") - 5 * pitch) < 1e-6, "「い」は画像の4行のあと");
    assert.ok(img.x < x("あ") && img.x + img.w > x("い"), "画像は「あ」と「い」の間");
  });

  it("回り込み（地）：画像のある行は、画像の高さ＋1字分だけ短くなる", () => {
    const s = spec({ charsPerLine: 30 });
    const text = "本".repeat(300);
    const [page] = layoutDocument(parse(`［＃画像：絵　３行　回り込み］\n${text}`), s);
    const [img] = imageShapes(page);
    const short = Math.ceil(img.h / s.fontSizePt - 1e-6) + 1;
    const columns = new Map<number, number>();
    for (const g of page.glyphs) columns.set(g.x, (columns.get(g.x) ?? 0) + 1);
    const counts = [...columns.entries()].sort((a, b) => b[0] - a[0]).map(([, n]) => n);
    assert.deepEqual(counts.slice(0, 4), [30 - short, 30 - short, 30 - short, 30]);
    assert.ok(Math.abs(img.y + img.h - (page.block.top + 30 * s.fontSizePt)) < 1e-6, "画像は地に付く");
  });

  it("回り込み（天）：本文は画像の下から始まる", () => {
    const s = spec({ charsPerLine: 30 });
    const [page] = layoutDocument(parse(`［＃画像：絵　２行　回り込み　天］\n${"本".repeat(100)}`), s);
    const [img] = imageShapes(page);
    const firstGlyph = page.glyphs.reduce((a, b) => (b.x > a.x || (b.x === a.x && b.y < a.y) ? b : a));
    assert.ok(firstGlyph.y >= img.y + img.h, "最初の字は画像より下");
  });

  it("段の残りが足りなければ、画像は次のページの頭へ送る", () => {
    const pages = layoutDocument(parse(`${Array.from({ length: 13 }, () => "行").join("\n")}\n［＃画像：絵　５行］`), spec({ linesPerPage: 15 }));
    assert.equal(pages.length, 2);
    assert.equal(imageShapes(pages[1]).length, 1);
  });

  it("文書にない画像は、4:3 の枠として置く", () => {
    const [page] = layoutDocument(parse("［＃画像：ない］"), spec());
    const [img] = imageShapes(page);
    assert.ok(Math.abs(img.h / img.w - 0.75) < 1e-9);
  });
});

describe("画像の PDF と検査", () => {
  it("入稿用 PDF では、画像を CMYK にして入れ、PDF/X-1a の検査に通る", async () => {
    const img = redPng(60, 45);
    const r = await exportPdf("［＃画像：絵］", settings(), fonts, "t", undefined, [img]);
    assert.deepEqual(r.check!.filter((c) => !c.ok), []);
    const doc = await PDFDocument.load(r.bytes);
    const images = doc.context
      .enumerateIndirectObjects()
      .map(([, o]) => o)
      .filter((o): o is PDFRawStream => o instanceof PDFRawStream && o.dict.get(PDFName.of("Subtype")) === PDFName.of("Image"));
    assert.equal(images.length, 1);
    assert.equal(images[0].dict.get(PDFName.of("ColorSpace")), PDFName.of("DeviceCMYK"));
  });

  it("赤は C0 M100 Y100 K0、透明は白（紙）になる", () => {
    const px = { width: 2, height: 1, data: new Uint8Array([255, 0, 0, 255, 0, 0, 0, 0]) };
    assert.deepEqual([...toDeviceColor(px, "cmyk")], [0, 255, 255, 0, 0, 0, 0, 0]);
    assert.deepEqual([...toDeviceColor(px, "gray")], [76, 255]);
  });

  it("閲覧用 PDF には JPEG をそのまま入れる", async () => {
    const img = grayJpeg(40, 30);
    const r = await exportPdf("［＃画像：写真］", settings((s) => (s.pdfKind = "screen")), fonts, "t", undefined, [img]);
    assert.ok(Buffer.from(r.bytes).includes(Buffer.from(img.data, "base64").subarray(0, 64)), "元の JPEG のバイト列がある");
  });

  it("閲覧用 PDF：バイト列が大きな領域の途中にあっても、その画像を入れる（Mac の CI で落ちていた）", async () => {
    const img = grayJpeg(40, 30);
    const raw = Buffer.from(img.data, "base64");
    // 前にごみのある領域の途中に置く（Node の共有の領域と同じ形）。
    const pool = new Uint8Array(raw.length + 100).fill(7);
    pool.set(raw, 100);
    const doc = await PDFDocument.create();
    const pages = [{ index: 0, width: 100, height: 100, paper: "#fff", items: [], shapes: [{ kind: "image" as const, name: "写真", x: 0, y: 0, w: 40, h: 30 }] }];
    const refs = await embedImages(doc, [{ name: "写真", mime: "image/jpeg", bytes: pool.subarray(100) }], pages as never, "rgb");
    assert.ok(refs.get("写真"));
  });

  it("文書にない画像と、解像度の足りない画像を知らせる", () => {
    const s = settings();
    const infos = imageInfos([redPng(60, 45)]);
    const r = typeset("［＃画像：絵］\n［＃画像：ない］", s, face, infos);
    const found = preflight({ settings: s, pageCount: r.pages.length, page: (i) => r.pages[i], missingChars: [], fontWarnings: [], target: "pdf", images: infos });
    assert.ok(found.some((f) => f.level === "error" && f.message.includes("ない")));
    assert.ok(found.some((f) => f.level === "warning" && f.message.includes("画像「絵」の解像度")));
  });

  it("画像は文書ファイルに入り、読み直すと同じになる。壊れた項目は捨てる", () => {
    const img = redPng(4, 3);
    const doc = parseDocument(serializeDocument({ text: "t", settings: DEFAULT_SETTINGS, images: [img] }));
    assert.deepEqual(doc.images, [img]);
    const json = JSON.parse(serializeDocument({ text: "t", settings: DEFAULT_SETTINGS, images: [img] }));
    json.images.push({ name: "空白 入り", mime: "image/png", data: "", width: 1, height: 1 }, { name: "x", mime: "image/gif", data: "", width: 1, height: 1 });
    assert.deepEqual(parseDocument(JSON.stringify(json)).images.map((i) => i.name), ["絵"]);
  });
});

describe("壊れた画像（#16 の確かめで見つけた所）", () => {
  it("PDF の書き出しで読めない画像は、その画像の名前を知らせる", async () => {
    const { decodeImage } = await import("../output/pdf-images.js");
    const broken = { name: "壊れた絵", mime: "image/png" as const, bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]) };
    assert.throws(() => decodeImage(broken), /画像「壊れた絵」を読めません/);
  });
});

describe("写真の多い本の入稿用 PDF（#18）", () => {
  it("2枚以上の画像は別のスレッドで並べて処理し、元の順に CMYK の画像として入れる", async () => {
    const { inflateSync } = await import("node:zlib");
    const a = { ...redPng(60, 45), name: "絵1" };
    const b = { ...redPng(30, 20), name: "絵2" };
    const r = await exportPdf("［＃画像：絵1］\n［＃画像：絵2］", settings(), fonts, "t", undefined, [a, b]);
    assert.deepEqual(r.check!.filter((c) => !c.ok), []);
    const doc = await PDFDocument.load(r.bytes);
    const images = doc.context
      .enumerateIndirectObjects()
      .map(([, o]) => o)
      .filter((o): o is PDFRawStream => o instanceof PDFRawStream && o.dict.get(PDFName.of("Subtype")) === PDFName.of("Image"));
    assert.equal(images.length, 2);
    for (const img of images) {
      assert.equal(img.dict.get(PDFName.of("ColorSpace")), PDFName.of("DeviceCMYK"));
      const px = inflateSync(img.contents);
      // 赤は C0 M100 Y100 K0。
      assert.deepEqual([...px.subarray(0, 4)], [0, 255, 255, 0]);
    }
    assert.deepEqual(
      images.map((img) => (img.dict.get(PDFName.of("Width")) as unknown as { asNumber(): number }).asNumber()).sort((x, y) => x - y),
      [30, 60],
    );
  });
});
