import type { Face } from "../engine/face.js";
import { variationSelectors } from "./ivs.js";

// 字形パネル：1つの字について、フォントにある別の字形を並べる。
// ・異体字（IVS）：字のあとに異体字セレクタを付ける。原稿にそのまま残り、ほかのソフトや EPUB でも同じ字形になる。
// ・字形の候補（OpenType の aalt）：原稿では字のあとに［＃字形：番号］と書く。Kolophon の組版（紙面・PDF）で使える。
// 同じ字形が両方にあれば、異体字（IVS）のほうを出す。

export interface GlyphVariant {
  /** base：元の字形。ivs：異体字セレクタ（value はそのコードポイント）。alt：字形の候補（value は aalt の番号）。 */
  kind: "base" | "ivs" | "alt";
  value: number;
  /** 画面に出す名前（例：IVS E0101、候補 2）。 */
  label: string;
  /** 字形の輪郭（SVG のパス。フォント単位、y 軸は上向き）と送り幅。 */
  d: string;
  advance: number;
}

/** 調べる字形の候補の数の上限（aalt の番号）。 */
const MAX_ALTERNATES = 30;

/**
 * 字（base。異体字セレクタは付けない）の字形の一覧。先頭は元の字形。
 * bytes・faceIndex はフォントの中身（IVS を調べるため）、vertical なら縦組みの字形（vert）で調べる。
 */
export function glyphVariants(face: Face, bytes: Uint8Array, faceIndex: number, base: string, vertical: boolean): GlyphVariant[] {
  const dir = vertical ? "ttb" : "ltr";
  const cp = base.codePointAt(0)!;
  const gidOf = (text: string, features = "") => face.shape(text, dir, features)[0]?.gid ?? 0;
  const baseGid = gidOf(base);
  const seen = new Set<number>([baseGid]);
  const glyph = (gid: number) => ({ d: face.path(gid), advance: face.advance(gid) });
  const out: GlyphVariant[] = [{ kind: "base", value: 0, label: "標準", ...glyph(baseGid) }];
  for (const vs of variationSelectors(bytes, faceIndex, cp)) {
    const gid = gidOf(base + String.fromCodePoint(vs));
    if (gid === 0 || seen.has(gid)) continue;
    seen.add(gid);
    out.push({ kind: "ivs", value: vs, label: `IVS ${vs.toString(16).toUpperCase()}`, ...glyph(gid) });
  }
  for (let n = 1; n <= MAX_ALTERNATES; n++) {
    const gid = gidOf(base, `aalt=${n}`);
    // 候補がなくなると、元の字形か、前と同じ字形が返る。
    if (gid === 0 || gid === baseGid) break;
    if (seen.has(gid)) {
      // 1つしか候補のない置き換えは、どの番号でも同じ字形になる。
      if (n > 1) break;
      continue;
    }
    seen.add(gid);
    out.push({ kind: "alt", value: n, label: `候補 ${n}`, ...glyph(gid) });
  }
  return out;
}
