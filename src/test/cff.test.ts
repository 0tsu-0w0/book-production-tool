import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../document/settings.js";
import { Face, typeset } from "../engine/index.js";
import { OP, readCharset, readDict, readIndex, subsetCidCff, writeIndex, type DictEntry } from "../fonts/cff.js";
import { FontService } from "../fonts/service.js";
import { readTables } from "../fonts/sfnt.js";
import { checkPdfX1a } from "../output/check-pdfx.js";
import { PRINT_PDF, renderPdf } from "../output/pdf.js";
import { SAMPLE_TEXT } from "../sample.js";

/** PC に入っている CID 方式の CFF フォント（テスト用。なければテストを飛ばす）。 */
const candidates = [
  path.join(process.env.LOCALAPPDATA ?? "", "Microsoft", "Windows", "Fonts", "AkazukiPOP.otf"),
  path.join(process.env.LOCALAPPDATA ?? "", "Microsoft", "Windows", "Fonts", "oshigo.otf"),
].filter((p) => fs.existsSync(p));

function cffTable(file: string): Uint8Array {
  const bytes = fs.readFileSync(file);
  const t = readTables((o, l) => bytes.subarray(o, o + l), 0).find((x) => x.tag === "CFF ")!;
  return bytes.subarray(t.offset, t.offset + t.length);
}

/** FDSelect を、字形番号ごとの FD の番号にする（形式 0 と 3）。 */
function decodeFdSelect(d: Uint8Array, pos: number, nGlyphs: number): number[] {
  const u16 = (p: number) => (d[p] << 8) | d[p + 1];
  if (d[pos] === 0) return [...d.subarray(pos + 1, pos + 1 + nGlyphs)];
  const nRanges = u16(pos + 1);
  const out: number[] = [];
  for (let r = 0; r < nRanges; r++) {
    const first = u16(pos + 3 + r * 3);
    const fd = d[pos + 3 + r * 3 + 2];
    const next = u16(pos + 3 + (r + 1) * 3);
    for (let g = first; g < next; g++) out[g] = fd;
  }
  return out;
}

/** CFF を読み、中身を比べられる形にする。 */
function inspect(cff: Uint8Array) {
  const name = readIndex(cff, cff[2]);
  const topIndex = readIndex(cff, name.end);
  const strings = readIndex(cff, topIndex.end);
  const gsubrs = readIndex(cff, strings.end);
  const top = readDict(topIndex.items[0]);
  const get = (d: DictEntry[], op: number) => d.find((e) => e.op === op)?.operands;
  const charStrings = readIndex(cff, get(top, OP.CharStrings)![0]).items;
  const charset = readCharset(cff, get(top, OP.charset)![0], charStrings.length).ids;
  const fdSelect = decodeFdSelect(cff, get(top, OP.FDSelect)![0], charStrings.length);
  const fds = readIndex(cff, get(top, OP.FDArray)![0]).items.map((b) => {
    const fd = readDict(b);
    const [size, offset] = get(fd, OP.Private)!;
    const priv = readDict(cff.subarray(offset, offset + size));
    const subrsRel = get(priv, OP.Subrs)?.[0];
    const subrs = subrsRel === undefined ? [] : readIndex(cff, offset + subrsRel).items.map((x) => [...x].join(","));
    const others = (d: DictEntry[], skip: number) => d.filter((e) => e.op !== skip).map((e) => `${e.op}:${[...e.raw].join(",")}`);
    return { fd: others(fd, OP.Private), priv: others(priv, OP.Subrs), subrs };
  });
  return {
    top: top.filter((e) => ![OP.charset, OP.CharStrings, OP.FDArray, OP.FDSelect, OP.Encoding].includes(e.op as never)).map((e) => `${e.op}:${[...e.raw].join(",")}`),
    strings: strings.items.map((x) => [...x].join(",")),
    gsubrs: gsubrs.items.map((x) => [...x].join(",")),
    charStrings: charStrings.map((x) => [...x].join(",")),
    charset,
    fdSelect,
    fds,
  };
}

describe("CFF フォントでの PDF 書き出し", { skip: candidates.length === 0 && "CID 方式の CFF フォントがない" }, () => {
  it("入稿用 PDF（PDF/X-1a）の検査をすべて通り、フォントは CIDFontType0C で埋め込まれる", async () => {
    const bytes = new Uint8Array(fs.readFileSync(candidates[0]));
    const { pages } = typeset(SAMPLE_TEXT, DEFAULT_SETTINGS, new Face(bytes));
    const pdf = await renderPdf(pages, bytes, { ...PRINT_PDF, title: "test" });
    assert.deepEqual((await checkPdfX1a(pdf)).filter((i) => !i.ok), []);
    const raw = Buffer.from(pdf).toString("latin1");
    assert.match(raw, /\/Subtype\s*\/CIDFontType0C/);
    assert.match(raw, /\/Subtype\s*\/CIDFontType0\b/);
  });

  it("輪郭が空の字形を「表示できない文字」として見つける", { skip: !candidates.some((p) => p.endsWith("oshigo.otf")) && "推しゴがない" }, () => {
    const oshigo = new Uint8Array(fs.readFileSync(candidates.find((p) => p.endsWith("oshigo.otf"))!));
    const { missingChars } = typeset("章の日", DEFAULT_SETTINGS, new Face(oshigo));
    assert.deepEqual(missingChars, ["章"]);
    const noto = new FontService().load(null);
    assert.deepEqual(typeset("章の日　あ", DEFAULT_SETTINGS, noto.face).missingChars, []);
  });
});

describe("CFF の INDEX", () => {
  it("書いた INDEX を読み直すと同じ中身になる（オフセットの大きさが変わる場合も）", () => {
    for (const sizes of [[], [3, 0, 5], [300, 70000]]) {
      const items = sizes.map((n, i) => Uint8Array.from({ length: n }, (_, k) => (i + k) & 0xff));
      const back = readIndex(writeIndex(items), 0);
      assert.deepEqual(back.items.map((x) => [...x]), items.map((x) => [...x]));
    }
  });
});

describe("CFF の縮小", { skip: candidates.length === 0 && "CID 方式の CFF フォントがない" }, () => {
  for (const file of candidates) {
    const name = path.basename(file);

    it(`${name}：すべての字形を残すと、中身は元とまったく同じ`, () => {
      const cff = cffTable(file);
      const n = readIndex(cff, readDict(readIndex(cff, readIndex(cff, cff[2]).end).items[0]).find((e) => e.op === OP.CharStrings)!.operands[0]).items.length;
      const all = new Set(Array.from({ length: n }, (_, i) => i));
      assert.deepEqual(inspect(subsetCidCff(cff, all).bytes), inspect(cff));
    });

    it(`${name}：残さない字形だけが空（endchar）になり、CID の対応は変わらない`, () => {
      const cff = cffTable(file);
      const keep = new Set([1, 2, 100, 500]);
      const original = inspect(cff);
      const subset = inspect(subsetCidCff(cff, keep).bytes);
      assert.deepEqual(subset.charset, original.charset);
      subset.charStrings.forEach((cs, gid) => {
        if (gid === 0 || keep.has(gid)) assert.equal(cs, original.charStrings[gid]);
        else assert.equal(cs, "14");
      });
    });
  }
});
