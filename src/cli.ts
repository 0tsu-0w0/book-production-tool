// 画面を開かずに PDF を作る。
//   使い方: node dist/cli.js [原稿.txt または 文書.kolophon] [出力.pdf] [--screen] [--no-marks]
//   既定は入稿用（PDF/X-1a:2003・CMYK・トンボ付き）。--screen で閲覧用（RGB）。
import fs from "node:fs";
import path from "node:path";
import { parseDocument, type DocImage } from "./document/document.js";
import { DEFAULT_SETTINGS, compositeFonts, type Settings } from "./document/settings.js";
import { FontService } from "./fonts/service.js";
import { exportPdf } from "./output/export-pdf.js";
import { SAMPLE_TEXT } from "./sample.js";

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const [input, output = "out/sample.pdf"] = args.filter((a) => !a.startsWith("--"));

let text = SAMPLE_TEXT;
let settings: Settings = structuredClone(DEFAULT_SETTINGS);
let images: DocImage[] = [];
if (input && /\.(kolophon|tategumi)$/i.test(input)) ({ text, settings, images } = parseDocument(fs.readFileSync(input, "utf8")));
else if (input) text = fs.readFileSync(input, "utf8");
if (input?.endsWith(".tex")) settings.format.markup = "tex";
settings.pdfKind = flags.has("--screen") ? "screen" : flags.has("--no-marks") ? "print-nomarks" : settings.pdfKind;

const { loaded, table, warnings } = new FontService().loadTable(settings.font, settings.styles, compositeFonts(settings));
for (const w of warnings) console.warn(w);
const font = loaded[0];
const started = performance.now();
const result = await exportPdf(
  text,
  settings,
  loaded.map((l, i) => ({ key: table.keys[i], bytes: l.bytes })),
  path.basename(output, ".pdf"),
  undefined,
  images,
);
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, result.bytes);
console.log(
  `${result.pages}ページ → ${output}（${(result.bytes.length / 1024).toFixed(0)}KB、${(performance.now() - started).toFixed(0)}ms、フォント：${font.choice.name}）`,
);

if (result.check) {
  console.log("\nPDF/X-1a:2003 の検査");
  for (const item of result.check) console.log(`  ${item.ok ? "OK" : "NG"}  ${item.rule}${item.detail ? `（${item.detail}）` : ""}`);
  if (result.check.some((i) => !i.ok)) process.exitCode = 1;
}
