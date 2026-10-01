import * as hb from "harfbuzzjs";

export interface ShapedGlyph {
  gid: number;
  /** 横方向の送り幅（フォント単位）。 */
  advance: number;
  /** 縦組みの送り幅と、縦方向のずれ（フォント単位。縦組みでシェーピングしたときだけ）。 */
  vAdvance?: number;
  yOffset?: number;
}

/** HarfBuzz で字形を選び、字形の輪郭を取り出す。 */
export class Face {
  readonly upem: number;
  /** 仮想ボディ（1em の正方形）の下端。ベースラインからの距離（フォント単位、下が負）。 */
  readonly emBottom: number;
  private readonly font: hb.Font;
  private readonly paths = new Map<number, string>();
  private readonly shapeCache = new Map<string, ShapedGlyph[]>();
  private readonly buffer = new hb.Buffer();

  constructor(bytes: Uint8Array) {
    const face = new hb.Face(new hb.Blob(new Uint8Array(bytes)));
    this.font = new hb.Font(face);
    this.upem = face.upem;
    this.emBottom = Face.readEmBottom(face);
  }

  /** OS/2 の sTypoAscender − sTypoDescender が 1em なら、sTypoDescender を仮想ボディの下端とみなす。 */
  private static readEmBottom(face: hb.Face): number {
    const os2 = face.referenceTable("OS/2");
    if (os2 && os2.length >= 72) {
      const view = new DataView(os2.buffer, os2.byteOffset, os2.byteLength);
      const ascender = view.getInt16(68);
      const descender = view.getInt16(70);
      if (ascender - descender === face.upem) return descender;
    }
    return -Math.round(face.upem * 0.12);
  }

  /**
   * 文字列の字形を選ぶ。同じ文字列・同じ向きの結果は覚えておいて使い回す
   * （本1冊でも使う文字は数千種類なので、10万字でもシェーピングは数千回で済む）。
   * 返す配列は共有しているので、呼び出し側で書き換えないこと。
   */
  shape(text: string, direction: "ttb" | "ltr", features = ""): readonly ShapedGlyph[] {
    const key = `${direction}\u0000${features}\u0000${text}`;
    let shaped = this.shapeCache.get(key);
    if (!shaped) {
      const buffer = this.buffer;
      buffer.reset();
      buffer.addText(text);
      buffer.guessSegmentProperties();
      buffer.setDirection(direction === "ttb" ? hb.Direction.TTB : hb.Direction.LTR);
      // OpenType の機能（jp78・trad・vpal など）。カンマ区切りの文字列で受け取る。
      const feats = features ? features.split(",").flatMap((f) => hb.Feature.fromString(f) ?? []) : undefined;
      hb.shape(this.font, buffer, feats);
      const positions = direction === "ttb" ? buffer.getGlyphPositions() : [];
      shaped = buffer.getGlyphInfos().map((info, i) => ({
        gid: info.codepoint,
        advance: this.font.glyphHAdvance(info.codepoint),
        ...(positions[i] ? { vAdvance: -positions[i].yAdvance, yOffset: positions[i].yOffset } : {}),
      }));
      this.shapeCache.set(key, shaped);
    }
    return shaped;
  }

  /** 字形の横方向の送り幅（フォント単位）。 */
  advance(gid: number): number {
    return this.font.glyphHAdvance(gid);
  }

  /** 字形のインクの中心（フォント単位、y 軸は上向き）。インクのない字形は仮想ボディの中心を返す。 */
  inkCenter(gid: number): { x: number; y: number } {
    const e = this.font.glyphExtents(gid);
    if (!e || e.width === 0) return { x: this.upem / 2, y: this.emBottom + this.upem / 2 };
    // HarfBuzz の height は下向きなので負の値になる。
    return { x: e.xBearing + e.width / 2, y: e.yBearing + e.height / 2 };
  }

  /** 字形のインクの上端と下端（フォント単位、y 軸は上向き）。インクがなければ null。 */
  inkVertical(gid: number): { top: number; bottom: number } | null {
    const e = this.font.glyphExtents(gid);
    if (!e || e.height === 0) return null;
    return { top: e.yBearing, bottom: e.yBearing + e.height };
  }

  /** 字形の輪郭（SVG のパス。フォント単位、y 軸は上向き）。 */
  path(gid: number): string {
    let p = this.paths.get(gid);
    if (p === undefined) {
      p = this.font.glyphToPath(gid);
      this.paths.set(gid, p);
    }
    return p;
  }
}
