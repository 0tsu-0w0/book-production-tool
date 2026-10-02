import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { PDFArray, PDFDocument, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import { DEFAULT_SETTINGS, normalizeSettings, spineWidthMm, type Settings } from "../document/settings.js";
import { typeset, typesetLazy } from "../engine/index.js";
import { FontService } from "../fonts/service.js";
import { exportPdf } from "../output/export-pdf.js";
import { combineSpread, imposeSpreads, spreadPairs } from "../output/imposition.js";
import { preflight } from "../output/preflight.js";
import { ZipWriter, crc32 } from "../output/zip.js";

const service = new FontService();
const body = service.load(null);
const face = body.face;
const fonts = [{ key: "body", bytes: body.bytes }];
const settings = (edit: (s: Settings) => void = () => {}): Settings => {
  const s = structuredClone(DEFAULT_SETTINGS);
  edit(s);
  return s;
};
const pagesText = (n: number) => Array.from({ length: n }, (_, i) => `ページ${i + 1}`).join("\n＝＝＝\n");

describe("見開きの面付け（OUT-05）", () => {
  it("1ページ目が奇数なら単独で左に置き、あとは偶数ページが右・奇数ページが左", () => {
    assert.deepEqual(spreadPairs(4, 1), [
      { right: null, left: 0 },
      { right: 1, left: 2 },
      { right: 3, left: null },
    ]);
    assert.deepEqual(spreadPairs(3, 2), [
      { right: 0, left: 1 },
      { right: 2, left: null },
    ]);
  });

  it("2ページを並べた1枚は幅が2倍で、右ページの文字は1ページ分右にずれる", () => {
    const [a, b] = typeset(pagesText(2), settings(), face).pages;
    const spread = combineSpread(a, b, 0);
    assert.equal(spread.width, a.width * 2);
    assert.equal(spread.items.length, a.items.length + b.items.length);
    const right = spread.items.find((i) => i.text === "１" || i.text === "1")!;
    assert.ok(right.x > a.width, "右ページ（ページ1）の文字は右半分");
  });

  it("書き出す画像の名前は、ページ番号を右から左の順につなぐ", () => {
    const { pages } = typeset(pagesText(4), settings(), face);
    assert.deepEqual(imposeSpreads(pages, 1).labels, ["001", "002-003", "004"]);
  });

  it("閲覧用 PDF は見開きで書き出せる。入稿用は単ページのまま", async () => {
    const text = pagesText(4);
    const screen = await exportPdf(text, settings((s) => ((s.pdfKind = "screen"), (s.output.imposition = "spread"))), fonts, "t");
    assert.equal(screen.pages, 3);
    const doc = await PDFDocument.load(screen.bytes);
    const single = typeset(text, settings(), face).pages[0];
    assert.ok(Math.abs(doc.getPage(1).getWidth() - single.width * 2) < 0.01);
    const print = await exportPdf(text, settings((s) => (s.output.imposition = "spread")), fonts, "t");
    assert.equal(print.pages, 4);
  });
});

describe("グレースケール（OUT-03）", () => {
  it("入稿用のグレースケール PDF も PDF/X-1a の検査に通り、CMYK の色を使わない", async () => {
    const r = await exportPdf("［＃太字］本文［＃／太字］", settings((s) => ((s.output.color = "gray"), (s.textColor = "#9e3d3f"))), fonts, "t");
    assert.deepEqual(r.check!.filter((c) => !c.ok), []);
    const raw = await pageContent(r.bytes);
    assert.match(raw, /[\d.]+ g\b/, "グレーの塗りがある");
    assert.doesNotMatch(raw, /[\d.]+ [\d.]+ [\d.]+ [\d.]+ k\b/, "CMYK の塗りがない");
    const cmyk = await exportPdf("本文", settings((s) => (s.textColor = "#9e3d3f")), fonts, "t");
    assert.match(await pageContent(cmyk.bytes), /[\d.]+ [\d.]+ [\d.]+ [\d.]+ k\b/, "比べる：自動では CMYK");
  });
});

/** 1ページ目の内容（描画命令）を展開して返す。 */
async function pageContent(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes);
  const c = doc.getPage(0).node.Contents()!;
  const refs = c instanceof PDFArray ? c.asArray() : [c];
  return refs
    .map((ref) => {
      const st = doc.context.lookup(ref);
      return st instanceof PDFRawStream ? Buffer.from(decodePDFRawStream(st).decode()).toString("latin1") : String(st);
    })
    .join("\n");
}

describe("ZIP（OUT-05）", () => {
  it("書いた ZIP は、目次の件数・CRC・ファイル名（UTF-8）が合っている", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kolophon-")), "t.zip");
    const a = new Uint8Array([1, 2, 3]);
    const b = new TextEncoder().encode("縦書き");
    const zip = new ZipWriter(file);
    zip.add("作品_001.png", a);
    zip.add("作品_002.png", b);
    zip.close();
    const buf = fs.readFileSync(file);
    const eocd = buf.length - 22;
    assert.equal(buf.readUInt32LE(eocd), 0x06054b50);
    assert.equal(buf.readUInt16LE(eocd + 10), 2);
    const cd = buf.readUInt32LE(eocd + 16);
    assert.equal(buf.readUInt32LE(cd), 0x02014b50);
    assert.equal(buf.readUInt32LE(cd + 16), crc32(a));
    const nameLen = buf.readUInt16LE(cd + 28);
    assert.equal(buf.subarray(cd + 46, cd + 46 + nameLen).toString("utf8"), "作品_001.png");
    // 1つめのファイルの中身は、ローカルヘッダー（30 バイト＋名前）のすぐあと。
    assert.deepEqual([...buf.subarray(30 + nameLen, 30 + nameLen + 3)], [1, 2, 3]);
  });

  it("CRC32 は標準の値になる", () => {
    assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
  });
});

describe("書き出す前の検査（OUT-09）", () => {
  const check = (text: string, s: Settings, target: "pdf" | "images" = "pdf") => {
    const r = typesetLazy(text, s, face);
    return preflight({ settings: s, pageCount: r.pageCount, page: r.page, missingChars: r.missingChars, fontWarnings: [], target });
  };

  it("ふつうの原稿では、直すことは出ない（ページ数が4の倍数でないことだけ知らせる）", () => {
    const found = check("吾輩は猫である。名前はまだ無い。", settings((s) => ((s.note1 = "作品名"), (s.note2 = "作者"))));
    assert.deepEqual(found.map((f) => f.level), ["info"]);
    assert.match(found[0].message, /4 の倍数/);
  });

  it("書体にない文字は error で知らせる", () => {
    const found = check("𠮷野家と\u{1F600}", settings());
    const error = found.find((f) => f.level === "error");
    assert.ok(error && error.message.includes("\u{1F600}"));
  });

  it("余白が狭く、仕上がり線の近くに文字があれば知らせる", () => {
    const s = settings((s) => {
      s.layoutMode = "book";
      s.book.topMm = 1;
    });
    const found = check("本文", s);
    assert.ok(found.some((f) => f.level === "warning" && f.message.includes("5mm 未満")));
    assert.ok(found.some((f) => f.level === "warning" && f.message.includes("断裁で切れる")));
  });

  it("色の付いた文字と紙の色を、入稿用では知らせる。グレースケールでは濃淡になると知らせる", () => {
    const colored = settings((s) => ((s.textColor = "#9e3d3f"), (s.paperColor = "#fef4f4")));
    const found = check("本文", colored).map((f) => f.message);
    assert.ok(found.some((m) => m.includes("掛け合わせ")));
    assert.ok(found.some((m) => m.includes("紙の色を刷りません")));
    const gray = check("本文", { ...colored, output: { ...colored.output, color: "gray" } }).map((f) => f.message);
    assert.ok(gray.some((m) => m.includes("グレーの濃淡")));
  });

  it("画像の書き出しでは、ページ数と紙の色のことは言わない", () => {
    const found = check("本文", settings((s) => (s.paperColor = "#fef4f4")), "images");
    assert.deepEqual(found, []);
  });
});

describe("背幅（OUT-10）", () => {
  it("本文の紙の枚数（2ページで1枚）× 紙の厚さ", () => {
    const s = settings();
    assert.equal(spineWidthMm(200, s.output), 100 * 0.11);
    assert.equal(spineWidthMm(201, { ...s.output, paper: "厚さを入れる", paperThicknessMm: 0.1 }), 101 * 0.1);
  });

  it("読み込んだ書き出しの設定は、知らない値を既定に戻す", () => {
    const s = normalizeSettings({ output: { color: "sepia", imposition: "spread", paper: "和紙", paperThicknessMm: 5 } });
    assert.deepEqual(s.output, { ...DEFAULT_SETTINGS.output, imposition: "spread" });
  });
});
