// CI で、書き出した PDF を PDF/X-1a・PDF/X-4 の検査にかける。1つでも通らなければ失敗で終わる。
// 閲覧用（PDF/X でない）の PDF は、ページ数だけを書く。
import fs from "node:fs";
import { PDFDocument } from "pdf-lib";
import { checkPdfX } from "../dist/output/check-pdfx.js";

let failed = false;
for (const file of process.argv.slice(2)) {
  if (!fs.existsSync(file)) {
    console.log(`NG  ${file}：ありません`);
    failed = true;
    continue;
  }
  const bytes = fs.readFileSync(file);
  const pages = (await PDFDocument.load(bytes)).getPageCount();
  // PDF 1.6 なら PDF/X-4、それ以外は PDF/X-1a として調べる。
  const standard = bytes.subarray(0, 8).toString("latin1") === "%PDF-1.6" ? "x4" : "x1a";
  const items = await checkPdfX(bytes, standard);
  const ng = items.filter((i) => !i.ok);
  console.log(`${ng.length === 0 ? "OK" : "NG"}  ${file}（${pages}ページ、${bytes.length} バイト、検査 ${items.length - ng.length}/${items.length}）`);
  for (const i of ng) console.log(`      ${i.rule}${i.detail ? `：${i.detail}` : ""}`);
  if (ng.length > 0) failed = true;
}
process.exit(failed ? 1 : 0);
