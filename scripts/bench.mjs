// 組版の各段階にかかる時間を測る。
//   使い方: npm run build && node scripts/make-test-doc.mjs --book && node scripts/bench.mjs [文書.kolophon]
import fs from "node:fs";
import { serialize } from "node:v8";
import { parseDocument } from "../dist/document/document.js";
import { toFormatOptions, toLayoutSpec, toPageDecor, toParseOptions } from "../dist/document/settings.js";
import { decoratePage } from "../dist/engine/decorate.js";
import { formatText } from "../dist/engine/format.js";
import { glyphPaths, typesetLazy } from "../dist/engine/index.js";
import { layoutDocument } from "../dist/engine/layout.js";
import { parse } from "../dist/engine/parse.js";
import { applyProportional, measureRotated, resolvePage } from "../dist/engine/resolve.js";
import { prepareSpacing } from "../dist/engine/spacing.js";
import { applyStyles } from "../dist/engine/styles.js";
import { FontService } from "../dist/fonts/service.js";

const file = process.argv[2] ?? "out/book.kolophon";
const { text, settings, images } = parseDocument(fs.readFileSync(file, "utf8"));
const service = new FontService();
const { table } = service.loadTable(settings.font, settings.styles);
const faces = table.faces;
const infos = Object.fromEntries(images.map((i) => [i.name, { width: i.width, height: i.height }]));

const time = (label, fn) => {
  const t = performance.now();
  const r = fn();
  console.log(`${label.padEnd(24)}${(performance.now() - t).toFixed(1).padStart(8)} ms`);
  return r;
};

// エンジンの段落スタイル（index.ts の engineStyles と同じ。書体はすべて本文の書体）。
const engineStyles = {
  paragraph: new Map(settings.styles.paragraph.map((p) => [p.name, { ...p, font: 0 }])),
  character: new Map(settings.styles.character.map((c) => [c.name, { ...c, font: -1 }])),
  body: "本文",
  heading1: "大見出し",
  heading2: "中見出し",
};

console.log(`${[...text].length.toLocaleString()}字`);
for (const round of [1, 2, 3]) {
  console.log(`--- ${round}回目 ---`);
  const spec = { ...toLayoutSpec(settings), images: infos };
  const formatted = time("整形", () => formatText(text, toFormatOptions(settings)).text);
  const blocks = time("記法の読み取り", () => parse(formatted, toParseOptions(settings)));
  time("スタイル", () => applyStyles(blocks, engineStyles));
  time("横倒しの測定", () => measureRotated(blocks, faces));
  time("約物の詰め", () => prepareSpacing(blocks, spec.typography, spec.rubyScale));
  time("プロポーショナル", () => applyProportional(blocks, faces));
  const layouts = time("行・ページの割り付け", () => layoutDocument(blocks, spec));
  time("ページ要素", () => layouts.forEach((p) => decoratePage(p, toPageDecor(settings), spec.fontSizePt)));
  const pages = time("字形の割り当て（全ページ）", () => layouts.map((p) => resolvePage(p, faces, settings.textColor)));
  const lazy = time("typesetLazy（画面と同じ）", () => typesetLazy(text, settings, table, infos));
  // 画面には、見えているページと前後の数ページ（6ページ分）だけを送る。
  const shown = [100, 101, 102, 103, 104, 105].filter((i) => i < lazy.pageCount).map((i) => lazy.page(i));
  const bytes = time("画面へ送るデータの複製", () => serialize({ pages: shown, paths: glyphPaths(shown, table, new Map()) }).length);
  console.log(`${pages.length}ページ、1回に送るデータ ${(bytes / 1024).toFixed(0)}KB（全ページなら ${(serialize(pages).length / 1024 / 1024).toFixed(1)}MB）`);
}
