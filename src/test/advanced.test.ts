import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PDFDocument } from "pdf-lib";
import { PNG } from "pngjs";
import { DEFAULT_SETTINGS, normalizeSettings, toLayoutSpec, type Settings } from "../document/settings.js";
import { parseTemplate, serializeTemplate } from "../document/template.js";
import { typeset } from "../engine/index.js";
import { layoutDocument } from "../engine/layout.js";
import { parse } from "../engine/parse.js";
import { FontService } from "../fonts/service.js";
import { exportPdf } from "../output/export-pdf.js";
import { preflight } from "../output/preflight.js";

const body = new FontService().load(null);
const face = body.face;
const fonts = [{ key: "body", bytes: body.bytes }];
const settings = (edit: (s: Settings) => void = () => {}): Settings => {
  const s = structuredClone(DEFAULT_SETTINGS);
  edit(s);
  return s;
};

describe("詳細設定", () => {
  it("ルビ・圏点の大きさ", () => {
    const size = (pct: number) => typeset("｜漢字《かんじ》", settings((s) => (s.advanced.rubyPercent = pct)), face).pages[0].items.find((i) => i.text === "か")!.size;
    assert.ok(Math.abs(size(60) / size(50) - 1.2) < 1e-9);
  });

  it("自動で縦中横にする桁数の上限", () => {
    const tcy = (max: number) => {
      const [b] = parse("2026年", { tcyDigits: true, halfWidth: "fullwidth", pageBreakMark: true, tcyMaxDigits: max });
      return b.kind === "para" && b.atoms[0].cells[0].tcy === true;
    };
    assert.equal(tcy(3), false);
    assert.equal(tcy(4), true);
  });

  it("行頭に置かない字を足すと、その字は行頭に来ない", () => {
    // 1行10字。11字目の「＊」が行頭に来るところを、足した禁則で前の行に追い込むか追い出す。
    const spec = (extra: string) => ({ ...toLayoutSpec(settings((s) => (s.advanced.kinsokuStartExtra = extra))), charsPerLine: 10 });
    const heads = (extra: string) => {
      const [page] = layoutDocument(parse("あいうえおかきくけこ＊さしすせ"), spec(extra));
      const xs = [...new Set(page.glyphs.map((g) => g.x))].sort((a, b) => b - a);
      return xs.map((x) => page.glyphs.filter((g) => g.x === x).sort((a, b) => a.y - b.y)[0].text);
    };
    assert.equal(heads("")[1], "＊", "ふつうは行頭に来る");
    assert.notEqual(heads("＊")[1], "＊", "足すと行頭に来ない");
  });

  it("付記・ノンブルの大きさ（かんたん）", () => {
    const nombre = (pct: number) => typeset("本文", settings((s) => (s.advanced.noteScalePercent = pct)), face).pages[0].items.find((i) => i.text === "1")!.size;
    assert.ok(Math.abs(nombre(100) / nombre(80) - 1.25) < 1e-9);
  });

  it("塗り足しの幅は PDF の BleedBox に効く", async () => {
    const bleedOf = async (mm: number) => {
      const r = await exportPdf("本文", settings((s) => (s.advanced.bleedMm = mm)), fonts, "t");
      const page = (await PDFDocument.load(r.bytes)).getPage(0);
      return (page.getBleedBox().width - page.getTrimBox().width) / 2 / (72 / 25.4);
    };
    assert.ok(Math.abs((await bleedOf(5)) - 5) < 0.01);
    assert.ok(Math.abs((await bleedOf(3)) - 3) < 0.01);
  });

  it("PDF の画像の解像度：設定を大きく超える画像だけ縮める", async () => {
    const png = new PNG({ width: 1600, height: 1200 });
    png.data.fill(200);
    const img = { name: "絵", mime: "image/png" as const, data: PNG.sync.write(png).toString("base64"), width: 1600, height: 1200 };
    const widthOf = async (ppi: number) => {
      const r = await exportPdf("［＃画像：絵］", settings((s) => (s.advanced.imagePpi = ppi)), fonts, "t", undefined, [img]);
      const m = /\/Width (\d+)/.exec(Buffer.from(r.bytes).toString("latin1"));
      return Number(m![1]);
    };
    // 文庫の版面（約 81mm 幅）に 1600px ≒ 500ppi。400ppi なら縮め、600ppi なら縮めない。
    assert.ok((await widthOf(400)) < 1600);
    assert.equal(await widthOf(600), 1600);
  });

  it("検査で文字を仕上がり線から離す距離", () => {
    const check = (mm: number) => {
      const s = settings((s) => (s.advanced.safeMarginMm = mm));
      const r = typeset("本文", s, face);
      return preflight({ settings: s, pageCount: r.pages.length, page: (i) => r.pages[i], missingChars: [], fontWarnings: [], target: "pdf" }).some((f) =>
        f.message.includes("断裁"),
      );
    };
    assert.equal(check(3), false);
    assert.equal(check(10), true, "10mm ならノンブルが近すぎる");
  });

  it("目次のリーダーの字", () => {
    const r = typeset("［＃目次］\n＃章\n本文", settings((s) => (s.toc.leader = "・")), face);
    assert.ok(r.pages[0].items.some((i) => i.text === "・"));
    assert.ok(!r.pages[0].items.some((i) => i.text === "…"));
  });

  it("範囲の外の値は範囲に収め、古い文書は既定の値になる", () => {
    const s = normalizeSettings({ advanced: { rubyPercent: 500, tcyMaxDigits: 9, bleedMm: -1 }, toc: { leader: "★" } });
    assert.equal(s.advanced.rubyPercent, 80);
    assert.equal(s.advanced.tcyMaxDigits, 4);
    assert.equal(s.advanced.bleedMm, 0);
    assert.equal(s.toc.leader, "…");
    assert.deepEqual(normalizeSettings({}).advanced, DEFAULT_SETTINGS.advanced);
  });

  it("テンプレートには詳細設定も入る", () => {
    const s = settings((s) => {
      s.advanced.rubyPercent = 60;
      s.advanced.kinsokuStartExtra = "ゝ";
    });
    const t = parseTemplate(serializeTemplate({ name: "私の設定", settings: s }));
    assert.equal(t.settings.advanced.rubyPercent, 60);
    assert.equal(t.settings.advanced.kinsokuStartExtra, "ゝ");
  });
});
