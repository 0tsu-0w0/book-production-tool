import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS, bookGeometry, fitBookToWritingMode, horizontalPunctuation, normalizeSettings, toParseOptions, type Settings } from "../document/settings.js";
import { BUILTIN_TEMPLATES } from "../document/template.js";
import { DEFAULT_SPEC, layoutDocument } from "../engine/layout.js";
import { parse } from "../engine/parse.js";

const horizontal = (): Settings => {
  const s = structuredClone(DEFAULT_SETTINGS);
  s.layoutMode = "book";
  s.book.writingMode = "horizontal";
  return s;
};

describe("横組みの仕上げ", () => {
  it("組み方向を変えると、字数と行数を版面に収まるように決め直す", () => {
    const s = horizontal();
    fitBookToWritingMode(s.book);
    const g = bookGeometry(s.book);
    for (const v of [g.top, g.bottom, g.gutter, g.foreEdge]) assert.ok(v >= 10, JSON.stringify(g));
    s.book.writingMode = "vertical";
    fitBookToWritingMode(s.book);
    const v = bookGeometry(s.book);
    for (const m of [v.top, v.bottom, v.gutter, v.foreEdge]) assert.ok(m >= 10, JSON.stringify(v));
  });

  it("横組みでは半角の英数字を半角のまま、数字を縦中横にしない", () => {
    const o = toParseOptions(horizontal());
    assert.equal(o.halfWidth, "rotate");
    assert.equal(o.tcyDigits, false);
    const [p] = parse("2026年 abc", o);
    assert.ok(p.kind === "para");
    assert.deepEqual(p.atoms.map((a) => a.cells.map((c) => c.text).join("")), ["2026", "年", " ", "abc"]);
  });

  it("URL は「/」のあとで、ハイフンの語は「-」のあとで改行できる", () => {
    const [p] = parse("https://example.com/a/b well-known", toParseOptions(horizontal()));
    assert.ok(p.kind === "para");
    assert.deepEqual(p.atoms.map((a) => a.cells[0].text), ["https://", "example.com/", "a/", "b", " ", "well-", "known"]);
  });

  it("句読点を「，。」「，．」にできる（縦組みでは変えない）", () => {
    const s = horizontal();
    s.book.punctuation = "，．";
    assert.equal(horizontalPunctuation("雨、雪。", s), "雨，雪．");
    s.book.punctuation = "，。";
    assert.equal(horizontalPunctuation("雨、雪。", s), "雨，雪。");
    assert.equal(horizontalPunctuation("雨、雪。", { ...s, book: { ...s.book, writingMode: "vertical" } }), "雨、雪。");
    assert.equal(normalizeSettings({ book: { punctuation: "x" } }).book.punctuation, "、。");
  });

  it("注番号は行頭に出さない（前の字と一緒に次の行へ）", () => {
    const pages = layoutDocument(parse("あいう［＃注：x］"), { ...DEFAULT_SPEC, charsPerLine: 3 });
    const lines = pages[0].lines.map((l) => l.text);
    assert.ok(!lines.some((t) => t.startsWith("注")), JSON.stringify(lines));
  });

  it("横組みの両端揃えは、まず語間に空きを配る", () => {
    const spec = { ...DEFAULT_SPEC, charsPerLine: 10, horizontal: true };
    const blocks = parse("ab cd あいうえおかきくけこさしすせそ", { tcyDigits: false, halfWidth: "rotate", pageBreakMark: true });
    for (const b of blocks) if (b.kind === "para") for (const a of b.atoms) for (const c of a.cells) if (c.rotate) c.advance = c.text === " " ? 0.25 : c.text.length * 0.5;
    const [page] = layoutDocument(blocks, spec);
    const x = (t: string) => page.glyphs.find((g) => g.text === t)!.x;
    // 「ab」と「cd」の間は広がり、「あ」と「い」の間は1字のまま近い。
    const gapWord = x("cd") - x("ab");
    const gapKana = x("い") - x("あ");
    assert.ok(gapWord > 1.25 * spec.fontSizePt, `${gapWord}`);
    assert.ok(gapKana < 1.2 * spec.fontSizePt, `${gapKana}`);
  });

  it("標準のテンプレートに横組みの本がある", () => {
    assert.ok(BUILTIN_TEMPLATES.some((t) => t.settings.book.writingMode === "horizontal"));
  });
});
