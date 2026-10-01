// 組版の各段階にかかる時間を測る。
//   使い方: npm run build && node scripts/make-test-doc.mjs --book && node scripts/bench.mjs [文書.tategumi]
import fs from "node:fs";
import { serialize } from "node:v8";
import { parseDocument } from "../dist/document/document.js";
import { toFormatOptions, toLayoutSpec, toPageDecor, toParseOptions } from "../dist/document/settings.js";
import { decoratePage } from "../dist/engine/decorate.js";
import { formatText } from "../dist/engine/format.js";
import { glyphPaths, typeset } from "../dist/engine/index.js";
import { layoutDocument } from "../dist/engine/layout.js";
import { parse } from "../dist/engine/parse.js";
import { measureRotated, resolvePage } from "../dist/engine/resolve.js";
import { FontService } from "../dist/fonts/service.js";

const file = process.argv[2] ?? "out/book.tategumi";
const { text, settings } = parseDocument(fs.readFileSync(file, "utf8"));
const { face } = new FontService().load(settings.font);

const time = (label, fn) => {
  const t = performance.now();
  const r = fn();
  console.log(`${label.padEnd(24)}${(performance.now() - t).toFixed(1).padStart(8)} ms`);
  return r;
};

console.log(`${[...text].length.toLocaleString()}字`);
for (const round of [1, 2]) {
  console.log(`--- ${round}回目 ---`);
  const spec = toLayoutSpec(settings);
  const formatted = time("整形", () => formatText(text, toFormatOptions(settings)).text);
  const blocks = time("記法の読み取り", () => parse(formatted, toParseOptions(settings)));
  time("横倒しの測定", () => measureRotated(blocks, face));
  const layouts = time("行・ページの割り付け", () => layoutDocument(blocks, spec));
  time("ページ要素", () => layouts.forEach((p) => decoratePage(p, toPageDecor(settings), spec.fontSizePt)));
  const pages = time("字形の割り当て", () => layouts.map((p) => resolvePage(p, face, settings.textColor)));
  const result = time("typeset（全体）", () => typeset(text, settings, face));
  // 画面には、見えているページと前後の数ページ（6ページ分）だけを送る。
  const shown = result.pages.slice(100, 106);
  const bytes = time("画面へ送るデータの複製", () => serialize({ pages: shown, paths: glyphPaths(shown, face) }).length);
  console.log(`${pages.length}ページ、1回に送るデータ ${(bytes / 1024).toFixed(0)}KB（全ページなら ${(serialize(result.pages).length / 1024 / 1024).toFixed(1)}MB）`);
}
