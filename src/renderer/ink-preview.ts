import type { SpotColor } from "../document/settings.js";
import { cmykToRgb, hexToCmyk, hexToGray, rgbToCmyk } from "../engine/ink-color.js";

// 分版プレビュー：入稿用 PDF で刷られる版（C・M・Y・K と特色）のうち、選んだ版だけを重ねた見え方にする。
// 色の変換は入稿用 PDF と同じ式（engine/ink-color.ts）。オーバープリント（ノセ）の色は、下の色を抜かずに重ねる。

/** 版の名前（プロセスの4版と、特色は名前）。 */
export const PROCESS_PLATES = ["C", "M", "Y", "K"] as const;

/** 紙面を描くときに使う、版の見え方。 */
export interface InkPreview {
  /** 版の組み合わせを見分ける文字列（画像の変換の控えに使う）。 */
  readonly key: string;
  /** 画面の色を、選んだ版だけで刷った色にする。どの版にも乗らなければ null（描かない）。 */
  color(hex: string): string | null;
  /** その色を重ねて刷る（オーバープリント）か。 */
  overprint(hex: string): boolean;
  /** 画像の画素（RGB 0〜255）を、選んだ版だけで刷った色にする（画像は CMYK かグレーで刷る。特色にはならない）。 */
  pixel(r: number, g: number, b: number): [number, number, number];
}

export interface InkPreviewOptions {
  /** 見せる版（C・M・Y・K と特色の名前）。 */
  plates: ReadonlySet<string>;
  /** 書き出しの色：グレースケールなら K の版だけ。 */
  gray: boolean;
  spots: readonly SpotColor[];
  /** スミ（K100%）をノセにする。 */
  overprintBlack: boolean;
  /** オーバープリントを見る（入れなければ、下の色を抜いて描く）。 */
  showOverprint: boolean;
}

const hex2 = (v: number) => Math.round(v).toString(16).padStart(2, "0");
const toHex = ([r, g, b]: [number, number, number]) => `#${hex2(r)}${hex2(g)}${hex2(b)}`;

export function inkPreview(o: InkPreviewOptions): InkPreview {
  const on = (p: string) => (o.plates.has(p) ? 1 : 0);
  const [c, m, y, k] = PROCESS_PLATES.map(on);
  const spots = new Map(o.spots.map((s) => [s.color.toLowerCase(), s]));
  const cache = new Map<string, string | null>();
  /** CMYK（0〜1）を、選んだ版だけにして画面の色にする。どの版にも乗らなければ null。 */
  const process = (cc: number, mm: number, yy: number, kk: number): [number, number, number] | null => {
    const v = [cc * c, mm * m, yy * y, kk * k];
    if (v.every((x) => x < 0.0005)) return null;
    return cmykToRgb(v[0], v[1], v[2], v[3]);
  };
  return {
    key: [...o.plates].sort().join(",") + (o.gray ? "|gray" : ""),
    color(hex) {
      const key = hex.toLowerCase();
      if (cache.has(key)) return cache.get(key)!;
      let out: string | null;
      const spot = !o.gray ? spots.get(key) : undefined;
      if (spot) {
        // 特色は、その特色の版だけに乗る（画面では登録した色で見せる）。
        out = o.plates.has(spot.name) ? key : null;
      } else if (o.gray) {
        const rgb = process(0, 0, 0, 1 - hexToGray(key));
        out = rgb && toHex(rgb);
      } else {
        const rgb = process(...hexToCmyk(key));
        out = rgb && toHex(rgb);
      }
      cache.set(key, out);
      return out;
    },
    overprint(hex) {
      if (!o.showOverprint || o.gray) return false;
      const spot = spots.get(hex.toLowerCase());
      if (spot) return spot.overprint;
      return o.overprintBlack && hexToCmyk(hex).join(",") === "0,0,0,1";
    },
    pixel(r, g, b) {
      if (o.gray) {
        const gray = 0.299 * (r / 255) + 0.587 * (g / 255) + 0.114 * (b / 255);
        return process(0, 0, 0, 1 - gray) ?? [255, 255, 255];
      }
      const [cc, mm, yy, kk] = rgbToCmyk(r / 255, g / 255, b / 255);
      return process(cc, mm, yy, kk) ?? [255, 255, 255];
    },
  };
}

/**
 * 画面の色（分版プレビューで描いた画素）から、インキの量を目安で読む（カーソルの所の表示に使う）。
 * 特色は、登録した色とちょうど同じ画素なら、その特色 100% とみなす。
 */
export function readInks(r: number, g: number, b: number, o: Pick<InkPreviewOptions, "gray" | "spots">): { name: string; percent: number }[] {
  const hex = toHex([r, g, b]);
  if (!o.gray) {
    const spot = o.spots.find((s) => s.color.toLowerCase() === hex);
    if (spot) return [{ name: spot.name, percent: 100 }];
  }
  if (o.gray) return [{ name: "K", percent: Math.round((1 - hexToGray(hex)) * 100) }];
  const v = rgbToCmyk(r / 255, g / 255, b / 255);
  return PROCESS_PLATES.map((name, i) => ({ name, percent: Math.round(v[i] * 100) }));
}
