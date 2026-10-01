import { PDFHexString, PDFNumber, PDFString, type PDFDocument, type PDFRef } from "pdf-lib";
import { Face } from "../engine/face.js";
import type { DrawItem, DrawPage } from "../engine/types.js";
import { subsetCidCff } from "../fonts/cff.js";
import { readTables, type ReadAt } from "../fonts/sfnt.js";

// PostScript 系（CFF）の .otf フォントを PDF に埋め込む。pdf-lib（fontkit）は CID 方式の CFF を
// 正しく埋め込めないので、自前で CIDFontType0（FontFile3 /CIDFontType0C）として書く。
// PDF 1.3 からある形式なので、PDF/X-1a（PDF 1.4）でも使える。

export function isCffFont(bytes: Uint8Array): boolean {
  const read: ReadAt = (o, l) => bytes.subarray(o, o + l);
  return readTables(read, 0).some((t) => t.tag === "CFF ");
}

export interface EmbeddedCffFont {
  ref: PDFRef;
  /** 描画命令の字形を、PDF の文字列（CID の並び）にする。 */
  encode(item: DrawItem): PDFHexString;
}

/** 使った字形だけを残した CFF を埋め込み、Type0 フォントを作る。 */
export function embedCffFont(doc: PDFDocument, fontBytes: Uint8Array, pages: DrawPage[], name: string): EmbeddedCffFont {
  const read: ReadAt = (o, l) => fontBytes.subarray(o, o + l);
  const tables = readTables(read, 0);
  const table = (tag: string) => {
    const t = tables.find((x) => x.tag === tag);
    return t ? fontBytes.subarray(t.offset, t.offset + t.length) : undefined;
  };
  const cffTable = table("CFF ");
  if (!cffTable) throw new Error("CFF の表がありません。");

  // 使った字形と、その字形が表す文字（コピー・検索のための ToUnicode 用）。
  const used = new Set<number>();
  const textOf = new Map<number, string>();
  for (const page of pages) {
    for (const item of page.items) {
      const chars = [...item.text];
      item.glyphs.forEach((g, i) => {
        used.add(g.gid);
        if (textOf.has(g.gid)) return;
        if (chars.length === item.glyphs.length) textOf.set(g.gid, chars[i]);
        else if (i === 0) textOf.set(g.gid, item.text);
      });
    }
  }

  const cff = subsetCidCff(cffTable, used);
  const face = new Face(fontBytes);
  const toPdf = (v: number) => Math.round((v * 1000) / face.upem);
  const { context } = doc;

  const fontFile = context.flateStream(cff.bytes, { Subtype: "CIDFontType0C" });
  const fontFileRef = context.register(fontFile);

  const metrics = fontMetrics(table("head"), table("OS/2"), table("hhea"));
  const descriptor = context.obj({
    Type: "FontDescriptor",
    FontName: name,
    Flags: 4,
    FontBBox: metrics.bbox.map(toPdf),
    ItalicAngle: 0,
    Ascent: toPdf(metrics.ascent),
    Descent: toPdf(metrics.descent),
    CapHeight: toPdf(metrics.capHeight),
    StemV: 80,
    FontFile3: fontFileRef,
  });
  const descriptorRef = context.register(descriptor);

  // 字形ごとの送り幅。横組みで複数の字形を続けて書くとき（ノンブル・縦中横）に使われる。
  const cids = [...used].sort((a, b) => cff.cidOf[a] - cff.cidOf[b]);
  const widths = context.obj([]);
  for (const gid of cids) {
    widths.push(PDFNumber.of(cff.cidOf[gid]));
    widths.push(context.obj([toPdf(face.advance(gid))]));
  }

  const cidFont = context.obj({
    Type: "Font",
    Subtype: "CIDFontType0",
    BaseFont: name,
    CIDSystemInfo: context.obj({
      Registry: PDFString.of(cff.registry),
      Ordering: PDFString.of(cff.ordering),
      Supplement: cff.supplement,
    }),
    FontDescriptor: descriptorRef,
    DW: 1000,
    W: widths,
  });
  const cidFontRef = context.register(cidFont);

  const toUnicode = context.flateStream(toUnicodeCMap(cids.map((gid) => [cff.cidOf[gid], textOf.get(gid) ?? ""] as const)));
  const font = context.obj({
    Type: "Font",
    Subtype: "Type0",
    BaseFont: `${name}-Identity-H`,
    Encoding: "Identity-H",
    DescendantFonts: [cidFontRef],
    ToUnicode: context.register(toUnicode),
  });

  return {
    ref: context.register(font),
    encode(item) {
      return PDFHexString.of(item.glyphs.map((g) => cff.cidOf[g.gid].toString(16).padStart(4, "0")).join(""));
    },
  };
}

function fontMetrics(head?: Uint8Array, os2?: Uint8Array, hhea?: Uint8Array) {
  const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
  const bbox = head ? [36, 38, 40, 42].map((o) => view(head).getInt16(o)) : [0, -120, 1000, 880];
  let ascent = 880;
  let descent = -120;
  let capHeight = 700;
  if (os2 && os2.length >= 72) {
    ascent = view(os2).getInt16(68);
    descent = view(os2).getInt16(70);
    capHeight = os2.length >= 90 && view(os2).getUint16(0) >= 2 ? view(os2).getInt16(88) : ascent;
  } else if (hhea) {
    ascent = view(hhea).getInt16(4);
    descent = view(hhea).getInt16(6);
  }
  return { bbox, ascent, descent, capHeight: capHeight || ascent };
}

/** CID から Unicode への対応表（ToUnicode CMap）。PDF の文字をコピー・検索できるようにする。 */
function toUnicodeCMap(pairs: (readonly [number, string])[]): string {
  const hex4 = (n: number) => n.toString(16).padStart(4, "0");
  const utf16 = (s: string) =>
    [...s]
      .map((ch) => {
        const cp = ch.codePointAt(0)!;
        if (cp < 0x10000) return hex4(cp);
        const v = cp - 0x10000;
        return hex4(0xd800 + (v >> 10)) + hex4(0xdc00 + (v & 0x3ff));
      })
      .join("");
  const entries = pairs.filter(([, text]) => text !== "");
  const lines: string[] = [];
  for (let i = 0; i < entries.length; i += 100) {
    const chunk = entries.slice(i, i + 100);
    lines.push(`${chunk.length} beginbfchar`);
    for (const [cid, text] of chunk) lines.push(`<${hex4(cid)}> <${utf16(text)}>`);
    lines.push("endbfchar");
  }
  return [
    "/CIDInit /ProcSet findresource begin",
    "12 dict begin",
    "begincmap",
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
    "/CMapName /Adobe-Identity-UCS def",
    "/CMapType 2 def",
    "1 begincodespacerange",
    "<0000> <ffff>",
    "endcodespacerange",
    ...lines,
    "endcmap",
    "CMapName currentdict /CMap defineresource pop",
    "end",
    "end",
  ].join("\n");
}
