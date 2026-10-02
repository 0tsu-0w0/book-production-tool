import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRef } from "pdf-lib";
import { DEFAULT_SETTINGS, type Settings } from "../document/settings.js";
import { Face, typesetLazy } from "../engine/index.js";
import { checkPdfX } from "../output/check-pdfx.js";
import { exportPdf } from "../output/export-pdf.js";
import { FontService } from "../fonts/service.js";

let bytes: Uint8Array | undefined;
try {
  bytes = new FontService().load(null).bytes;
} catch {
  bytes = undefined;
}
const skip = !bytes && "フォントがない";

const TEXT = ["［＃目次］", "＝＝＝", "＃第一章　雨", "　雨が降る［＃注：梅雨のこと。］。続きは［＃ページ：kiri］から。", "＃＃一の二", "　まだ雨。", "＝＝＝", "＃第二章　霧［＃ラベル：kiri］", "　霧の中。"].join("\n");

function settings(over: (s: Settings) => void = () => {}): Settings {
  const s = structuredClone(DEFAULT_SETTINGS);
  s.notes.placement = "end";
  over(s);
  return s;
}

interface OutlineNode {
  title: string;
  children: OutlineNode[];
}

/** PDF のしおりを（題名, 子）の木にする。 */
async function outline(pdf: Uint8Array) {
  const doc = await PDFDocument.load(pdf);
  const root = doc.catalog.lookupMaybe(PDFName.of("Outlines"), PDFDict);
  const walk = (first: unknown): OutlineNode[] => {
    const out: OutlineNode[] = [];
    let ref = first;
    while (ref instanceof PDFRef) {
      const d = doc.context.lookup(ref, PDFDict);
      const title = (d.get(PDFName.of("Title")) as PDFHexString).decodeText();
      out.push({ title, children: walk(d.get(PDFName.of("First"))) });
      ref = d.get(PDFName.of("Next"));
    }
    return out;
  };
  return { doc, tree: root ? walk(root.get(PDFName.of("First"))) : [] };
}

/** ページごとのリンクの飛び先（ページ番号、0始まり）。 */
function links(doc: PDFDocument): number[][] {
  const pages = doc.getPages();
  return pages.map((p) => {
    const annots = p.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
    if (!annots) return [];
    return annots.asArray().map((r) => {
      const a = doc.context.lookup(r, PDFDict);
      const dest = a.lookup(PDFName.of("Dest"), PDFArray);
      const target = dest.get(0);
      return pages.findIndex((q) => q.ref === target);
    });
  });
}

describe("PDF のしおりとリンク", { skip }, () => {
  it("組んだページに、目次の項目・ページ番号の参照・注番号のリンクの範囲がある", () => {
    const r = typesetLazy(TEXT, settings(), new Face(bytes!));
    const targets = Array.from({ length: r.pageCount }, (_, i) => r.page(i).shapes.flatMap((s) => (s.kind === "link" ? [s.target] : [])));
    const all = targets.flat();
    assert.ok(all.includes("h:0") && all.includes("h:2"), JSON.stringify(targets));
    assert.ok(all.includes("l:kiri"));
    assert.ok(all.some((t) => t.startsWith("l:kolophon-note-")));
    assert.ok(all.some((t) => t.startsWith("l:kolophon-noteref-")));
  });

  it("閲覧用 PDF：しおりは大見出しの下に中見出し。リンクは見出し・ラベル・注のページへ飛ぶ", async () => {
    const r = await exportPdf(TEXT, settings((s) => (s.pdfKind = "screen")), [{ key: "", bytes: bytes! }], "t");
    const { doc, tree } = await outline(r.bytes);
    assert.deepEqual(
      tree.map((n) => [n.title, n.children.map((c) => c.title)]),
      [
        ["第一章　雨", ["一の二"]],
        ["第二章　霧", []],
      ],
    );
    const l = links(doc);
    // 目次（1ページ目）の項目は、見出しのあるページへ。
    const chapter2 = doc.getPages().length - 1;
    assert.ok(l[0].includes(chapter2), JSON.stringify(l));
    assert.ok(l.flat().every((t) => t >= 0), "飛び先のページがある");
    assert.ok(l.flat().length >= 5, JSON.stringify(l));
  });

  it("入稿用 PDF：しおりは付け、リンク（注釈）は付けない。PDF/X-1a の検査に通る", async () => {
    const r = await exportPdf(TEXT, settings(), [{ key: "", bytes: bytes! }], "t");
    const { doc, tree } = await outline(r.bytes);
    assert.equal(tree.length, 2);
    assert.deepEqual(links(doc).flat(), []);
    assert.deepEqual((await checkPdfX(r.bytes, "x1a")).filter((c) => !c.ok), []);
  });
});
