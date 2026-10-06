import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS, fitBookToWritingMode, toLayoutSpec, type Settings } from "../document/settings.js";
import { newCharacterStyle, newParagraphStyle, normalizeStyles } from "../document/styles.js";
import { dropCapScale, splitDropCap } from "../engine/dropcap.js";
import { Face, typesetLazy } from "../engine/index.js";
import { parseInline } from "../engine/parse.js";
import { FontService } from "../fonts/service.js";
import { buildEpub } from "../output/epub.js";

let bytes: Uint8Array | undefined;
try {
  bytes = new FontService().load(null).bytes;
} catch {
  bytes = undefined;
}

/** 段落スタイル「書き出し」に、3行・1字・文字スタイル「朱」のドロップキャップを付けた設定。 */
function withDropCap(lines = 3, chars = 1, horizontal = false): Settings {
  const s = structuredClone(DEFAULT_SETTINGS);
  if (horizontal) {
    s.layoutMode = "book";
    s.book.writingMode = "horizontal";
    fitBookToWritingMode(s.book);
  }
  s.styles.character.push({ ...newCharacterStyle("朱"), color: "#b23a2a" });
  s.styles.paragraph.push({ ...newParagraphStyle("書き出し"), dropCap: { lines, chars, style: "朱" } });
  return s;
}

const LONG = `［＃書き出し］　ある晴れた日のこと。${"図書館の窓には朝から雨が打ちつけ、閲覧室には誰もいなかった。".repeat(4)}`;

describe("ドロップキャップ", () => {
  it("頭の空白を落として、大きくする字と残りに分ける。割注や注の所で止める", () => {
    const parts = splitDropCap(parseInline("　｜昔々《むかしむかし》、ある所に"), 2)!;
    assert.deepEqual(
      parts.cap.flatMap((a) => a.cells.map((c) => c.text)),
      ["昔", "々"],
    );
    assert.equal(parts.rest[0].cells[0].text, "、");
    assert.equal(splitDropCap(parseInline("　　"), 1), undefined);
    // 2字を頼んでも、ルビの付いた語は分けない（語ごと大きくする）。
    assert.equal(splitDropCap(parseInline("｜東京《とうきょう》へ"), 1)!.cap[0].cells.length, 2);
    assert.equal(dropCapScale(3, 1.75, 1), 4.5);
  });

  it("設定を読み込むとき、行数は 0 か 2〜5、字数は 1〜5 にそろえる", () => {
    const sheet = normalizeStyles({ paragraph: [{ name: "本文", dropCap: { lines: 1, chars: 9, style: "朱" } }, { name: "引用", dropCap: { lines: 7 } }] });
    assert.deepEqual(sheet.paragraph.find((p) => p.name === "本文")!.dropCap, { lines: 0, chars: 5, style: "朱" });
    assert.equal(sheet.paragraph.find((p) => p.name === "引用")!.dropCap.lines, 5);
    assert.equal(sheet.paragraph.find((p) => p.name === "大見出し")!.dropCap.lines, 0);
  });

  it("縦組み：大きな字は3行にまたがる大きさで、行の頭に。またがる3行は大きな字の長さだけ下げ、4行目から元に戻る", { skip: !bytes && "フォントがない" }, () => {
    const s = withDropCap();
    const spec = toLayoutSpec(s);
    const size = spec.fontSizePt;
    const r = typesetLazy(LONG, s, new Face(bytes!));
    const page = r.page(0);
    const big = page.items.find((i) => i.text === "あ")!;
    const em = dropCapScale(3, spec.lineGap, 1);
    assert.ok(Math.abs(big.size - size * em) < 0.01, `大きさ ${big.size}`);
    assert.equal(big.color, "#b23a2a");
    // 大きな字は原稿の位置に置かず、残りの字が下げて始まる。行の文字（校正の補助）には大きな字も入る。
    const lines = r.lines(0).map((l) => l.text);
    assert.ok(lines[0].startsWith("ある"), lines[0]);
    const length = Math.ceil(em);
    const firstOf = (t: string) => page.items.find((i) => i.text === t)!;
    // 1行目の最初の字「る」は、版面の頭から length 字下がる。4行目は下げない。
    const top = Math.min(...page.items.filter((i) => i.size === size).map((i) => i.y));
    assert.ok(firstOf("る").y - top > (length - 0.5) * size, "またがる行は下げる");
    assert.ok(lines.length >= 4);
  });

  it("段落がまたがる行数より短いときは、残りの行を空けて、次の段落と重ならない", { skip: !bytes && "フォントがない" }, () => {
    const s = withDropCap();
    const face = new Face(bytes!);
    const r = typesetLazy("［＃書き出し］短い。\n　次の段落。", s, face);
    const plain = typesetLazy("　短い。\n　次の段落。", structuredClone(DEFAULT_SETTINGS), face);
    const xOf = (res: typeof r, t: string) => res.page(0).items.find((i) => i.text === t)!.x;
    // 次の段落は、ドロップキャップがないときより2行ぶん左（縦組み）。
    const pitch = toLayoutSpec(s).fontSizePt * toLayoutSpec(s).lineGap;
    assert.ok(Math.abs(xOf(plain, "次") - xOf(r, "次") - 2 * pitch) < 0.5);
  });

  it("横組みでも、大きな字は行の頭（左）に置き、またがる行を右へずらす", { skip: !bytes && "フォントがない" }, () => {
    const r = typesetLazy(LONG, withDropCap(2, 1, true), new Face(bytes!));
    const page = r.page(0);
    const big = page.items.find((i) => i.text === "あ")!;
    const ru = page.items.find((i) => i.text === "る")!;
    assert.ok(big.x < ru.x, "大きな字が左");
    assert.ok(big.size > ru.size * 2);
  });

  it("ページの最後の行に掛かるときは、段落ごと次の段へ送る（大きな字が版面の外に出ない）", { skip: !bytes && "フォントがない" }, () => {
    const s = withDropCap();
    const per = toLayoutSpec(s).linesPerPage;
    // 1ページ目の残りが2行になるように本文を詰めてから、3行のドロップキャップの段落。
    const filler = Array.from({ length: per - 2 }, () => "　一行。").join("\n");
    const r = typesetLazy(`${filler}\n${LONG}`, s, new Face(bytes!));
    assert.ok(!r.page(0).items.some((i) => i.text === "あ"));
    assert.ok(r.page(1).items.some((i) => i.text === "あ"));
  });

  it("EPUB：initial-letter で最初の字を大きくし、頭の空白を落とす", () => {
    const s = withDropCap();
    const files = buildEpub(LONG, s, [], new Date(0));
    const css = new TextDecoder().decode(files.find((f) => f.name.endsWith("style.css"))!.data);
    const i = s.styles.paragraph.findIndex((p) => p.name === "書き出し");
    assert.match(css, new RegExp(`\\.ps${i}::first-letter\\{initial-letter:3;-webkit-initial-letter:3;color:#b23a2a\\}`));
    const xhtml = new TextDecoder().decode(files.find((f) => /p001\.xhtml$/.test(f.name))!.data);
    assert.match(xhtml, new RegExp(`<p class="ps${i}">ある晴れた`));
  });
});
