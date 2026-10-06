import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS, fitBookToWritingMode, toLayoutSpec, type Settings } from "../document/settings.js";
import { newParagraphStyle, normalizeStyles } from "../document/styles.js";
import { Face, typesetLazy, type DrawPage, type Shape } from "../engine/index.js";
import { FontService } from "../fonts/service.js";
import { buildEpub } from "../output/epub.js";

let bytes: Uint8Array | undefined;
try {
  bytes = new FontService().load(null).bytes;
} catch {
  bytes = undefined;
}

/** 段落スタイル「引用」に、網掛け・前の罫（赤）・後の罫（青）・囲み罫（緑）を付けた設定。 */
function decorated(horizontal = false, length: "column" | "text" = "column"): Settings {
  const s = structuredClone(DEFAULT_SETTINGS);
  if (horizontal) {
    s.layoutMode = "book";
    s.book.writingMode = "horizontal";
    fitBookToWritingMode(s.book);
  }
  const q = newParagraphStyle("引用");
  q.decoration = {
    ruleBefore: { on: true, kind: "solid", width: 1, color: "#ff0000", gap: 0.5 },
    ruleAfter: { on: true, kind: "double", width: 1.5, color: "#0000ff", gap: 0.5 },
    border: { on: false, kind: "solid", width: 0.5, color: "#00aa00", gap: 0.5 },
    shading: "#eeeeee",
    pad: 0.5,
    length,
  };
  s.styles.paragraph.push(q);
  return s;
}

const lines = (p: DrawPage, color: string) => p.shapes.filter((s): s is Extract<Shape, { kind: "line" }> => s.kind === "line" && s.color === color);
const shading = (p: DrawPage) => p.shapes.filter((s): s is Extract<Shape, { kind: "rect" }> => s.kind === "rect" && s.fill === "#eeeeee");

describe("段落の罫線・網掛け", () => {
  it("設定を読み込むとき、足りない所を既定で補い、範囲に収める", () => {
    const sheet = normalizeStyles({ paragraph: [{ name: "本文", decoration: { ruleBefore: { on: true, width: 99, kind: "wavy" }, shading: "#123456", length: "text" } }] });
    const d = sheet.paragraph.find((p) => p.name === "本文")!.decoration;
    assert.equal(d.ruleBefore.on, true);
    assert.equal(d.ruleBefore.width, 10);
    assert.equal(d.ruleBefore.kind, "solid");
    assert.equal(d.ruleAfter.on, false);
    assert.equal(d.shading, "#123456");
    assert.equal(d.length, "text");
    assert.equal(sheet.paragraph.find((p) => p.name === "大見出し")!.decoration.shading, null);
  });

  it("縦組み：網は字の下に、前の罫は段落の右、後の罫（二重線）は左。字の位置は変わらない", { skip: !bytes && "フォントがない" }, () => {
    const face = new Face(bytes!);
    const text = "　前の段落。\n［＃引用］引用の段落です。".repeat(1) + "\n　後の段落。";
    const plain = structuredClone(DEFAULT_SETTINGS);
    plain.styles.paragraph.push(newParagraphStyle("引用"));
    const before = typesetLazy(text, plain, face).page(0);
    const page = typesetLazy(text, decorated(), face).page(0);
    // 字の位置は、罫線・網掛けのない組みと同じ。
    assert.deepEqual(
      page.items.map((i) => [i.text, i.x, i.y]),
      before.items.map((i) => [i.text, i.x, i.y]),
    );
    // 引用の段落にだけある字（前後の段落と重ならない字）。
    const quote = page.items.filter((i) => "引用で".includes(i.text));
    const qx = Math.max(...quote.map((i) => i.x));
    const red = lines(page, "#ff0000");
    const blue = lines(page, "#0000ff");
    assert.equal(red.length, 1);
    assert.equal(blue.length, 2, "二重線は2本");
    assert.ok(red[0].x1 > qx, "前の罫は右");
    assert.ok(blue.every((l) => l.x1 < Math.min(...quote.map((i) => i.x))), "後の罫は左");
    // 行の長さいっぱい：罫の長さは版面の字詰め。
    const spec = toLayoutSpec(plain);
    assert.ok(Math.abs(red[0].y2 - red[0].y1 - spec.charsPerLine * spec.fontSizePt) < 0.01);
    // 網は1つ、図形の先頭（字・画像の下）に。
    assert.equal(shading(page).length, 1);
    assert.equal(page.shapes.findIndex((s) => s.kind === "rect"), 0);
  });

  it("字のある所だけ：網と罫の長さが字に合う", { skip: !bytes && "フォントがない" }, () => {
    const face = new Face(bytes!);
    const page = typesetLazy("［＃引用］短い。", decorated(false, "text"), face).page(0);
    const rect = shading(page)[0];
    const size = toLayoutSpec(DEFAULT_SETTINGS).fontSizePt;
    // 3字（短い。）＋前後の空き 0.5字ずつ。
    assert.ok(Math.abs(rect.h - (3 + 1) * size) < 0.6, `網の長さ ${rect.h}`);
  });

  it("横組み：前の罫は上、後の罫は下", { skip: !bytes && "フォントがない" }, () => {
    const face = new Face(bytes!);
    const page = typesetLazy("　前。\n［＃引用］引用の段落です。\n　後。", decorated(true), face).page(0);
    const quote = page.items.filter((i) => i.text === "引");
    const red = lines(page, "#ff0000")[0];
    const blue = lines(page, "#0000ff");
    assert.ok(red.y1 === red.y2 && red.y1 < quote[0].y, "前の罫は横の線で、字の上");
    assert.ok(blue.every((l) => l.y1 > quote[0].y), "後の罫は字の下");
  });

  it("ページをまたぐ段落：前の罫は1ページ目だけ、後の罫は最後のページだけ。網はどちらのページにも", { skip: !bytes && "フォントがない" }, () => {
    const face = new Face(bytes!);
    const r = typesetLazy(`［＃引用］${"ページをまたぐ引用の段落。".repeat(60)}`, decorated(), face);
    assert.ok(r.pageCount >= 2);
    const first = r.page(0);
    const last = r.page(r.pageCount - 1);
    assert.equal(lines(first, "#ff0000").length, 1);
    assert.equal(lines(first, "#0000ff").length, 0);
    assert.equal(lines(last, "#ff0000").length, 0);
    assert.equal(lines(last, "#0000ff").length, 2);
    assert.equal(shading(first).length, 1);
    assert.equal(shading(last).length, 1);
  });

  it("囲み罫は4辺。続く2つの段落は別々に囲む", { skip: !bytes && "フォントがない" }, () => {
    const face = new Face(bytes!);
    const s = decorated();
    const q = s.styles.paragraph.find((p) => p.name === "引用")!.decoration;
    q.ruleBefore.on = false;
    q.ruleAfter.on = false;
    q.border.on = true;
    const page = typesetLazy("［＃引用］一つ目。\n［＃引用］二つ目。", s, face).page(0);
    assert.equal(lines(page, "#00aa00").length, 8);
    assert.equal(shading(page).length, 2);
  });

  it("EPUB：網・前後の罫・長さを CSS にする（囲み罫があるときは囲み罫だけ）", () => {
    const s = decorated(false, "text");
    const i = s.styles.paragraph.findIndex((p) => p.name === "引用");
    const css = () => new TextDecoder().decode(buildEpub("［＃引用］引用。", s, [], new Date(0)).find((f) => f.name.endsWith("style.css"))!.data);
    const rule = css().split("\n").find((l) => l.startsWith(`.ps${i}{`))!;
    assert.match(rule, /background-color:#eeeeee/);
    assert.match(rule, /border-block-start:1pt solid #ff0000/);
    assert.match(rule, /border-block-end:1\.5pt double #0000ff/);
    assert.match(rule, /inline-size:fit-content/);
    s.styles.paragraph[i].decoration.border.on = true;
    const boxed = css().split("\n").find((l) => l.startsWith(`.ps${i}{`))!;
    assert.match(boxed, /border:0\.5pt solid #00aa00/);
    assert.doesNotMatch(boxed, /border-block-start/);
  });
});
