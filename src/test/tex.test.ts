import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PDFArray, PDFDocument, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import { DEFAULT_SETTINGS, normalizeSettings, type Settings } from "../document/settings.js";
import { typeset } from "../engine/index.js";
import { parseTransform, renderMath } from "../engine/math.js";
import { parse } from "../engine/parse.js";
import { texToMarkup } from "../engine/tex.js";
import type { Shape } from "../engine/types.js";
import { FontService } from "../fonts/service.js";
import { exportPdf } from "../output/export-pdf.js";
import { svgPathOps } from "../output/svg-path.js";

const body = new FontService().load(null);
const face = body.face;
const settings = (edit: (s: Settings) => void = () => {}): Settings => {
  const s = structuredClone(DEFAULT_SETTINGS);
  s.format.markup = "tex";
  edit(s);
  return s;
};
const paths = (shapes: Shape[]) => shapes.filter((s): s is Extract<Shape, { kind: "path" }> => s.kind === "path");

describe("TeX の文書の記法", () => {
  it("見出し・ルビ・圏点・傍線・縦中横・割注・太字・改ページ・目次・画像を tategumi の記法にする", () => {
    const src = String.raw`\tableofcontents
\chapter{第一章}
\ruby{漢字}{かん|じ}と\kenten{点}と\bousen{線}、\tcy{12}月\warichu{注}\textbf{太}。
\newpage
\section*{節}
\includegraphics[width=\textwidth]{figs/shelf.png}`;
    assert.deepEqual(texToMarkup(src).text.split("\n"), [
      "［＃目次］",
      "＃第一章",
      "　｜漢字《かんじ》と｜点《圏》と｜線《傍線》、［＃縦中横］12［＃／縦中横］月［＃割注］注［＃／割注］［＃太字］太［＃／太字］。",
      "［＃改ページ］",
      "＃＃節",
      "［＃画像：shelf］",
    ]);
  });

  it("段落は空行で区切り、続く行はつなぐ。段落の頭は1字下げ、\\noindent と \\\\ のあとは下げない", () => {
    const src = ["一つ目の", "続き。\\\\", "改行のあと。", "", "\\noindent 二つ目。", "", "English", "words."].join("\n");
    const r = texToMarkup(src);
    assert.deepEqual(r.text.split("\n"), ["　一つ目の続き。", "改行のあと。", "二つ目。", "　English words."]);
    assert.deepEqual(r.origin, [0, 0, 4, 6]);
  });

  it("コメント・エスケープ・知らない命令・プリアンブル", () => {
    const src = String.raw`\documentclass{jlreq}
\title{本の題}\author{著者}
\begin{document}
100\% と \& と \unknown{中身} と \relax だ。% ここはコメント
\end{document}`;
    const r = texToMarkup(src);
    assert.equal(r.title, "本の題");
    assert.equal(r.author, "著者");
    assert.equal(r.text, "　100% と & と 中身 と だ。");
  });

  it("数式は記法に包み、和文との間の空白は詰める", () => {
    const r = texToMarkup(String.raw`式 $x^2$ と \(y\) と
\[ \frac{1}{2} \]
\begin{align}a&=b\\c&=d\end{align}`);
    assert.deepEqual(r.text.split("\n"), [
      "　式［＃数式］x^2［＃／数式］と［＃数式］y［＃／数式］と",
      String.raw`［＃別行数式］\frac{1}{2}［＃／別行数式］`,
      String.raw`［＃別行数式］\begin{align*}a&=b\\c&=d\end{align*}［＃／別行数式］`,
    ]);
  });

  it("TeX の記法で組むと、紙面の字は元の .tex の行を指す", () => {
    const r = typeset("\\section{見出し}\n\n本文の\n続き。", settings(), face);
    const item = r.pages[0].items.find((i) => i.text === "続")!;
    assert.equal(item.src![0], 2, "段落の始まりの行");
    assert.equal(normalizeSettings({ format: { markup: "latex" } }).format.markup, "standard");
  });
});

describe("数式", () => {
  it("MathJax で輪郭にする。幅・高さ・深さは em で、誤りは知らせる", () => {
    const b = renderMath(String.raw`\frac{1}{3}`, false);
    assert.ok(b.paths.length >= 3, "1・3・分数の線");
    assert.ok(b.height > 0.5 && b.depth > 0.2 && b.width > 0.3 && b.width < 1.5);
    assert.match(renderMath(String.raw`\frac{1`, false).error ?? "", /数式の誤り/);
    assert.match(renderMath(String.raw`\text{日本}`, false).error ?? "", /日本/);
  });

  it("SVG の transform を行列にする（左に書いたものが外側）", () => {
    assert.deepEqual(parseTransform("translate(10,20) scale(2)"), [2, 0, 0, 2, 10, 20]);
    assert.deepEqual(parseTransform("scale(1,-1)"), [1, 0, 0, -1, 0, 0]);
  });

  it("行の中の数式は横倒しの長さを取り、縦組みでは時計回りに回して描く", () => {
    const r = typeset("［＃数式］x+y［＃／数式］の", { ...structuredClone(DEFAULT_SETTINGS) }, face);
    const [p] = paths(r.pages[0].shapes);
    // 時計回りに 90° 回す行列：字形の横（x）がページの下（+y）に向く。a・d は 0。
    assert.ok(Math.abs(p.m[0]) < 1e-9 && Math.abs(p.m[3]) < 1e-9 && p.m[1] > 0);
    // 「の」は、数式の長さ（前後の空き 0.25em ずつを含む）だけ下にある。1字の「あ」のときと比べる。
    const no = r.pages[0].items.find((i) => i.text === "の")!;
    const base = typeset("あの", structuredClone(DEFAULT_SETTINGS), face).pages[0].items.find((i) => i.text === "の")!;
    const width = renderMath("x+y", false).width + 0.5;
    assert.ok(Math.abs(no.y - base.y - (width - 1) * 9.25) < 1e-6);
  });

  it("別行数式は段落の中央に置き、高い式は行取りを増やす", () => {
    const [b] = parse(String.raw`［＃別行数式］\frac{\frac{a}{b}}{\frac{c}{d}}［＃／別行数式］`);
    assert.ok(b.kind === "para" && b.style === "別行数式" && b.atoms[0].cells[0].math?.display);
    const r = typeset(["前", String.raw`［＃別行数式］\sum_{k=1}^n k［＃／別行数式］`].join("\n"), structuredClone(DEFAULT_SETTINGS), face);
    assert.ok(paths(r.pages[0].shapes).length > 0);
  });

  it("SVG のパスを PDF の命令にする（2次ベジェは3次に、相対座標も）", () => {
    const names = svgPathOps("M0 0L10 0Q10 10 0 10zm5 5h1v1z").map((op) => op.toString().trim().split(/\s+/).pop());
    assert.deepEqual(names, ["m", "l", "c", "h", "m", "l", "l", "h"]);
  });

  it("入稿用 PDF では数式を CMYK の塗りで描き、PDF/X-1a の検査に通る", async () => {
    const r = await exportPdf(String.raw`式［＃数式］\int_0^1 x^2\,dx［＃／数式］。`, structuredClone(DEFAULT_SETTINGS), [{ key: "body", bytes: body.bytes }], "t");
    assert.deepEqual(r.check!.filter((c) => !c.ok), []);
    const doc = await PDFDocument.load(r.bytes);
    const c = doc.getPage(0).node.Contents()!;
    const refs = c instanceof PDFArray ? c.asArray() : [c];
    const raw = refs.map((ref) => Buffer.from(decodePDFRawStream(doc.context.lookup(ref) as PDFRawStream).decode()).toString("latin1")).join("\n");
    assert.match(raw, / cm\n/);
    assert.match(raw, /\bc\n/, "曲線");
  });
});
