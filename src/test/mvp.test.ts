import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DocumentFormatError, newDocument, parseDocument, serializeDocument } from "../document/document.js";
import { CUSTOM_PRESET, DEFAULT_SETTINGS, PRESETS, customGrid, normalizeSettings, toLayoutSpec, toPageDecor } from "../document/settings.js";
import { decoratePage, mix, type PageDecor } from "../engine/decorate.js";
import { formatText, toKanjiNumeral, type FormatOptions } from "../engine/format.js";
import { DEFAULT_SPEC, breakLines, layoutDocument } from "../engine/layout.js";
import { parse, parseInline } from "../engine/parse.js";
import { extractFace, faceOffsets, readFaceInfo, type ReadAt } from "../fonts/sfnt.js";
import { hexToCmyk } from "../output/color.js";

const OFF: FormatOptions = {
  symbols: false,
  indent: false,
  dialogueBlankLines: false,
  digitsFullWidth: false,
  kanjiNumerals: false,
  spaceAfterMarks: false,
  limitMarks: false,
};
const fmt = (src: string, opts: Partial<FormatOptions>) => formatText(src, { ...OFF, ...opts }).text;

describe("自動整形", () => {
  it("FMT-01 符号を変換する", () => {
    assert.equal(fmt("あーーい--う", { symbols: true }), "あ――い――う");
    assert.equal(fmt("え...お・・・か…き", { symbols: true }), "え……お……か……き");
  });

  it("FMT-02 地の文だけを字下げし、会話文は字下げしない", () => {
    assert.equal(fmt("地の文\n「会話」\n　すでに字下げ", { indent: true }), "　地の文\n「会話」\n　すでに字下げ");
  });

  it("FMT-02 見出しと改ページの行はそのまま", () => {
    assert.equal(fmt("＃見出し\n＝＝＝", { indent: true }), "＃見出し\n＝＝＝");
  });

  it("FMT-03 会話文の前後の空行を削除し、2行以上の空行は残す", () => {
    assert.equal(fmt("地の文\n\n「会話」\n\nつづき\n\n\n場面転換", { dialogueBlankLines: true }), "地の文\n「会話」\nつづき\n\n\n場面転換");
  });

  it("FMT-06 数字を漢数字にする", () => {
    assert.equal(toKanjiNumeral("25"), "二十五");
    assert.equal(toKanjiNumeral("105"), "百五");
    assert.equal(toKanjiNumeral("10"), "十");
    assert.equal(toKanjiNumeral("2026"), "二〇二六");
    assert.equal(fmt("12月3日", { kanjiNumerals: true }), "十二月三日");
  });

  it("FMT-04 半角数字を全角にする", () => {
    assert.equal(fmt("12時", { digitsFullWidth: true }), "１２時");
  });

  it("FMT-07 文中の！？の後にだけ全角空白を入れる", () => {
    assert.equal(fmt("え！本当？　うそ!?」", { spaceAfterMarks: true }), "え！　本当？　うそ!?」");
  });

  it("FMT-08 3つ以上続く！？を2つにする", () => {
    assert.equal(fmt("なに！？！？", { limitMarks: true }), "なに！？");
  });

  it("ルビの読みの中は整形しない", () => {
    assert.equal(fmt("｜十二《じゅうに》...", { symbols: true, kanjiNumerals: true }), "｜十二《じゅうに》……");
    assert.equal(fmt("｜A《1...2》", { symbols: true }), "｜A《1...2》");
  });

  it("差分として、元の行ごとの結果を返す", () => {
    const { lines } = formatText("あ\n\n「い」", { ...OFF, dialogueBlankLines: true });
    assert.deepEqual(lines.map((l) => l.after), ["あ", null, "「い」"]);
  });
});

describe("半角英字の横倒し（IN-07）", () => {
  const rotate = { tcyDigits: true, halfWidth: "rotate" as const, pageBreakMark: true };

  it("英単語を横倒しの単位にし、2〜3桁の数字は縦中横のまま", () => {
    const atoms = parseInline("彼はNew Yorkへ12時に", rotate);
    const rotated = atoms.filter((a) => a.cells[0].rotate).map((a) => a.cells[0].text);
    assert.deepEqual(rotated, ["New", " ", "York"]);
    assert.ok(atoms.some((a) => a.cells[0].tcy && a.cells[0].text === "12"));
  });

  it("横倒しの長さ（em）で行を分ける", () => {
    const atoms = parseInline("あいHelloう", rotate);
    for (const a of atoms) for (const c of a.cells) if (c.rotate) c.advance = 2.5;
    const lines = breakLines(atoms, 4, 0, { kinsoku: "strong", hanging: true });
    assert.deepEqual(lines.map((l) => l.atoms.length), [2, 2]);
  });

  it("＝＝＝ の改ページは設定で切れる", () => {
    const blocks = parse("あ\n＝＝＝\nい", { ...rotate, pageBreakMark: false });
    assert.ok(blocks.every((b) => b.kind !== "pagebreak"));
  });
});

describe("設定", () => {
  it("参照元の10種類の字組が、どれも文庫判の中に収まる", () => {
    assert.equal(Object.keys(PRESETS).length, 10);
    for (const [name, p] of Object.entries(PRESETS)) {
      const spec = toLayoutSpec({ ...DEFAULT_SETTINGS, preset: name });
      const [page] = layoutDocument(parse("あ"), spec);
      const { block } = page;
      assert.ok(block.left > 5 && block.top > 5, `${name} の余白が狭すぎる`);
      assert.equal(spec.charsPerLine, p.charsPerLine);
    }
  });

  it("自分で設定した余白・文字サイズ・行間から字数と行数を求める", () => {
    const g = customGrid({ marginXMm: 12, marginYMm: 15, fontSizePt: 9.25, lineGapPercent: 167 });
    assert.equal(g.charsPerLine, 36);
    assert.equal(g.linesPerPage, 15);
    const spec = toLayoutSpec({ ...DEFAULT_SETTINGS, preset: CUSTOM_PRESET });
    assert.equal(spec.charsPerLine, 36);
  });

  it("古い・壊れた設定は既定値で補い、知らない項目は捨てる", () => {
    const s = normalizeSettings({ preset: "存在しない字組", kinsoku: "weak", format: { indent: true, bogus: 1 }, unknown: 3, font: { path: 1 } });
    assert.equal(s.preset, DEFAULT_SETTINGS.preset);
    assert.equal(s.kinsoku, "weak");
    assert.equal(s.format.indent, true);
    assert.equal(s.format.symbols, false);
    assert.equal(s.font, null);
    assert.ok(!("unknown" in s));
  });
});

describe("文書ファイル", () => {
  it("保存した文書を読み直すと同じ内容になる", () => {
    const doc = newDocument("本文");
    doc.settings.note1 = "作品名";
    const back = parseDocument(serializeDocument(doc));
    assert.deepEqual(back, doc);
  });

  it("tategumi の文書でないもの、新しすぎる版は読まない", () => {
    assert.throws(() => parseDocument("{}"), DocumentFormatError);
    assert.throws(() => parseDocument("not json"), DocumentFormatError);
    assert.throws(() => parseDocument(JSON.stringify({ format: "tategumi-document", version: 99, text: "" })), DocumentFormatError);
  });
});

describe("付記とノンブル", () => {
  const decor = (over: Partial<PageDecor> = {}): PageDecor => ({
    ...toPageDecor({ ...DEFAULT_SETTINGS, note1: "作品名", note2: "作者" }),
    ...over,
  });
  const page = (index: number) => layoutDocument(parse("あ"), DEFAULT_SPEC).map((p) => ({ ...p, index }))[0];
  const horiz = (p: ReturnType<typeof page>) => p.glyphs.filter((g) => g.kind === "horiz");

  it("付記1は左上、ノンブルは左下、付記2は右下", () => {
    const p = page(0);
    decoratePage(p, decor(), 9.25);
    const [note, nombre, note2] = horiz(p);
    assert.equal(note.text, "作品名");
    assert.equal(note.align, "left");
    assert.ok(note.y < p.block.top);
    assert.equal(nombre.text, "1");
    assert.ok(nombre.y > p.block.top + p.block.height);
    assert.equal(note2.align, "right");
  });

  it("見開き用配置では、偶数ページは左右反転し、付記を出さない", () => {
    const p = page(1); // 2ページ目
    decoratePage(p, decor({ spread: true }), 9.25);
    const texts = horiz(p);
    assert.deepEqual(texts.map((t) => t.text), ["2"]);
    assert.equal(texts[0].align, "right");
  });

  it("「どちらも左上」は番号と付記を1行にまとめる", () => {
    const p = page(0);
    decoratePage(p, decor({ placement: "both-tl" }), 9.25);
    assert.equal(horiz(p)[0].text, "1　作品名");
  });

  it("付記2を薄くすると、文字の色と紙の色の中間になる", () => {
    const p = page(0);
    decoratePage(p, decor({ note2Faint: true }), 9.25);
    const note2 = horiz(p).find((g) => g.text === "作者")!;
    assert.equal(note2.color, mix("#000000", "#ffffff", 0.45));
  });

  it("飾りと枠線を図形として加える", () => {
    const p = page(0);
    decoratePage(p, decor({ decoration: "circle-m", border: true }), 9.25);
    assert.ok(p.shapes.some((s) => s.kind === "circle"));
    assert.ok(p.shapes.some((s) => s.kind === "rect" && s.stroke));
  });
});

describe("色", () => {
  it("黒と灰色は K だけになる", () => {
    assert.deepEqual(hexToCmyk("#000000"), [0, 0, 0, 1]);
    assert.deepEqual(hexToCmyk("#808080").slice(0, 3), [0, 0, 0]);
  });
});

describe("フォントコレクション（.ttc）", () => {
  /** 2つの小さなフォントを持つ .ttc を組み立てる。 */
  function makeTtc(): Uint8Array {
    const face = (tag: string, payload: number[]) => {
      const table = Uint8Array.from(payload);
      return { tag, table };
    };
    const faces = [face("test", [1, 2, 3]), face("test", [4, 5, 6, 7, 8])];
    const headerSize = 12 + faces.length * 4;
    const faceHeaderSize = 12 + 16;
    let cursor = headerSize + faces.length * faceHeaderSize;
    const out = new Uint8Array(cursor + 32);
    const dv = new DataView(out.buffer);
    out.set([0x74, 0x74, 0x63, 0x66], 0); // "ttcf"
    dv.setUint32(4, 0x00010000);
    dv.setUint32(8, faces.length);
    faces.forEach((f, i) => {
      const at = headerSize + i * faceHeaderSize;
      dv.setUint32(12 + i * 4, at);
      dv.setUint32(at, 0x00010000);
      dv.setUint16(at + 4, 1);
      for (let k = 0; k < 4; k++) out[at + 12 + k] = f.tag.charCodeAt(k);
      dv.setUint32(at + 20, cursor);
      dv.setUint32(at + 24, f.table.length);
      out.set(f.table, cursor);
      cursor += 8;
    });
    return out;
  }

  it("n 番目のフォントを単体のフォントとして取り出す", () => {
    const ttc = makeTtc();
    const read: ReadAt = (o, l) => ttc.subarray(o, o + l);
    assert.equal(faceOffsets(read).length, 2);
    const single = extractFace(ttc, 1);
    const r2: ReadAt = (o, l) => single.subarray(o, o + l);
    assert.deepEqual(faceOffsets(r2), [0]);
    const info = readFaceInfo(r2, 0, 0);
    assert.equal(info.variable, false);
    const dv = new DataView(single.buffer, single.byteOffset);
    const offset = dv.getUint32(12 + 8);
    assert.deepEqual([...single.subarray(offset, offset + 5)], [4, 5, 6, 7, 8]);
  });
});
