import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inflateSync } from "node:zlib";
import { DEFAULT_SETTINGS, normalizeSpots, spotInks, tintHex, type Settings } from "../document/settings.js";
import { DEFAULT_STYLES, newCharacterStyle, normalizeStyles, type NestedStyle } from "../document/styles.js";
import { Face, typesetLazy } from "../engine/index.js";
import { nestedCellStyles } from "../engine/nested.js";
import { parse } from "../engine/parse.js";
import { FontService } from "../fonts/service.js";
import { checkPdfX } from "../output/check-pdfx.js";
import { exportPdf } from "../output/export-pdf.js";
import { preflight } from "../output/preflight.js";
import { inkPreview, readInks } from "../renderer/ink-preview.js";

let bytes: Uint8Array | undefined;
try {
  bytes = new FontService().load(null).bytes;
} catch {
  bytes = undefined;
}
const noFont = !bytes && "フォントがない";

/** 1行の原稿の字ごとに、先頭文字スタイルで当たる名前。 */
function nestedOf(text: string, rules: NestedStyle[]): string {
  const [b] = parse(text);
  assert.ok(b.kind === "para");
  const styles = nestedCellStyles(b.atoms, rules);
  return b.atoms.flatMap((a, ai) => a.cells.map((c, ci) => styles[ai][ci] ?? "・")).join("");
}

const RED = "#cc0000";
const BLUE = "#0000cc";

/** 本文の段落スタイルに先頭文字スタイル・行スタイルを付けた設定（赤・青の文字スタイル）。 */
function styled(over: (body: Settings["styles"]["paragraph"][number]) => void): Settings {
  const s = structuredClone(DEFAULT_SETTINGS);
  s.styles = structuredClone(DEFAULT_STYLES);
  s.styles.character.push({ ...newCharacterStyle("赤"), color: RED }, { ...newCharacterStyle("青"), color: BLUE });
  over(s.styles.paragraph.find((p) => p.name === "本文")!);
  return s;
}

describe("先頭文字スタイル", () => {
  it("上の規則から順に：区切りの字まで（含む）→ N字まで。続きは当てない", () => {
    const rules: NestedStyle[] = [
      { style: "A", until: "through", count: 1, chars: "　" },
      { style: "B", until: "chars", count: 2, chars: "" },
    ];
    assert.equal(nestedOf("第一章　本文です", rules), "AAAABB・・");
  });

  it("区切りの字の N 個目の前まで（区切りの字は次の規則）。区切りがなければ段落の終わりまで。なしの規則は範囲だけ進める", () => {
    assert.equal(nestedOf("一、二、三、四", [{ style: "A", until: "before", count: 2, chars: "、" }, { style: "B", until: "chars", count: 1, chars: "" }]), "AAAB・・・");
    assert.equal(nestedOf("区切りがない", [{ style: "A", until: "through", count: 1, chars: "：" }]), "AAAAAA");
    assert.equal(nestedOf("問一：答え", [{ style: "", until: "through", count: 1, chars: "：:" }, { style: "B", until: "chars", count: 1, chars: "" }]), "・・・B・");
  });

  it("組版：本文の段落スタイルの先頭文字スタイルが字の色になる。原稿の文字スタイルが優先", { skip: noFont }, () => {
    const s = styled((p) => (p.nested = [{ style: "赤", until: "through", count: 1, chars: "　" }]));
    const items = typesetLazy("［＃青］問［＃／青］一　答えは三。", s, new Face(bytes!)).page(0).items;
    const color = (t: string) => items.find((i) => i.text === t)!.color;
    assert.equal(color("問"), BLUE);
    assert.equal(color("一"), RED);
    assert.equal(color("答"), "#000000");
  });

  it("スタイルを読むとき、規則と行スタイルを収める", () => {
    const st = normalizeStyles({ paragraph: [{ name: "本文", nested: [{ style: "赤", until: "?", count: 0, chars: 3 }], lineStyle: { style: "赤", lines: 99 } }] });
    const body = st.paragraph.find((p) => p.name === "本文")!;
    assert.deepEqual(body.nested, [{ style: "赤", until: "chars", count: 1, chars: "　" }]);
    assert.deepEqual(body.lineStyle, { style: "赤", lines: 20 });
    assert.deepEqual(st.paragraph.find((p) => p.name === "大見出し")!.lineStyle, { style: "", lines: 0 });
  });
});

describe("行スタイル", () => {
  it("組版：段落の最初の N 行の字に当てる（文字スタイルの当たった字と2行目からは当てない）。行分けは変えない", { skip: noFont }, () => {
    const plain = styled(() => {});
    const s = styled((p) => (p.lineStyle = { style: "赤", lines: 1 }));
    const face = new Face(bytes!);
    const text = `［＃青］青［＃／青］${"あ".repeat(60)}`;
    const r = typesetLazy(text, s, face);
    const lines = r.lines(0).map((l) => l.text);
    assert.deepEqual(lines, typesetLazy(text, plain, face).lines(0).map((l) => l.text));
    const items = r.page(0).items;
    const first = lines[0].length;
    const colors = items.filter((i) => i.text === "あ").map((i) => i.color);
    // 1行目の「あ」（1行目の字数 - 「青」）は赤、ほかは黒。
    assert.ok(colors.slice(0, first - 1).every((c) => c === RED));
    assert.ok(colors.slice(first - 1).every((c) => c === "#000000"));
    assert.equal(items.find((i) => i.text === "青")!.color, BLUE);
  });
});

/** PDF のストリームを展開して、つないだ文字列にする。 */
function streams(pdf: Uint8Array): string {
  const raw = Buffer.from(pdf);
  const text = raw.toString("latin1");
  const out: string[] = [];
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const start = m.index + m[0].length;
    const end = text.indexOf("endstream", start);
    if (end < 0) break;
    const body = raw.subarray(start, end);
    try {
      out.push(inflateSync(body).toString("latin1"));
    } catch {
      out.push(body.toString("latin1"));
    }
  }
  return out.join("\n");
}

describe("特色の濃さ（平網）", () => {
  const SPOT = { name: "DIC 156", color: "#e4007f", cmyk: [0, 100, 0, 0] as [number, number, number, number], overprint: false, tints: [50] };
  const half = tintHex(SPOT.color, 50);

  it("画面の色は白と混ぜた色。登録では 1〜99 の整数を濃い順に。画面の色が重なる濃さは1つ", () => {
    assert.equal(half, "#f280bf");
    assert.equal(tintHex("#000000", 30), "#b3b3b3");
    assert.deepEqual(normalizeSpots([{ ...SPOT, tints: [30, "50", 0, 100, 30, 12.4] }])[0].tints, [50, 30, 12]);
    const inks = spotInks([SPOT, { ...SPOT, name: "白", color: "#ffffff", tints: [50] }]);
    assert.deepEqual(
      inks.map((i) => [i.hex, i.spot.name, i.tint]),
      [
        ["#e4007f", "DIC 156", 1],
        ["#ffffff", "白", 1],
        ["#f280bf", "DIC 156", 0.5],
      ],
    );
  });

  it("入稿用 PDF：濃さを変えた色は、同じ特色の版をその濃さで刷る。PDF/X-1a の検査に通る", { skip: noFont }, async () => {
    const s = structuredClone(DEFAULT_SETTINGS);
    s.output.spotColors = [structuredClone(SPOT)];
    s.styles.character.push({ ...newCharacterStyle("全"), color: SPOT.color }, { ...newCharacterStyle("半"), color: half });
    const r = await exportPdf("［＃全］濃［＃／全］［＃半］淡［＃／半］", s, [{ key: "", bytes: bytes! }], "t");
    const content = streams(r.bytes);
    assert.match(content, /\/SP0 cs\s+1 scn/);
    assert.match(content, /\/SP0 cs\s+0\.5 scn/);
    // 色空間は特色ごとに1つ。
    assert.equal(Buffer.from(r.bytes).toString("latin1").match(/\/Separation \/DIC#20156/g)?.length, 1);
    assert.deepEqual((await checkPdfX(r.bytes, "x1a")).filter((c) => !c.ok), []);
  });

  it("分版プレビューと検査：濃さを変えた色も特色の版に乗り、インキの量は濃さ", () => {
    const p = inkPreview({ plates: new Set(["DIC 156"]), gray: false, spots: [SPOT], overprintBlack: true, showOverprint: true });
    assert.equal(p.color(half), half);
    assert.equal(inkPreview({ plates: new Set(["M"]), gray: false, spots: [SPOT], overprintBlack: true, showOverprint: true }).color(half), null);
    assert.deepEqual(readInks(0xf2, 0x80, 0xbf, { gray: false, spots: [SPOT] }), [{ name: "DIC 156", percent: 50 }]);
    // 濃さを変えた色だけを使っても、その特色を使ったことになる（使っていないとは言わない）。
    const s = structuredClone(DEFAULT_SETTINGS);
    s.output.spotColors = [structuredClone(SPOT)];
    const page = { index: 0, width: 400, height: 600, paper: "#ffffff", items: [{ font: "vert" as const, text: "淡", glyphs: [], x: 200, y: 300, size: 10, sx: 1, color: half, face: 0 }], shapes: [] };
    const found = preflight({ settings: s, pageCount: 1, page: () => page, missingChars: [], fontWarnings: [], target: "pdf" });
    assert.ok(found.some((f) => f.message.includes("特色（DIC 156）の版を作ります")));
    assert.ok(!found.some((f) => f.message.includes("どこにも使っていません")));
  });
});
