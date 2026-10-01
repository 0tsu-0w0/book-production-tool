// OpenType / TrueType フォントファイル（sfnt）の最低限の読み取り。
// フォント一覧を作るときに、ファイル全体を読まずに必要な表だけを読む。

/** ファイルの一部を読む手段。ファイル記述子でもメモリ上のバイト列でもよい。 */
export type ReadAt = (offset: number, length: number) => Uint8Array;

export interface TableRecord {
  tag: string;
  offset: number;
  length: number;
}

export interface FaceInfo {
  index: number;
  /** 日本語名があれば日本語名、なければ英語名。 */
  familyName: string;
  subfamilyName: string;
  fullName: string;
  postscriptName: string;
  /** OS/2 の埋め込み許可。印刷・閲覧用の埋め込みができれば true。 */
  embeddable: boolean;
  /** OS/2 の文字コード範囲に JIS（日本語）がある。 */
  japanese: boolean;
  /** GSUB に縦書き用字形（vert / vrt2）がある。 */
  vertical: boolean;
  /** 可変フォント（fvar がある）。試作では扱わない。 */
  variable: boolean;
  /** 輪郭が CFF（PostScript 系）。 */
  cff: boolean;
}

const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const tagAt = (b: Uint8Array, o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

/** ファイル内の各フォントの先頭位置。.ttc なら複数、単体なら [0]。 */
export function faceOffsets(read: ReadAt): number[] {
  const head = read(0, 12);
  if (tagAt(head, 0) !== "ttcf") return [0];
  const count = view(head).getUint32(8);
  const offsets = view(read(12, count * 4));
  return Array.from({ length: count }, (_, i) => offsets.getUint32(i * 4));
}

export function readTables(read: ReadAt, faceOffset: number): TableRecord[] {
  const header = read(faceOffset, 12);
  const numTables = view(header).getUint16(4);
  const records = read(faceOffset + 12, numTables * 16);
  const dv = view(records);
  return Array.from({ length: numTables }, (_, i) => ({
    tag: tagAt(records, i * 16),
    offset: dv.getUint32(i * 16 + 8),
    length: dv.getUint32(i * 16 + 12),
  }));
}

export function readFaceInfo(read: ReadAt, faceOffset: number, index: number): FaceInfo {
  const tables = readTables(read, faceOffset);
  const table = (tag: string) => tables.find((t) => t.tag === tag);
  const load = (t: TableRecord | undefined) => (t ? read(t.offset, t.length) : undefined);

  const names = parseNames(load(table("name")));
  const os2 = load(table("OS/2"));
  let embeddable = true;
  let japanese = false;
  if (os2 && os2.length >= 10) {
    const fsType = view(os2).getUint16(8);
    // 2: 埋め込み禁止、0x200: ビットマップのみ埋め込み可。
    embeddable = (fsType & 0x000f) !== 0x0002 && (fsType & 0x0200) === 0;
    if (os2.length >= 82 && view(os2).getUint16(0) >= 1) japanese = (view(os2).getUint32(78) & (1 << 17)) !== 0;
  }

  const gsub = load(table("GSUB"));
  const features = gsub ? featureTags(gsub) : [];

  return {
    index,
    familyName: names.family,
    subfamilyName: names.subfamily,
    fullName: names.full,
    postscriptName: names.postscript,
    embeddable,
    japanese,
    vertical: features.includes("vert") || features.includes("vrt2"),
    variable: !!table("fvar"),
    cff: !!table("CFF ") || !!table("CFF2"),
  };
}

function featureTags(gsub: Uint8Array): string[] {
  const dv = view(gsub);
  const featureListOffset = dv.getUint16(6);
  if (featureListOffset + 2 > gsub.length) return [];
  const count = dv.getUint16(featureListOffset);
  const tags = new Set<string>();
  for (let i = 0; i < count; i++) {
    const o = featureListOffset + 2 + i * 6;
    if (o + 4 > gsub.length) break;
    tags.add(tagAt(gsub, o));
  }
  return [...tags];
}

const LANG_JA = 0x0411;
const LANG_EN = 0x0409;

function parseNames(name: Uint8Array | undefined): { family: string; subfamily: string; full: string; postscript: string } {
  const found = new Map<string, string>();
  if (name) {
    const dv = view(name);
    const count = dv.getUint16(2);
    const storage = dv.getUint16(4);
    for (let i = 0; i < count; i++) {
      const r = 6 + i * 12;
      const platform = dv.getUint16(r);
      const lang = dv.getUint16(r + 4);
      const nameId = dv.getUint16(r + 6);
      const length = dv.getUint16(r + 8);
      const offset = dv.getUint16(r + 10);
      if (platform !== 3 && platform !== 0) continue; // Windows / Unicode の UTF-16BE だけを読む
      if (![1, 2, 4, 6, 16, 17].includes(nameId)) continue;
      const bytes = name.subarray(storage + offset, storage + offset + length);
      let s = "";
      for (let k = 0; k + 1 < bytes.length; k += 2) s += String.fromCharCode((bytes[k] << 8) | bytes[k + 1]);
      const langKey = platform === 3 && lang === LANG_JA ? "ja" : platform === 3 && lang !== LANG_EN ? "other" : "en";
      const key = `${nameId}:${langKey}`;
      if (!found.has(key)) found.set(key, s);
    }
  }
  const pick = (...ids: number[]) => {
    for (const lang of ["ja", "en", "other"]) {
      for (const id of ids) {
        const v = found.get(`${id}:${lang}`);
        if (v) return v;
      }
    }
    return "";
  };
  return {
    family: pick(16, 1),
    subfamily: pick(17, 2),
    full: pick(4),
    postscript: found.get("6:en") ?? found.get("6:other") ?? found.get("6:ja") ?? "",
  };
}

/**
 * .ttc（フォントコレクション）から1つのフォントを取り出し、単体の .ttf / .otf のバイト列にする。
 * 表の中身はそのまま写し、位置だけを付け直す。
 */
export function extractFace(bytes: Uint8Array, index: number): Uint8Array {
  const read: ReadAt = (o, l) => bytes.subarray(o, o + l);
  const offsets = faceOffsets(read);
  if (offsets.length === 1 && index === 0) return bytes;
  if (index < 0 || index >= offsets.length) throw new RangeError(`フォントコレクションに ${index} 番目のフォントはありません。`);
  const faceOffset = offsets[index];
  const tables = readTables(read, faceOffset).map((t) => ({ tag: t.tag, data: read(t.offset, t.length) }));
  return buildSfnt(read(faceOffset, 4), tables);
}

/**
 * 長さが奇数の字形データを持つ TrueType フォントを、各字形を4バイト境界にそろえた形に作り直す。
 * fontkit（pdf-lib）のサブセット化は、loca を短い形式（オフセット÷2）で書くため、
 * 奇数長の字形があると以降の字形の位置がずれ、PDF で文字が欠ける。字形番号は変わらない。
 */
export function normalizeGlyf(bytes: Uint8Array): Uint8Array {
  const read: ReadAt = (o, l) => bytes.subarray(o, o + l);
  if (faceOffsets(read).length !== 1) return bytes;
  const records = readTables(read, 0);
  const get = (tag: string) => records.find((r) => r.tag === tag);
  const [glyf, loca, head, maxp] = ["glyf", "loca", "head", "maxp"].map(get);
  if (!glyf || !loca || !head || !maxp) return bytes;

  const headData = read(head.offset, head.length);
  const longLoca = view(headData).getInt16(50) === 1;
  const numGlyphs = view(read(maxp.offset, 6)).getUint16(4);
  const locaView = view(read(loca.offset, loca.length));
  const offsets = Array.from({ length: numGlyphs + 1 }, (_, i) => (longLoca ? locaView.getUint32(i * 4) : locaView.getUint16(i * 2) * 2));
  let hasOdd = false;
  for (let i = 0; i < numGlyphs; i++) if ((offsets[i + 1] - offsets[i]) % 2 !== 0) hasOdd = true;
  if (!hasOdd) return bytes;

  const pad4 = (n: number) => (n + 3) & ~3;
  const glyfData = read(glyf.offset, glyf.length);
  let total = 0;
  for (let i = 0; i < numGlyphs; i++) total += pad4(offsets[i + 1] - offsets[i]);
  const newGlyf = new Uint8Array(total);
  const newLoca = new Uint8Array((numGlyphs + 1) * 4);
  const lv = view(newLoca);
  let cursor = 0;
  for (let i = 0; i < numGlyphs; i++) {
    lv.setUint32(i * 4, cursor);
    newGlyf.set(glyfData.subarray(offsets[i], offsets[i + 1]), cursor);
    cursor += pad4(offsets[i + 1] - offsets[i]);
  }
  lv.setUint32(numGlyphs * 4, cursor);

  const newHead = Uint8Array.from(headData);
  view(newHead).setInt16(50, 1); // indexToLocFormat: 長い形式
  view(newHead).setUint32(8, 0); // checkSumAdjustment は使わないので 0 にする
  const tables = records.map((r) => ({
    tag: r.tag,
    data: r.tag === "glyf" ? newGlyf : r.tag === "loca" ? newLoca : r.tag === "head" ? newHead : read(r.offset, r.length),
  }));
  return buildSfnt(read(0, 4), tables);
}

/** 表の一覧から sfnt（単体のフォントファイル）を組み立てる。 */
function buildSfnt(sfntVersion: Uint8Array, input: { tag: string; data: Uint8Array }[]): Uint8Array {
  const tables = [...input].sort((a, b) => (a.tag < b.tag ? -1 : 1));
  const headerSize = 12 + tables.length * 16;
  const pad4 = (n: number) => (n + 3) & ~3;
  const total = tables.reduce((sum, t) => sum + pad4(t.data.length), headerSize);
  const out = new Uint8Array(total);
  const dv = view(out);
  out.set(sfntVersion, 0);
  const n = tables.length;
  const entrySelector = Math.floor(Math.log2(n));
  const searchRange = 2 ** entrySelector * 16;
  dv.setUint16(4, n);
  dv.setUint16(6, searchRange);
  dv.setUint16(8, entrySelector);
  dv.setUint16(10, n * 16 - searchRange);

  let cursor = headerSize;
  tables.forEach((t, i) => {
    const r = 12 + i * 16;
    for (let k = 0; k < 4; k++) out[r + k] = t.tag.charCodeAt(k);
    dv.setUint32(r + 4, checksum(t.data));
    dv.setUint32(r + 8, cursor);
    dv.setUint32(r + 12, t.data.length);
    out.set(t.data, cursor);
    cursor += pad4(t.data.length);
  });
  return out;
}

function checksum(data: Uint8Array): number {
  let sum = 0;
  const padded = new Uint8Array((data.length + 3) & ~3);
  padded.set(data);
  const dv = view(padded);
  for (let i = 0; i < padded.length; i += 4) sum = (sum + dv.getUint32(i)) >>> 0;
  return sum;
}
