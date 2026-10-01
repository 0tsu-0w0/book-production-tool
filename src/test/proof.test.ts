import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SPEC, layoutDocument } from "../engine/layout.js";
import { parse } from "../engine/parse.js";
import { checkLines, findVariants } from "../engine/proof.js";
import type { LayoutSpec } from "../engine/types.js";

describe("表記ゆれ（DTP-16）", () => {
  it("同じ語の漢字とかなの書き分けを、回数と最初の場所つきで挙げる", () => {
    const groups = findVariants("今日は何も出来ない。\n明日ならできない事もない。\nやっぱりできない。");
    const g = groups.find((x) => x.forms.some((f) => f.form === "出来ない"))!;
    assert.deepEqual(g.forms, [
      { form: "出来ない", count: 1, line: 1, index: 5 },
      { form: "できない", count: 2, line: 2, index: 4 },
    ]);
  });

  it("片方の書き方しかなければ挙げない", () => {
    assert.deepEqual(findVariants("できる。できない。わかる。"), []);
  });

  it("カタカナ語の長音の有無と、数字の全角・半角の混在", () => {
    const groups = findVariants("コンピューターを使う。\nコンピュータは便利。\n第1章と第２章。");
    assert.deepEqual(groups.map((g) => g.kind).sort(), ["digits", "long-vowel"]);
    const lv = groups.find((g) => g.kind === "long-vowel")!;
    assert.deepEqual(lv.forms.map((f) => f.form), ["コンピューター", "コンピュータ"]);
  });
});

describe("組みの問題（DTP-16）", () => {
  const spec: LayoutSpec = { ...DEFAULT_SPEC, charsPerLine: 10 };
  const check = (src: string, over: Partial<LayoutSpec> = {}) => {
    const pages = layoutDocument(parse(src), { ...spec, ...over });
    return checkLines(pages.length, (i) => pages[i].lines);
  };

  it("禁則を弱くしたときに行頭に来た小書きの仮名・長音を挙げる", () => {
    // 10字目のあとに「ッ」が来る。弱い禁則では行頭に出る。
    const r = check("あいうえおかきくけこッとした。", { kinsoku: "weak" });
    assert.equal(r.kinsoku.length, 1);
    assert.match(r.kinsoku[0].reason, /行頭に「ッ」/);
    assert.equal(check("あいうえおかきくけこッとした。").kinsoku.length, 0, "強い禁則なら違反はない");
  });

  it("段落の最後の行が1字（句読点を除く）しかない行を挙げる", () => {
    const r = check("あいうえおかきくけこさ。\nあいうえおかきくけこさし。");
    assert.deepEqual(r.shortLast.map((x) => [x.page, x.line, x.text]), [[0, 2, "さ。"]]);
  });

  it("1行の段落は、段落末の1文字とは見ない", () => {
    assert.equal(check("あ。").shortLast.length, 0);
  });
});
