import { faceOffsets, readTables } from "./sfnt.js";

// 異体字シーケンス（IVS・標準異体字シーケンス）：フォントの cmap の書式14 を読み、字ごとに使える異体字セレクタを調べる。
// 字形パネルで「この字にはどの異体字があるか」を出すのに使う（字形そのものは HarfBuzz で選ぶ）。

/** フォントの中身 → 字（コードポイント）→ 使える異体字セレクタ。1つのフォントにつき1度だけ読む。 */
const cache = new WeakMap<Uint8Array, Map<number, Map<number, number[]>>>();

/** 異体字セレクタ（U+FE00〜FE0F・U+E0100〜E01EF）か。 */
export const isVariationSelector = (cp: number) => (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef);

/**
 * フォント（bytes。.ttc なら faceIndex 番目）が、字 cp に持っている異体字セレクタ（小さい順）。
 * cmap の書式14 がなければ空。
 */
export function variationSelectors(bytes: Uint8Array, faceIndex: number, cp: number): number[] {
  let byFace = cache.get(bytes);
  if (!byFace) cache.set(bytes, (byFace = new Map()));
  let map = byFace.get(faceIndex);
  if (!map) byFace.set(faceIndex, (map = readUvs(bytes, faceIndex)));
  return map.get(cp) ?? [];
}

/** cmap の書式14（Unicode Variation Sequences）を読み、字 → 異体字セレクタの一覧にする。 */
function readUvs(bytes: Uint8Array, faceIndex: number): Map<number, number[]> {
  const out = new Map<number, number[]>();
  const read = (o: number, l: number) => bytes.subarray(o, o + l);
  const offsets = faceOffsets(read);
  const cmap = readTables(read, offsets[faceIndex] ?? offsets[0]).find((t) => t.tag === "cmap");
  if (!cmap) return out;
  const dv = new DataView(bytes.buffer, bytes.byteOffset + cmap.offset, cmap.length);
  const u24 = (o: number) => (dv.getUint8(o) << 16) | dv.getUint16(o + 1);
  const add = (cp: number, vs: number) => {
    let list = out.get(cp);
    if (!list) out.set(cp, (list = []));
    if (!list.includes(vs)) list.push(vs);
  };
  const count = dv.getUint16(2);
  for (let i = 0; i < count; i++) {
    const platform = dv.getUint16(4 + i * 8);
    const encoding = dv.getUint16(6 + i * 8);
    const sub = dv.getUint32(8 + i * 8);
    if (platform !== 0 || encoding !== 5 || dv.getUint16(sub) !== 14) continue;
    const records = dv.getUint32(sub + 6);
    for (let r = 0; r < records; r++) {
      const rec = sub + 10 + r * 11;
      const vs = u24(rec);
      const defaultUvs = dv.getUint32(rec + 3);
      const nonDefaultUvs = dv.getUint32(rec + 7);
      // 既定の字形のままの組（範囲で書いてある）。
      if (defaultUvs) {
        const base = sub + defaultUvs;
        const ranges = dv.getUint32(base);
        for (let k = 0; k < ranges; k++) {
          const start = u24(base + 4 + k * 4);
          const extra = dv.getUint8(base + 7 + k * 4);
          for (let cp = start; cp <= start + extra; cp++) add(cp, vs);
        }
      }
      // 別の字形になる組。
      if (nonDefaultUvs) {
        const base = sub + nonDefaultUvs;
        const mappings = dv.getUint32(base);
        for (let k = 0; k < mappings; k++) add(u24(base + 4 + k * 5), vs);
      }
    }
  }
  for (const list of out.values()) list.sort((a, b) => a - b);
  return out;
}
