import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS, type Settings } from "../document/settings.js";
import { BUILTIN_PARAGRAPH_STYLES, DEFAULT_STYLES, fontKey, newCharacterStyle, newParagraphStyle, normalizeStyles } from "../document/styles.js";
import { typeset, type FontTable } from "../engine/index.js";
import { parse } from "../engine/parse.js";
import { BUNDLED_FONTS, FontService } from "../fonts/service.js";
import { checkPdfX1a } from "../output/check-pdfx.js";
import { PRINT_PDF, renderPdf } from "../output/pdf.js";

const service = new FontService();
const body = service.load(null);
const table: FontTable = { faces: [body.face], keys: [fontKey(body.choice)] };

const withStyles = (over: Partial<Settings["styles"]> = {}): Settings => ({
  ...DEFAULT_SETTINGS,
  styles: { paragraph: [...DEFAULT_STYLES.paragraph, ...(over.paragraph ?? [])], character: [...DEFAULT_STYLES.character, ...(over.character ?? [])] },
});
const bodyItems = (page: { items: { font: string; text: string; size: number; x: number; y: number; bold?: boolean; color: string; face: number }[] }) =>
  page.items.filter((i) => i.font === "vert");

describe("スタイルの記法", () => {
  it("行頭の［＃名前］は段落スタイル、［＃名前］…［＃／名前］は文字スタイル", () => {
    const [p, c] = parse("［＃引用］昔の話\nこれは［＃太字］大事［＃／太字］な話");
    assert.equal(p.kind === "para" && p.style, "引用");
    assert.ok(c.kind === "para");
    const styled = c.kind === "para" ? c.atoms.filter((a) => a.style === "太字").map((a) => a.cells[0].text) : [];
    assert.deepEqual(styled, ["大", "事"]);
  });

  it("行頭から文字スタイルで囲んだ行は、段落スタイルにしない", () => {
    const [b] = parse("［＃太字］大事［＃／太字］な話");
    assert.ok(b.kind === "para" && !b.style);
  });

  it("閉じ忘れた文字スタイルは、行の終わりで閉じる", () => {
    const [a, b] = parse("あ［＃太字］い\nう");
    assert.ok(a.kind === "para" && b.kind === "para");
    assert.equal(a.atoms[1].style, "太字");
    assert.equal(b.atoms[0].style, undefined);
  });

  it("行頭の［＃名前］が文字スタイルなら、その行全体に当てる", () => {
    const [page] = typeset("［＃太字］あい\nう", withStyles(), table).pages;
    const bold = bodyItems(page).map((i) => [i.text, !!i.bold]);
    assert.deepEqual(bold, [["あ", true], ["い", true], ["う", false]]);
  });
});

describe("段落スタイル（DTP-04）", () => {
  it("行取り3行の見出しは、取った3行の中央の行に置く", () => {
    const settings = withStyles();
    settings.styles.paragraph = settings.styles.paragraph.map((p) => (p.name === "大見出し" ? { ...p, lineSpan: 3 } : p));
    const [page] = typeset("＃章\n本文", settings, table).pages;
    const heading = bodyItems(page).find((i) => i.text === "章")!;
    const text = bodyItems(page).find((i) => i.text === "本")!;
    // 見出しは1〜3行目を取ってその中央（2行目）、本文は4行目。間は2行分。
    const lineGap = 9.25 * 1.67;
    assert.ok(Math.abs(heading.x - text.x - 2 * lineGap) < 0.01);
  });

  it("地付きの段落は、行の最後にそろえる", () => {
    const settings = withStyles({ paragraph: [{ ...newParagraphStyle("署名"), align: "end" }] });
    const [start] = typeset("柊", withStyles(), table).pages;
    const [end] = typeset("［＃署名］柊", settings, table).pages;
    const y = (page: typeof start) => bodyItems(page).find((i) => i.text === "柊")!.y;
    // 1行36字なので、地付きの字は行頭の字より35字分下にある。
    assert.ok(Math.abs(y(end) - y(start) - 35 * 9.25) < 1e-6);
  });

  it("前後の空きは空行として取る（ページの頭の前の空きは取らない）", () => {
    const settings = withStyles({ paragraph: [{ ...newParagraphStyle("場面"), spaceBefore: 2, spaceAfter: 1 }] });
    const [page] = typeset("あ\n［＃場面］い\nう", settings, table).pages;
    const x = (t: string) => bodyItems(page).find((i) => i.text === t)!.x;
    const lineGap = 9.25 * 1.67;
    assert.ok(Math.abs(x("あ") - x("い") - 3 * lineGap) < 0.01, "「い」の前に2行空く");
    assert.ok(Math.abs(x("い") - x("う") - 2 * lineGap) < 0.01, "「い」の後に1行空く");
  });

  it("文字サイズの倍率は、字の大きさと行方向の長さの両方に効く", () => {
    const settings = withStyles();
    settings.styles.paragraph = settings.styles.paragraph.map((p) => (p.name === "中見出し" ? { ...p, scale: 1.5, indent: 0 } : p));
    const [page] = typeset("＃＃大き", settings, table).pages;
    const [a, b] = bodyItems(page);
    assert.ok(Math.abs(a.size - 9.25 * 1.5) < 1e-9);
    assert.ok(Math.abs(b.y - a.y - 9.25 * 1.5) < 1e-9);
  });
});

describe("文字スタイルと複数のフォント", () => {
  const mincho = BUNDLED_FONTS[0];
  const second = service.list().find((f) => !f.cff && f.postscriptName !== mincho.postscriptName && /Gothic|ゴシック/.test(f.name));

  it("太字は擬似ボールド、色と倍率も当たる", () => {
    const settings = withStyles({ character: [{ ...newCharacterStyle("赤"), color: "#c85554", scale: 0.8 }] });
    const [page] = typeset("［＃太字］強［＃／太字］［＃赤］小［＃／赤］普", settings, table).pages;
    const [strong, small, plain] = bodyItems(page);
    assert.equal(strong.bold, true);
    assert.equal(small.color, "#c85554");
    assert.ok(Math.abs(small.size - 9.25 * 0.8) < 1e-9);
    assert.equal(plain.bold, undefined);
  });

  it("文字スタイルの書体は2つめのフォントで組み、PDF にも両方を埋め込む", { skip: !second && "ゴシック体がない" }, async () => {
    const settings = withStyles({ character: [{ ...newCharacterStyle("ゴシック"), font: second! }] });
    const loaded = service.loadTable(settings.font, settings.styles);
    assert.equal(loaded.table.faces.length, 2);
    const { pages } = typeset("明朝［＃ゴシック］ゴシ［＃／ゴシック］明［＃太字］太［＃／太字］", settings, loaded.table);
    const faces = bodyItems(pages[0]).map((i) => i.face);
    assert.deepEqual(faces, [0, 0, 1, 1, 0, 0]);

    const pdf = await renderPdf(pages, loaded.loaded.map((l) => l.bytes), { ...PRINT_PDF, title: "t" });
    assert.deepEqual((await checkPdfX1a(pdf)).filter((i) => !i.ok), []);
    const raw = Buffer.from(pdf).toString("latin1");
    assert.ok(raw.includes(second!.postscriptName), "2つめのフォントが埋め込まれている");
    assert.ok(raw.includes(body.choice.postscriptName), "本文のフォントも埋め込まれている");
  });
});

describe("スタイルの保存形式", () => {
  it("本文・大見出し・中見出しは消えても補い、値は範囲に収める", () => {
    const s = normalizeStyles({ paragraph: [{ name: "引用", scale: 99, lineSpan: -3, align: "weird" }], character: [] });
    assert.deepEqual(s.paragraph.map((p) => p.name).sort(), ["引用", ...BUILTIN_PARAGRAPH_STYLES].sort());
    const quote = s.paragraph.find((p) => p.name === "引用")!;
    assert.equal(quote.scale, 5);
    assert.equal(quote.lineSpan, 1);
    assert.equal(quote.align, "start");
    assert.deepEqual(s.character, []);
  });

  it("スタイルのない古い文書は、既定のスタイルになる", () => {
    assert.deepEqual(normalizeStyles(undefined), DEFAULT_STYLES);
  });
});
