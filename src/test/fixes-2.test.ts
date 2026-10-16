import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { importIdml } from "../document/idml-import.js";
import { DEFAULT_SETTINGS, type Settings } from "../document/settings.js";
import { DEFAULT_STYLES, newCharacterStyle } from "../document/styles.js";
import { childElements, findAll, parseXml } from "../document/xml.js";
import { Face, typesetLazy } from "../engine/index.js";
import type { PageMark } from "../engine/types.js";
import { FontService } from "../fonts/service.js";
import { buildEpub } from "../output/epub.js";
import { buildIdml } from "../output/idml.js";
import { ZipWriter } from "../output/zip.js";

let bytes: Uint8Array | undefined;
try {
  bytes = new FontService().load(null).bytes;
} catch {
  bytes = undefined;
}
const noFont = !bytes && "フォントがない";
const dec = new TextDecoder();

function settings(over: (s: Settings) => void = () => {}): Settings {
  const s = structuredClone(DEFAULT_SETTINGS);
  s.styles = structuredClone(DEFAULT_STYLES);
  over(s);
  return s;
}

function zipOf(files: { name: string; data: Uint8Array }[]): Uint8Array {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kolophon-fix2-")), "t.idml");
  const zip = new ZipWriter(file);
  for (const f of files) zip.add(f.name, f.data);
  zip.close();
  return new Uint8Array(fs.readFileSync(file));
}
const withoutHint = (files: { name: string; data: Uint8Array }[]) => files.filter((f) => f.name !== "META-INF/kolophon.json");

describe("字間：横倒しの欧文にも効く", () => {
  it("語の字の数だけ長くなり、字形は1字ずつ離して描く", { skip: noFont }, () => {
    const s = settings((x) => (x.format.halfWidth = "rotate"));
    const face = new Face(bytes!);
    const word = (text: string) => typesetLazy(text, s, face).page(0).items.find((i) => i.text === "ABCD")!;
    const plain = word("あABCDい");
    const spaced = word("あ［＃字間：200］ABCD［＃／字間］い");
    const gaps = (it: typeof plain) => it.glyphs.slice(1).map((g, k) => g.dx - it.glyphs[k].dx);
    // 字と字の間が 0.2 字ずつ広がる（字形の単位で upem × 0.2）。
    gaps(spaced).forEach((g, k) => assert.ok(Math.abs(g - gaps(plain)[k] - face.upem * 0.2) < 1, `${g} ${gaps(plain)[k]}`));
    // 次の字（い）も、4字分の字間だけ後ろへ。
    const after = (text: string) => typesetLazy(text, s, face).page(0).items.find((i) => i.text === "い")!.y;
    const size = plain.size;
    assert.ok(Math.abs(after("あ［＃字間：200］ABCD［＃／字間］い") - after("あABCDい") - size * 0.8) < 0.01);
  });
});

describe("ルビの揃え・側をスタイルごとに", () => {
  it("文字スタイルで肩付き・左にすると、その字のルビだけ変わる。EPUB にもクラスで入る", { skip: noFont }, () => {
    const s = settings((x) => x.styles.character.push({ ...newCharacterStyle("肩"), rubyAlign: "shoulder", rubySide: "left" }));
    const face = new Face(bytes!);
    const text = "あ｜図書館《とし》い［＃肩］｜本棚《ほん》［＃／肩］う";
    const items = typesetLazy(text, s, face).page(0).items;
    const at = (t: string) => items.find((i) => i.text === t)!;
    // 既定（右）のルビは親文字の右、肩の文字スタイルのルビは左。
    assert.ok(at("と").x > at("図").x);
    assert.ok(at("ほ").x < at("本").x);
    // 肩付き：ルビの1字目は親文字の頭から（中付きより上）。
    assert.ok(at("ほ").y < at("本").y + at("本").size * 0.1);
    const css = dec.decode(buildEpub(text, s, []).find((f) => f.name === "OEBPS/style.css")!.data);
    assert.match(css, /\.cs\d+ ruby\{ruby-position:under;[^}]*ruby-align:start;\}/);
  });
});

describe("行スタイル：大きさ・字間も当てる", () => {
  it("最初の1行の字を大きくして組み直す（入る字が減る）。2行目からは元の大きさ", { skip: noFont }, () => {
    const s = settings((x) => {
      x.styles.character.push({ ...newCharacterStyle("大"), scale: 1.5 });
      x.styles.paragraph.find((p) => p.name === "本文")!.lineStyle = { style: "大", lines: 1 };
    });
    const plain = settings();
    const face = new Face(bytes!);
    const text = "あ".repeat(120);
    const r = typesetLazy(text, s, face);
    const lines = r.lines(0).map((l) => l.text.length);
    const base = typesetLazy(text, plain, face).lines(0).map((l) => l.text.length);
    assert.ok(lines[0] < base[0], `${lines[0]} ${base[0]}`);
    assert.equal(lines[1], base[1]);
    const sizes = r.page(0).items.filter((i) => i.text === "あ").map((i) => i.size);
    assert.ok(Math.abs(sizes[0] / sizes[sizes.length - 1] - 1.5) < 0.001);
    // 組み直しても同じ（字の長さの変え方が積み重ならない）。
    assert.deepEqual(typesetLazy(text, s, face).lines(0).map((l) => l.text.length), lines);
  });
});

describe("IDML の表", () => {
  const TABLE = ["［＃表］", "| 名前 | 値 | 備考 |", "|:---:|---:|---|", "| 雨 | 1 | < |", "| ^ | 2 | 晴れ |", "［＃／表］"].join("\n");

  it("InDesign の表として書き出す：見出しの行・欄の揃え・つないだ欄・罫", () => {
    const r = buildIdml(TABLE, settings(), { pageCount: 1 });
    const story = parseXml(dec.decode(r.files.find((f) => f.name === "Stories/Story_u1.xml")!.data));
    const table = findAll(story, "Table")[0];
    assert.deepEqual([table.attrs.HeaderRowCount, table.attrs.BodyRowCount, table.attrs.ColumnCount], ["1", "2", "3"]);
    const cells = findAll(table, "Cell").map((c) => [c.attrs.Name, c.attrs.ColumnSpan, c.attrs.RowSpan]);
    assert.deepEqual(cells, [
      ["0:0", "1", "1"],
      ["1:0", "1", "1"],
      ["2:0", "1", "1"],
      ["0:1", "1", "2"],
      ["1:1", "2", "1"],
      ["1:2", "1", "1"],
      ["2:2", "1", "1"],
    ]);
    const just = findAll(table, "Cell").map((c) => childElements(c, "ParagraphStyleRange")[0].attrs.Justification);
    assert.deepEqual(just.slice(0, 3), ["CenterAlign", "RightAlign", "LeftAlign"]);
    assert.equal(findAll(table, "Column").length, 3);
    const styles = dec.decode(r.files.find((f) => f.name === "Resources/Styles.xml")!.data);
    assert.match(styles, /<TableStyle Self="TableStyle\/\$ID\/\[Basic Table\]"/);
  });

  it("読み込むと、つないだ欄を「<」「^」に戻した表の記法になる", () => {
    const r = buildIdml(TABLE, settings(), { pageCount: 1 });
    const back = importIdml(zipOf(withoutHint(r.files)));
    assert.deepEqual(back.text.split("\n").slice(0, 6), ["［＃表］", "| 名前 | 値 | 備考 |", "|---|---|---|", "| 雨 | １ | < |", "| ^ | ２ | 晴れ |", "［＃／表］"]);
    // （半角の数字は、Kolophon の組み方どおり全角で書き出したもの）
  });
});

describe("IDML の柱", () => {
  const mark = (parts: PageMark["parts"], x: number, y: number, align: PageMark["align"], extra: Partial<PageMark> = {}): PageMark => ({ parts, x, y, size: 7, align, color: "#000000", ...extra });

  it("柱は見出しを拾うテキスト変数に、章の始まりのページは別のマスターに、小口の柱は縦書きの枠に", () => {
    const s = settings((x) => (x.layoutMode = "book"));
    const pages = [
      { images: [], opening: true, marks: [mark([{ kind: "nombre" }], 30, 400, "left")] },
      { images: [], marks: [mark([{ kind: "head", source: "book-title", text: "雨の本" }], 270, 30, "right"), mark([{ kind: "nombre" }], 270, 400, "right")] },
      { images: [], marks: [mark([{ kind: "nombre" }, { kind: "head", source: "chapter", text: "第一章" }], 30, 30, "left"), mark([{ kind: "head", source: "section", text: "一" }], 20, 40, "left", { vertical: true, height: 300 })] },
    ];
    const r = buildIdml("＃第一章\n本文。", s, { pageCount: 3, pages });
    const spreadPages = r.files.filter((f) => f.name.startsWith("Spreads/")).flatMap((f) => findAll(parseXml(dec.decode(f.data)), "Page"));
    assert.deepEqual(
      spreadPages.map((p) => p.attrs.AppliedMaster),
      ["uo", "um", "um"],
    );
    const dm = dec.decode(r.files.find((f) => f.name === "designmap.xml")!.data);
    assert.match(dm, /<TextVariable Self="dTextVariablen柱（章）" Name="柱（章）" VariableType="MatchParagraphStyleType"><MatchParagraphStylePreference [^>]*AppliedParagraphStyle="ParagraphStyle\/大見出し" SearchStrategy="LastOnPage"/);
    assert.match(dm, /MasterSpread_uo\.xml/);
    const stories = r.files.filter((f) => /Stories\/Story_un/.test(f.name)).map((f) => dec.decode(f.data));
    // 右ページ（右綴じの偶数）：書名の字。左ページ：ノンブルと章の柱を1行に、節の柱は縦書き。
    assert.ok(stories.some((st) => st.includes("<Content>雨の本</Content>")));
    assert.ok(stories.some((st) => /<Content><\?ACE 18\?><\/Content><Content>　<\/Content><TextVariableInstance [^>]*Name="柱（章）"[^>]*ResultText="第一章"/.test(st)));
    assert.ok(stories.some((st) => st.includes('StoryOrientation="Vertical"') && st.includes('Name="柱（節）"')));

    // 読み込み：本文のマスターから、柱とノンブルの設定に戻す。
    const back = importIdml(zipOf(withoutHint(r.files)));
    const m = back.settings.master;
    assert.equal(m.bodyOdd, "chapter");
    assert.equal(m.bodyEven, "book-title");
    assert.equal(m.bookTitle, "雨の本");
    assert.equal(m.bodyNombre, true);
    assert.ok(!back.notes.some((n) => n.startsWith("マスターページ")), back.notes.join());
  });

  it("組版：本の柱とノンブルを置いた所と中身をページに残す（章の始まりのページも）", { skip: noFont }, () => {
    const s = settings((x) => {
      x.layoutMode = "book";
      x.master = { ...x.master, bookTitle: "雨の本", bodyOdd: "chapter", bodyEven: "book-title", bodyNombre: true, openingNombre: true, openingOdd: "none", openingEven: "none" };
    });
    const r = typesetLazy(["＃第一章", "あ".repeat(2000)].join("\n"), s, new Face(bytes!));
    const first = r.page(0);
    assert.equal(first.opening, true);
    assert.deepEqual(first.marks?.map((m) => m.parts.map((p) => p.kind)), [["nombre"]]);
    const later = [1, 2].map((i) => r.page(i).marks?.flatMap((m) => m.parts) ?? []);
    const heads = later.flat().filter((p) => p.kind === "head");
    assert.deepEqual(heads.map((h) => (h.kind === "head" ? [h.source, h.text] : [])).sort(), [["book-title", "雨の本"], ["chapter", "第一章"]].sort());
  });
});
