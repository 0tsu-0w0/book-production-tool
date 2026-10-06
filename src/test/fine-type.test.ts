import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS, normalizeSettings, type Settings } from "../document/settings.js";
import { DEFAULT_STYLES, normalizeStyles } from "../document/styles.js";
import { Face, typesetLazy } from "../engine/index.js";
import { parse } from "../engine/parse.js";
import { withoutPage } from "../engine/xref.js";
import { FontService } from "../fonts/service.js";
import { buildEpub } from "../output/epub.js";
import { preflight } from "../output/preflight.js";

let bytes: Uint8Array | undefined;
try {
  bytes = new FontService().load(null).bytes;
} catch {
  bytes = undefined;
}
const noFont = !bytes && "フォントがない";

const settings = (over: (s: Settings) => void = () => {}): Settings => {
  const s = structuredClone(DEFAULT_SETTINGS);
  over(s);
  return s;
};

/** 1ページ目の、その字の位置（最初のもの）。 */
function glyph(text: string, s: Settings, t: string, nth = 0) {
  const r = typesetLazy(text, s, new Face(bytes!));
  const found = r.page(0).items.filter((i) => i.text === t);
  assert.ok(found[nth], `${t} がない`);
  return found[nth];
}

const cellsOf = (line: string) => {
  const [b] = parse(line);
  assert.ok(b.kind === "para");
  return { block: b, cells: b.atoms.flatMap((a) => a.cells) };
};

describe("字間（トラッキング・カーニング）", () => {
  it("記法：［＃字間：N］…［＃／字間］の字に字間、［＃カーニング：N］は前の字に付く。行頭でも段落スタイルにならない", () => {
    const { block, cells } = cellsOf("［＃字間：－100］あい［＃／字間］う［＃カーニング：+200］え");
    assert.equal(block.style, undefined);
    assert.deepEqual(
      cells.map((c) => [c.text, c.tracking, c.kern]),
      [
        ["あ", -100, undefined],
        ["い", -100, undefined],
        ["う", undefined, 200],
        ["え", undefined, undefined],
      ],
    );
    // 範囲の外の値は収める。
    assert.equal(cellsOf("［＃字間：5000］あ［＃／字間］").cells[0].tracking, 1000);
  });

  it("組版：字間の分だけ次の字が離れる（詰めれば近づく）。カーニングはその字の後ろだけ", { skip: noFont }, () => {
    const s = settings();
    const size = glyph("あいう", s, "あ").size;
    const gap = (text: string, a: string, b: string) => (glyph(text, s, b).y - glyph(text, s, a).y) / size;
    assert.equal(Math.round(gap("あいう", "あ", "い") * 1000), 1000);
    assert.equal(Math.round(gap("［＃字間：100］あいう［＃／字間］", "あ", "い") * 1000), 1100);
    assert.equal(Math.round(gap("［＃字間：－250］あいう［＃／字間］", "い", "う") * 1000), 750);
    assert.equal(Math.round(gap("あ［＃カーニング：－300］いう", "あ", "い") * 1000), 700);
    assert.equal(Math.round(gap("あ［＃カーニング：－300］いう", "い", "う") * 1000), 1000);
  });

  it("スタイルの字間：段落スタイルの字間、文字スタイルの字間（0 なら段落のまま）。原稿の字間が優先", { skip: noFont }, () => {
    const s = settings((x) => {
      x.styles = structuredClone(DEFAULT_STYLES);
      x.styles.paragraph.find((p) => p.name === "本文")!.tracking = 200;
      x.styles.character.push({ ...structuredClone(x.styles.character[0]), name: "詰め", tracking: -200 });
    });
    const size = glyph("あいう", s, "あ").size;
    const gap = (text: string, a: string, b: string) => Math.round(((glyph(text, s, b).y - glyph(text, s, a).y) / size) * 1000);
    assert.equal(gap("あいう", "あ", "い"), 1200);
    assert.equal(gap("［＃詰め］あい［＃／詰め］う", "あ", "い"), 800);
    assert.equal(gap("［＃詰め］［＃字間：0］あい［＃／字間］［＃／詰め］う", "あ", "い"), 1000);
  });

  it("字を詰めると1行に入る字が増える。スタイルを読むとき字間は範囲に収める", { skip: noFont }, () => {
    const s = settings();
    const text = "あ".repeat(200);
    const per = (t: string) => typesetLazy(t, s, new Face(bytes!)).lines(0)[0].text.length;
    assert.ok(per(`［＃字間：－200］${text}［＃／字間］`) > per(text));
    const st = normalizeStyles({ paragraph: [{ name: "本文", tracking: -9999 }], character: [{ name: "x", tracking: "a" }] });
    assert.equal(st.paragraph.find((p) => p.name === "本文")!.tracking, -500);
    assert.equal(st.character[0].tracking, 0);
  });
});

describe("ルビの位置", () => {
  // 3字の親文字に2字のルビ。ルビの字の中心を、親文字の頭からの字数で見る。
  const text = "あ｜図書館《とし》い";
  const rubyCenters = (over: (s: Settings) => void) => {
    const s = settings(over);
    const base = glyph(text, s, "図");
    const size = base.size;
    return ["と", "し"].map((t) => {
      const g = glyph(text, s, t);
      return Math.round(((g.y + g.size / 2 - base.y) / size) * 100) / 100;
    });
  };

  it("揃え：1-2-1 は親文字に均等に配り、中付きは詰めて中央、肩付きは詰めて親文字の頭から", { skip: noFont }, () => {
    // 位置は字形の原点なので、1-2-1 の1字目からのずれで比べる（親文字3字・ルビ2字。ルビの字は半分の大きさ）。
    const [a, b] = rubyCenters(() => {});
    const rel = (xs: number[]) => xs.map((v) => Math.round((v - a) * 100) / 100);
    // 1-2-1：字の間は 1.5 字（3字を2つに分ける）。
    assert.equal(Math.round((b - a) * 100) / 100, 1.5);
    // 中付き：詰めて（間は 0.5 字）中央に。肩付き：詰めて親文字の頭から（1-2-1 の1字目は頭から 0.75 字）。
    assert.deepEqual(rel(rubyCenters((s) => (s.typography.rubyAlign = "center"))), [0.5, 1]);
    assert.deepEqual(rel(rubyCenters((s) => (s.typography.rubyAlign = "shoulder"))), [-0.5, 0]);
    // 行の向きにずらす。
    assert.deepEqual(rel(rubyCenters((s) => ((s.typography.rubyAlign = "shoulder"), (s.typography.rubyShift = 0.5)))), [0, 0.5]);
  });

  it("側と離す量：左に置ける。離す量の分だけ親文字から離れる", { skip: noFont }, () => {
    const xOf = (over: (s: Settings) => void) => {
      const s = settings(over);
      return { base: glyph(text, s, "図").x, ruby: glyph(text, s, "と").x, size: glyph(text, s, "図").size };
    };
    const right = xOf(() => {});
    assert.ok(right.ruby > right.base);
    const left = xOf((s) => (s.typography.rubySide = "left"));
    assert.ok(left.ruby < left.base);
    // 右と左のルビの行の間は、親文字の幅とルビの幅（半分の大きさ）を足した 1.5 字。
    assert.ok(Math.abs(right.ruby - left.ruby - 1.5 * right.size) < 0.01, `${right.ruby - left.ruby}`);
    const far = xOf((s) => (s.typography.rubyGap = 0.2));
    assert.ok(Math.abs(far.ruby - right.ruby - 0.2 * right.size) < 0.01);
  });

  it("肩付きの長いルビは前の字に掛けない。設定を読むとき値を収める", { skip: noFont }, () => {
    const t = "あ｜雨《あめあめ》い";
    const center = settings((s) => (s.typography.mode = "jis"));
    const shoulder = settings((s) => ((s.typography.mode = "jis"), (s.typography.rubyAlign = "shoulder")));
    const top = (s: Settings) => glyph(t, s, "め").y - glyph(t, s, "雨").y;
    // 中付きは前の「あ」に掛かって上から始まる。肩付きは親文字の頭から。
    assert.ok(top(shoulder) > top(center));
    const n = normalizeSettings({ typography: { rubyAlign: "x", rubySide: "up", rubyGap: 9, rubyShift: -9 } }).typography;
    assert.deepEqual([n.rubyAlign, n.rubySide, n.rubyGap, n.rubyShift], ["121", "right", 0.5, -1]);
  });

  it("EPUB：左（下）・肩付きは CSS で伝える", () => {
    const out = buildEpub("｜雨《あめ》", settings((s) => ((s.typography.rubySide = "left"), (s.typography.rubyAlign = "shoulder"))), []);
    const css = new TextDecoder().decode(out.find((f) => f.name === "OEBPS/style.css")!.data);
    assert.match(css, /ruby\{ruby-position:under;[^}]*ruby-align:start;\}/);
  });
});

describe("相互参照", () => {
  const doc = ["＃第一章　雨の朝", "　本文。", "＃＃傘の話［＃ラベル：傘］", "　傘は青い。", "［＃改ページ］", "＃第二章　晴れ", "　［＃見出し：傘］・［＃章：傘］・［＃参照：傘］・［＃参照：傘｜〈章〉の〈ページ〉ページ］・［＃見出し：ない］"].join("\n");

  it("見出しの字・章の題・ページ番号を書式どおりに入れる。ないラベルは「？」で、検査で知らせる", { skip: noFont }, () => {
    const r = typesetLazy(doc, settings(), new Face(bytes!));
    const all = Array.from({ length: r.pageCount }, (_, i) => r.lines(i).map((l) => l.text).join("")).join("");
    assert.match(all, /傘の話・第一章　雨の朝・「傘の話」（１ページ）・第一章　雨の朝の１ページ・？/);
    assert.deepEqual(r.missingLabels, ["ない"]);
    const found = preflight({ settings: settings(), pageCount: 0, page: () => assert.fail(), missingChars: [], fontWarnings: [], target: "pdf", missingLabels: r.missingLabels });
    assert.ok(found.some((f) => f.level === "warning" && f.message.includes("「ない」")));
  });

  it("参照の字は参照先へのリンク。行頭の［＃ページ：名前］も段落スタイルにならない", { skip: noFont }, () => {
    const r = typesetLazy(doc, settings(), new Face(bytes!));
    const last = r.page(r.pageCount - 1);
    assert.ok(last.shapes.some((s) => s.kind === "link" && s.target === "l:傘"));
    const [b] = parse("［＃ページ：傘］ページ");
    assert.ok(b.kind === "para" && b.style === undefined && b.atoms[0].pageRef === "傘");
  });

  it("EPUB ではページ番号の所を除く", () => {
    assert.equal(withoutPage("「〈見出し〉」（〈ページ〉ページ）"), "「〈見出し〉」");
    assert.equal(withoutPage("「〈見出し〉」の〈ページ〉ページ"), "「〈見出し〉」");
    const out = buildEpub(doc, settings(), []);
    const html = out.filter((f) => f.name.endsWith(".xhtml")).map((f) => new TextDecoder().decode(f.data)).join("");
    assert.match(html, /「傘の話」・/);
    assert.ok(!html.includes("〈"));
  });
});
