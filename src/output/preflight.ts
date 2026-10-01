import { bookGeometry, spreadOutput, type Settings } from "../document/settings.js";
import type { DrawPage } from "../engine/types.js";
import { hexToCmyk } from "./color.js";

// 書き出す前の検査（OUT-09）。組版の結果と設定から、入稿や閲覧で困りそうなことを挙げる。
// error：そのまま出すと文字が欠ける・切れるもの。warning：直したほうがよいもの。info：知っておくとよいこと。

export interface Finding {
  level: "error" | "warning" | "info";
  message: string;
}

export interface PreflightInput {
  settings: Settings;
  pageCount: number;
  page(index: number): DrawPage;
  missingChars: string[];
  /** フォントを読めずに代わりの書体にしたときの知らせ。 */
  fontWarnings: string[];
  target: "pdf" | "images";
  /** 文書の画像の大きさ（ピクセル）。 */
  images?: Record<string, { width: number; height: number }>;
  /** 組めなかった数式の知らせ。 */
  mathErrors?: string[];
}

const MM = 72 / 25.4;
/** 断裁でずれても文字が切れないよう、仕上がり線から離しておく距離。 */
export const SAFE_MARGIN_MM = 3;

/** ページ番号の並びを短く書く（最初の数件だけ）。 */
function pageList(numbers: number[], max = 6): string {
  const shown = numbers.slice(0, max).join("・");
  return numbers.length > max ? `${shown} ほか${numbers.length - max}ページ` : shown;
}

export function preflight(input: PreflightInput): Finding[] {
  const { settings: s, pageCount, target } = input;
  const out: Finding[] = [];
  const print = target === "pdf" && s.pdfKind !== "screen";
  const gray = s.output.color === "gray";
  const first = s.nombreStart;

  for (const w of input.fontWarnings) out.push({ level: "warning", message: w });
  if (input.missingChars.length > 0) {
    const chars = input.missingChars.slice(0, 20).join("");
    const more = input.missingChars.length > 20 ? ` ほか${input.missingChars.length - 20}字` : "";
    out.push({ level: "error", message: `書体にない文字があり、空白になります：${chars}${more}。書体を変えるか、文字を置き換えてください。` });
  }

  for (const e of input.mathErrors ?? []) out.push({ level: "error", message: e });

  if (s.layoutMode === "book") {
    const g = bookGeometry(s.book);
    const sides = { 天: g.top, 地: g.bottom, ノド: g.gutter, 小口: g.foreEdge };
    const over = Object.entries(sides).filter(([, v]) => v < 0).map(([k]) => k);
    const tight = Object.entries(sides).filter(([, v]) => v >= 0 && v < 5).map(([k]) => k);
    if (over.length > 0) out.push({ level: "error", message: `版面がページからはみ出しています（${over.join("・")}）。字数・行数・余白を見直してください。` });
    if (tight.length > 0) out.push({ level: "warning", message: `余白が 5mm 未満です（${tight.join("・")}）。` });
  }

  // 仕上がり線の近く（または外）にある文字。字の中心が安全な範囲の外なら数える。
  const safeMm = s.advanced?.safeMarginMm ?? SAFE_MARGIN_MM;
  const safe = safeMm * MM;
  const nearEdge: number[] = [];
  const colored = new Set<string>();
  const missingImages = new Set<string>();
  // 画像ごとに、いちばん粗く刷られるときの解像度（ppi）とそのページ。
  const lowRes = new Map<string, { ppi: number; page: number }>();
  const needPpi = target === "images" ? s.image.dpi : print ? 300 : 150;
  for (let i = 0; i < pageCount; i++) {
    const page = input.page(i);
    for (const sh of page.shapes) {
      if (sh.kind !== "image") continue;
      const info = input.images?.[sh.name];
      if (!info) {
        missingImages.add(sh.name);
        continue;
      }
      const ppi = Math.min(info.width / (sh.w / 72), info.height / (sh.h / 72));
      if (ppi < needPpi * 0.95 && ppi < (lowRes.get(sh.name)?.ppi ?? Infinity)) lowRes.set(sh.name, { ppi, page: first + i });
    }
    let edge = false;
    for (const it of page.items) {
      colored.add(it.color.toLowerCase());
      const half = it.size / 2;
      if (it.x - half < safe || it.x + half > page.width - safe || it.y - half < safe || it.y + half > page.height - safe) edge = true;
    }
    if (edge) nearEdge.push(first + i);
  }
  if (missingImages.size > 0) {
    out.push({ level: "error", message: `文書にない画像があります（${[...missingImages].join("・")}）。「画像」欄で入れるか、［＃画像：名前］の名前を直してください。` });
  }
  for (const [name, r] of lowRes) {
    out.push({
      level: "warning",
      message: `画像「${name}」の解像度が足りません（${Math.round(r.ppi)}ppi、${r.page}ページ。${needPpi}ppi 以上が目安）。粗く刷られるおそれがあります。`,
    });
  }
  if (nearEdge.length > 0) {
    out.push({
      level: "warning",
      message: `仕上がり線から ${safeMm}mm 以内に文字があり、断裁で切れるおそれがあります（${pageList(nearEdge)}ページ）。`,
    });
  }

  // 色：入稿用で色の付いた文字は、CMYK の掛け合わせになる。グレースケールでは濃淡になる。
  const chromatic = [...colored].filter((c) => hexToCmyk(c).slice(0, 3).some((v) => v > 0));
  if (gray && chromatic.length > 0) {
    out.push({ level: "info", message: "色の付いた文字は、グレーの濃淡になります。" });
  } else if (print && chromatic.length > 0) {
    out.push({ level: "info", message: `色の付いた文字（${chromatic.length}色）は CMYK の掛け合わせで刷ります。細い文字は版ずれで読みにくくなることがあります。` });
  }
  if (print && s.paperColor.toLowerCase() !== "#ffffff") {
    out.push({ level: "info", message: "入稿用 PDF では紙の色を刷りません（色の付いた紙に刷るときは、紙を印刷所に指定してください）。" });
  }

  if (print && pageCount % 4 !== 0) {
    out.push({
      level: "info",
      message: `総ページ数（${pageCount}）が 4 の倍数ではありません。多くの印刷所は 4 の倍数で受け付けます（「書誌とページ構成」でそろえられます）。`,
    });
  }
  if (s.output.imposition === "spread" && target === "pdf" && !spreadOutput(s, "pdf")) {
    out.push({ level: "info", message: "入稿用 PDF は単ページで書き出します（見開きは閲覧用 PDF と画像だけ）。" });
  }
  return out;
}
