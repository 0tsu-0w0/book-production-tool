// CI（Mac など）で起動と書き出しを確かめるための文書を作る。
//   vertical.tategumi   縦組みの文庫（本扉・目次・奥付、ルビ・圏点・傍線・割注・縦中横・画像・数式）
//   horizontal.tategumi 横組みの A5
//   math.tex            TeX の記法と数式
//   hiragino.tategumi   その PC のヒラギノ明朝（なければ同梱のフォント）で組む文書
import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import { serializeDocument } from "../dist/document/document.js";
import { BUILTIN_TEMPLATES } from "../dist/document/template.js";
import { FontService } from "../dist/fonts/service.js";

const out = process.argv[2] ?? "ci";
fs.mkdirSync(out, { recursive: true });

// 画像：横長の色の帯（透明あり）。
const png = new PNG({ width: 800, height: 600 });
for (let y = 0; y < 600; y++) {
  for (let x = 0; x < 800; x++) {
    const i = (y * 800 + x) * 4;
    png.data.set([Math.round((x / 800) * 255), 120, Math.round((y / 600) * 255), x < 40 ? 0 : 255], i);
  }
}
const images = [{ name: "帯", mime: "image/png", data: PNG.sync.write(png).toString("base64"), width: 800, height: 600 }];

const info = { title: "確認用の本", author: "山田花子", publisher: "たてぐみ堂", printer: "", issued: "2026年10月1日　初版発行", extra: "" };
const para = "　図書館の灯りは、夜になっても消えなかった。｜司書《ししょ》の彼女は「おかえりなさい」と言った。";
const body = [
  "＃第一章　灯り",
  para.repeat(4),
  "　｜大事《圏》な話と、｜線の話《傍線》と、［＃割注］ここは割注［＃／割注］と、12月25日。",
  "［＃画像：帯　５行　回り込み］",
  para.repeat(6),
  "　式［＃数式］x^2+\\frac{1}{3}［＃／数式］も組める。",
  "［＃別行数式］\\int_0^1 x^2\\,dx = \\frac{1}{3}［＃／別行数式］",
  "＃＃一　書架",
  para.repeat(8),
  "＃第二章　閉架",
  para.repeat(10),
].join("\n");

const vertical = structuredClone(BUILTIN_TEMPLATES[0].settings);
vertical.bookInfo = info;
vertical.pages = { front: [{ kind: "title", text: "" }, { kind: "toc", text: "" }], back: [{ kind: "colophon", text: "" }], padTo: 4 };
fs.writeFileSync(path.join(out, "vertical.tategumi"), serializeDocument({ text: body, settings: vertical, images }));

const horizontal = structuredClone(vertical);
Object.assign(horizontal.book, { writingMode: "horizontal", trim: "A5", widthMm: 148, heightMm: 210, fontSizePt: 9.25, charsPerLine: 34, linesPerPage: 30, topMm: 22, gutterMm: 20 });
fs.writeFileSync(path.join(out, "horizontal.tategumi"), serializeDocument({ text: body, settings: horizontal, images }));

fs.writeFileSync(
  path.join(out, "math.tex"),
  String.raw`\documentclass{jlreq}
\title{数式の見本}\author{山田花子}
\begin{document}
\chapter{二次方程式}
二次方程式 $ax^2+bx+c=0$ の解は
\[ x = \frac{-b \pm \sqrt{b^2-4ac}}{2a} \]
である。\ruby{行列}{ぎょうれつ} $A=\begin{pmatrix}1&2\\3&4\end{pmatrix}$ の行列式は $\det A=-2$。
\end{document}
`,
);

// その PC のヒラギノ明朝（Mac）。なければ同梱のフォントのまま。
const fonts = new FontService().list();
const hiragino = fonts.find((f) => /Hiragino ?Mincho|ヒラギノ明朝/i.test(`${f.name} ${f.postscriptName}`));
const withFont = structuredClone(vertical);
if (hiragino) withFont.font = { name: hiragino.name, postscriptName: hiragino.postscriptName, path: hiragino.path, index: hiragino.index };
withFont.pages = { front: [], back: [], padTo: 1 };
fs.writeFileSync(path.join(out, "hiragino.tategumi"), serializeDocument({ text: body, settings: withFont, images }));
console.log(`確認用の文書を ${out} に作りました（ヒラギノ明朝：${hiragino ? `${hiragino.name}（${hiragino.cff ? "CFF" : "TrueType"}）` : "見つからないので同梱のフォント"}）。`);
