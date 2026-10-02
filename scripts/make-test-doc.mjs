// 確認用の文書（out/test.kolophon）を作る。MVP の機能をひととおり使う設定にしてある。
//   使い方: npm run build && node scripts/make-test-doc.mjs [--book]
//   --book を付けると、同じ本文をくり返して文庫1冊分（約10万字）にした out/book.kolophon も作る。
import fs from "node:fs";
import { newDocument, serializeDocument } from "../dist/document/document.js";
import { SAMPLE_TEXT } from "../dist/sample.js";

// Web 小説風の原稿（空行・連続した！・半角英数字・ーー・... を含む）。
const web = [
  "ある晴れた日のこと。",
  "",
  "「おはよう！今日もいい天気だね！！！」",
  "",
  "彼女はNew Yorkから届いた手紙を読んでいた...差出人は25歳のJohn。",
  "",
  "ーーそれは、2026年の春のことだった。",
].join("\n");

const doc = newDocument(`${web}\n${SAMPLE_TEXT}`);
Object.assign(doc.settings, {
  note1: "雨の図書館",
  note2: "作・柊",
  note2Faint: true,
  placement: "note-tl.nombre-bc",
  decoration: "circle-m",
  paperColor: "#f8f4e6",
  textColor: "#2b4b65",
  decoColor1: "#9e3d3f",
  decoColor2: "#2b4b65",
});
Object.assign(doc.settings.format, {
  symbols: true,
  indent: true,
  dialogueBlankLines: true,
  spaceAfterMarks: true,
  limitMarks: true,
  halfWidth: "rotate",
});
const ttc = process.platform === "win32" ? "C:\\WINDOWS\\Fonts\\BIZ-UDMinchoM.ttc" : undefined;
if (ttc && fs.existsSync(ttc)) {
  doc.settings.font = { name: "BIZ UD明朝 Medium", postscriptName: "BIZ-UDMincho-Medium", path: ttc, index: 0 };
}

fs.mkdirSync("out", { recursive: true });
fs.writeFileSync("out/test.kolophon", serializeDocument(doc));
console.log("out/test.kolophon を作りました");

if (process.argv.includes("--book")) {
  const chapter = SAMPLE_TEXT.replace(/＝＝＝\n/g, "");
  let text = web;
  for (let i = 1; [...text].length < 100_000; i++) text += `\n＝＝＝\n${chapter.replace("第一章", `第${i}章`)}`;
  const book = { ...doc, text };
  fs.writeFileSync("out/book.kolophon", serializeDocument(book));
  console.log(`out/book.kolophon を作りました（${[...text].length.toLocaleString()}字）`);
}
