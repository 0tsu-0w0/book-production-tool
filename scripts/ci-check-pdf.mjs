// CI で、書き出した PDF を PDF/X-1a の検査にかける。1つでも通らなければ失敗で終わる。
// 閲覧用（PDF/X でない）の PDF は、ページ数だけを書く。
import fs from "node:fs";
import { PDFDocument } from "pdf-lib";
import { checkPdfX1a } from "../dist/output/check-pdfx.js";

let failed = false;
for (const file of process.argv.slice(2)) {
  if (!fs.existsSync(file)) {
    console.log(`NG  ${file}：ありません`);
    failed = true;
    continue;
  }
  const bytes = fs.readFileSync(file);
  const pages = (await PDFDocument.load(bytes)).getPageCount();
  const items = await checkPdfX1a(bytes);
  const ng = items.filter((i) => !i.ok);
  console.log(`${ng.length === 0 ? "OK" : "NG"}  ${file}（${pages}ページ、${bytes.length} バイト、検査 ${items.length - ng.length}/${items.length}）`);
  for (const i of ng) console.log(`      ${i.rule}${i.detail ? `：${i.detail}` : ""}`);
  if (ng.length > 0) failed = true;
}
process.exit(failed ? 1 : 0);
