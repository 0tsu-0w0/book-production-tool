// CI（Mac など）で、その PC のフォントを tategumi がどう見つけるかを書き出す。
import { FontService } from "../dist/fonts/service.js";

const service = new FontService();
const list = service.list();
console.log(`見つけたフォント：${list.length}`);
console.log(`既定のフォント：${service.defaultChoice().name}`);
const cff = list.filter((f) => f.cff).length;
console.log(`うち CFF（.otf・.ttc の PostScript 系）：${cff}`);
for (const f of list.slice(0, 80)) console.log(`  ${f.name}\t${f.postscriptName}\t${f.cff ? "CFF" : "TrueType"}\t${f.path}#${f.index}`);
