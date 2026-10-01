// CFF（Compact Font Format。PostScript 系の .otf の輪郭データ）の最低限の読み書き。
// PDF に埋め込むとき、使っていない字形の中身を空にして小さくする。
// 字形番号（GID）と CID の対応は変えないので、組版の結果（字形番号）をそのまま使える。
// 仕様：Adobe Technical Note #5176「The Compact Font Format Specification」

export class UnsupportedCffError extends Error {}

interface Index {
  items: Uint8Array[];
  /** INDEX の終わり（次の構造の始まり）。 */
  end: number;
}

function u16(d: Uint8Array, p: number): number {
  return (d[p] << 8) | d[p + 1];
}

function readOffset(d: Uint8Array, p: number, size: number): number {
  let v = 0;
  for (let i = 0; i < size; i++) v = v * 256 + d[p + i];
  return v;
}

export function readIndex(d: Uint8Array, pos: number): Index {
  const count = u16(d, pos);
  if (count === 0) return { items: [], end: pos + 2 };
  const offSize = d[pos + 2];
  const offsetsAt = pos + 3;
  const dataStart = offsetsAt + (count + 1) * offSize - 1; // オフセットは 1 始まり
  const items: Uint8Array[] = [];
  let prev = readOffset(d, offsetsAt, offSize);
  for (let i = 1; i <= count; i++) {
    const next = readOffset(d, offsetsAt + i * offSize, offSize);
    items.push(d.subarray(dataStart + prev, dataStart + next));
    prev = next;
  }
  return { items, end: dataStart + prev };
}

export function writeIndex(items: Uint8Array[]): Uint8Array {
  if (items.length === 0) return Uint8Array.of(0, 0);
  const total = items.reduce((s, it) => s + it.length, 0);
  const offSize = total + 1 < 0x100 ? 1 : total + 1 < 0x10000 ? 2 : total + 1 < 0x1000000 ? 3 : 4;
  const out = new Uint8Array(3 + (items.length + 1) * offSize + total);
  out[0] = items.length >> 8;
  out[1] = items.length & 0xff;
  out[2] = offSize;
  let offset = 1;
  let data = 3 + (items.length + 1) * offSize;
  const writeOff = (i: number, v: number) => {
    for (let k = offSize - 1; k >= 0; k--) {
      out[3 + i * offSize + k] = v & 0xff;
      v = Math.floor(v / 256);
    }
  };
  items.forEach((it, i) => {
    writeOff(i, offset);
    out.set(it, data);
    data += it.length;
    offset += it.length;
  });
  writeOff(items.length, offset);
  return out;
}

// ---- DICT ----

/** DICT の1項目。演算子 12 xx は 1200 + xx で表す。raw は被演算子の元のバイト列。 */
export interface DictEntry {
  op: number;
  operands: number[];
  raw: Uint8Array;
}

export const OP = {
  charset: 15,
  Encoding: 16,
  CharStrings: 17,
  Private: 18,
  Subrs: 19,
  ROS: 1230,
  FDArray: 1236,
  FDSelect: 1237,
} as const;

export function readDict(d: Uint8Array): DictEntry[] {
  const entries: DictEntry[] = [];
  let operands: number[] = [];
  let start = 0;
  let p = 0;
  while (p < d.length) {
    const b0 = d[p];
    if (b0 <= 21) {
      let op = b0;
      const opStart = p;
      p++;
      if (b0 === 12) op = 1200 + d[p++];
      entries.push({ op, operands, raw: d.subarray(start, opStart) });
      operands = [];
      start = p;
    } else if (b0 === 28) {
      operands.push(((d[p + 1] << 24) >> 16) | d[p + 2]);
      p += 3;
    } else if (b0 === 29) {
      operands.push((d[p + 1] << 24) | (d[p + 2] << 16) | (d[p + 3] << 8) | d[p + 4]);
      p += 5;
    } else if (b0 === 30) {
      // 実数。値は使わないので読み飛ばす（raw にはそのまま残る）。
      p++;
      while (p < d.length) {
        const b = d[p++];
        if ((b & 0x0f) === 0x0f || (b >> 4) === 0x0f) break;
      }
      operands.push(NaN);
    } else if (b0 >= 32 && b0 <= 246) {
      operands.push(b0 - 139);
      p += 1;
    } else if (b0 >= 247 && b0 <= 250) {
      operands.push((b0 - 247) * 256 + d[p + 1] + 108);
      p += 2;
    } else if (b0 >= 251 && b0 <= 254) {
      operands.push(-(b0 - 251) * 256 - d[p + 1] - 108);
      p += 2;
    } else {
      throw new UnsupportedCffError(`DICT の読めないバイト：${b0}`);
    }
  }
  return entries;
}

/** 5バイトの整数（位置の値を、あとで長さが変わらないように書き換えるため）。 */
function int32(v: number): number[] {
  return [29, (v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
}

/** DICT を書く。overrides にある演算子は、被演算子を5バイト整数で書き直す。null の演算子は書かない。 */
export function writeDict(entries: DictEntry[], overrides: Map<number, number[] | null>): Uint8Array {
  const bytes: number[] = [];
  for (const e of entries) {
    const o = overrides.get(e.op);
    if (o === null) continue;
    if (o) for (const v of o) bytes.push(...int32(v));
    else bytes.push(...e.raw);
    if (e.op >= 1200) bytes.push(12, e.op - 1200);
    else bytes.push(e.op);
  }
  return Uint8Array.from(bytes);
}

function operandOf(entries: DictEntry[], op: number): number[] | undefined {
  return entries.find((e) => e.op === op)?.operands;
}

// ---- charset・FDSelect ----

/** charset を読み、字形番号ごとの CID（CID 方式でないフォントでは SID）と、charset のバイト数を返す。 */
export function readCharset(d: Uint8Array, pos: number, nGlyphs: number): { ids: number[]; length: number } {
  const ids = [0];
  const format = d[pos];
  let p = pos + 1;
  if (format === 0) {
    for (let i = 1; i < nGlyphs; i++, p += 2) ids.push(u16(d, p));
  } else if (format === 1 || format === 2) {
    while (ids.length < nGlyphs) {
      const first = u16(d, p);
      const left = format === 1 ? d[p + 2] : u16(d, p + 2);
      p += format === 1 ? 3 : 4;
      for (let k = 0; k <= left && ids.length < nGlyphs; k++) ids.push(first + k);
    }
  } else {
    throw new UnsupportedCffError(`charset の形式 ${format} には対応していません。`);
  }
  return { ids, length: p - pos };
}

function fdSelectLength(d: Uint8Array, pos: number, nGlyphs: number): number {
  const format = d[pos];
  if (format === 0) return 1 + nGlyphs;
  if (format === 3) return 1 + 2 + u16(d, pos + 1) * 3 + 2;
  throw new UnsupportedCffError(`FDSelect の形式 ${format} には対応していません。`);
}

// ---- 縮小 ----

export interface CidCff {
  /** 使っていない字形の中身を空にした CFF。 */
  bytes: Uint8Array;
  /** 字形番号 → CID。 */
  cidOf: number[];
  registry: string;
  ordering: string;
  supplement: number;
}

/** CFF の標準文字列（SID 0〜390）のうち、ROS に出てくるものだけ。それ以外は String INDEX を引く。 */
function stringOf(sid: number, strings: Uint8Array[]): string {
  if (sid >= 391) return new TextDecoder("latin1").decode(strings[sid - 391] ?? new Uint8Array());
  return sid === 0 ? ".notdef" : `SID${sid}`;
}

/**
 * CID 方式の CFF から、keep に入っている字形（と .notdef）だけ中身を残した CFF を作る。
 * 残りの字形は endchar だけの空の字形にする。表の並びは作り直し、位置の値はすべて付け直す。
 */
export function subsetCidCff(cff: Uint8Array, keep: Set<number>): CidCff {
  const hdrSize = cff[2];
  const name = readIndex(cff, hdrSize);
  const topIndex = readIndex(cff, name.end);
  const strings = readIndex(cff, topIndex.end);
  const gsubrs = readIndex(cff, strings.end);
  const top = readDict(topIndex.items[0]);

  const ros = operandOf(top, OP.ROS);
  if (!ros) throw new UnsupportedCffError("CID 方式でない CFF フォントには、まだ対応していません。");
  const charStringsAt = operandOf(top, OP.CharStrings)?.[0];
  const charsetAt = operandOf(top, OP.charset)?.[0];
  const fdArrayAt = operandOf(top, OP.FDArray)?.[0];
  const fdSelectAt = operandOf(top, OP.FDSelect)?.[0];
  if (charStringsAt === undefined || charsetAt === undefined || fdArrayAt === undefined || fdSelectAt === undefined) {
    throw new UnsupportedCffError("CFF の必須の項目（CharStrings・charset・FDArray・FDSelect）がありません。");
  }

  const charStrings = readIndex(cff, charStringsAt);
  const nGlyphs = charStrings.items.length;
  const charset = readCharset(cff, charsetAt, nGlyphs);
  const fdSelect = cff.subarray(fdSelectAt, fdSelectAt + fdSelectLength(cff, fdSelectAt, nGlyphs));
  const fdArray = readIndex(cff, fdArrayAt);

  const endchar = Uint8Array.of(14);
  const newCharStrings = writeIndex(charStrings.items.map((cs, gid) => (gid === 0 || keep.has(gid) ? cs : endchar)));

  // FD ごとの Private DICT と、その Subrs（Private DICT からの相対位置）。
  const fds = fdArray.items.map((fdBytes) => {
    const fd = readDict(fdBytes);
    const priv = operandOf(fd, OP.Private);
    if (!priv) return { fd, privBytes: undefined as Uint8Array | undefined, subrs: undefined as Uint8Array | undefined };
    const [size, offset] = priv;
    const privDict = readDict(cff.subarray(offset, offset + size));
    const subrsRel = operandOf(privDict, OP.Subrs)?.[0];
    let subrs: Uint8Array | undefined;
    if (subrsRel !== undefined) {
      const idx = readIndex(cff, offset + subrsRel);
      subrs = cff.subarray(offset + subrsRel, idx.end);
    }
    // Subrs は Private DICT のすぐ後ろに置く。5バイト整数で書くので、長さは値によらない。
    const placeholder = writeDict(privDict, new Map([[OP.Subrs, [0]]]));
    const privBytes = subrs ? writeDict(privDict, new Map([[OP.Subrs, [placeholder.length]]])) : writeDict(privDict, new Map());
    return { fd, privBytes, subrs };
  });

  // 並び：Header・Name・Top DICT・String・Global Subrs・charset・FDSelect・CharStrings・FDArray・(Private・Subrs)…
  const topOverrides = (offsets: { charset: number; fdSelect: number; charStrings: number; fdArray: number }) =>
    new Map<number, number[] | null>([
      [OP.charset, [offsets.charset]],
      [OP.FDSelect, [offsets.fdSelect]],
      [OP.CharStrings, [offsets.charStrings]],
      [OP.FDArray, [offsets.fdArray]],
      [OP.Encoding, null], // CID 方式のフォントには使わない
    ]);
  const zero = { charset: 0, fdSelect: 0, charStrings: 0, fdArray: 0 };
  const topSize = writeIndex([writeDict(top, topOverrides(zero))]).length;
  const nameBytes = cff.subarray(hdrSize, name.end);
  const stringsBytes = cff.subarray(topIndex.end, strings.end);
  const gsubrBytes = cff.subarray(strings.end, gsubrs.end);
  const charsetBytes = cff.subarray(charsetAt, charsetAt + charset.length);

  let pos = hdrSize + nameBytes.length + topSize + stringsBytes.length + gsubrBytes.length;
  const offsets = { charset: pos, fdSelect: 0, charStrings: 0, fdArray: 0 };
  pos += charsetBytes.length;
  offsets.fdSelect = pos;
  pos += fdSelect.length;
  offsets.charStrings = pos;
  pos += newCharStrings.length;
  offsets.fdArray = pos;

  const fdPlaceholder = writeIndex(fds.map((f) => writeDict(f.fd, new Map([[OP.Private, [0, 0]]]))));
  pos += fdPlaceholder.length;
  const privateBlocks: Uint8Array[] = [];
  const fdDicts = fds.map((f) => {
    if (!f.privBytes) return writeDict(f.fd, new Map());
    const at = pos;
    privateBlocks.push(f.privBytes);
    pos += f.privBytes.length;
    if (f.subrs) {
      privateBlocks.push(f.subrs);
      pos += f.subrs.length;
    }
    return writeDict(f.fd, new Map([[OP.Private, [f.privBytes.length, at]]]));
  });
  const fdArrayBytes = writeIndex(fdDicts);
  const topBytes = writeIndex([writeDict(top, topOverrides(offsets))]);
  if (topBytes.length !== topSize || fdArrayBytes.length !== fdPlaceholder.length) {
    throw new Error("CFF の組み立てで長さが食い違いました。");
  }

  const parts = [cff.subarray(0, hdrSize), nameBytes, topBytes, stringsBytes, gsubrBytes, charsetBytes, fdSelect, newCharStrings, fdArrayBytes, ...privateBlocks];
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let cursor = 0;
  for (const p of parts) {
    out.set(p, cursor);
    cursor += p.length;
  }
  return {
    bytes: out,
    cidOf: charset.ids,
    registry: stringOf(ros[0], strings.items),
    ordering: stringOf(ros[1], strings.items),
    supplement: ros[2],
  };
}
