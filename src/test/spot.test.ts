import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inflateSync } from "node:zlib";
import { DEFAULT_SETTINGS, normalizeSettings, normalizeSpots, type Settings } from "../document/settings.js";
import { newCharacterStyle } from "../document/styles.js";
import { FontService } from "../fonts/service.js";
import { checkPdfX } from "../output/check-pdfx.js";
import { exportPdf } from "../output/export-pdf.js";

let bytes: Uint8Array | undefined;
try {
  bytes = new FontService().load(null).bytes;
} catch {
  bytes = undefined;
}

/** PDF のストリームを展開して、つないだ文字列にする（ページの描画命令を調べるため）。 */
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

const SPOT = { name: "DIC 156", color: "#e4007f", cmyk: [0, 100, 0, 0] as [number, number, number, number], overprint: false };

function withSpot(over: (s: Settings) => void = () => {}): Settings {
  const s = structuredClone(DEFAULT_SETTINGS);
  s.output.spotColors = [structuredClone(SPOT)];
  s.styles.character.push({ ...newCharacterStyle("特色"), color: SPOT.color });
  over(s);
  return s;
}

const TEXT = "吾輩は［＃特色］猫［＃／特色］である。";

describe("特色とオーバープリント", () => {
  it("特色の登録：名前と色がないもの・重なるものは捨て、CMYK は 0〜100 に収める", () => {
    const spots = normalizeSpots([
      { name: " DIC 156 ", color: "#E4007F", cmyk: [0, 120, -5], overprint: true },
      { name: "DIC 156", color: "#000001" },
      { name: "金", color: "#e4007f" },
      { name: "", color: "#123456" },
      { name: "銀", color: "red" },
    ]);
    assert.deepEqual(spots, [{ name: "DIC 156", color: "#e4007f", cmyk: [0, 100, 0, 0], overprint: true }]);
    assert.deepEqual(normalizeSettings({}).output.spotColors, []);
    assert.equal(normalizeSettings({}).output.overprintBlack, true);
  });

  it("入稿用 PDF：特色の色で描いた字を Separation の版で刷る。PDF/X-1a の検査に通る", { skip: !bytes && "フォントがない" }, async () => {
    const r = await exportPdf(TEXT, withSpot(), [{ key: "", bytes: bytes! }], "t");
    const raw = Buffer.from(r.bytes).toString("latin1");
    assert.match(raw, /\/Separation \/DIC#20156 \/DeviceCMYK/);
    const content = streams(r.bytes);
    assert.match(content, /\/SP0 cs\s+1 scn/);
    assert.deepEqual(r.check?.filter((c) => !c.ok), []);
    assert.deepEqual((await checkPdfX(r.bytes, "x1a")).filter((c) => !c.ok), []);
  });

  it("スミ（K100%）の文字はノセ。設定で切れる。特色はノセの指定のとおり", { skip: !bytes && "フォントがない" }, async () => {
    const on = streams((await exportPdf(TEXT, withSpot(), [{ key: "", bytes: bytes! }], "t")).bytes);
    // 黒の字の前はノセ、特色の字の前は抜き（ノセにしない）。
    assert.match(on, /\/GSop gs[\s\S]*0 0 0 1 k/);
    assert.match(on, /\/GSko gs\s+\/SP0 cs/);
    const off = streams((await exportPdf(TEXT, withSpot((s) => (s.output.overprintBlack = false)), [{ key: "", bytes: bytes! }], "t")).bytes);
    assert.doesNotMatch(off, /\/GSop gs/);
    const spotOver = streams((await exportPdf(TEXT, withSpot((s) => (s.output.spotColors[0].overprint = true)), [{ key: "", bytes: bytes! }], "t")).bytes);
    assert.match(spotOver, /\/GSop gs\s+\/SP0 cs/);
  });

  it("閲覧用 PDF とグレースケールでは特色を使わない（画面の色のまま）", { skip: !bytes && "フォントがない" }, async () => {
    const screen = await exportPdf(TEXT, withSpot((s) => (s.pdfKind = "screen")), [{ key: "", bytes: bytes! }], "t");
    assert.doesNotMatch(Buffer.from(screen.bytes).toString("latin1"), /\/Separation \/DIC/);
    assert.doesNotMatch(streams(screen.bytes), / gs\b/);
    const gray = await exportPdf(TEXT, withSpot((s) => (s.output.color = "gray")), [{ key: "", bytes: bytes! }], "t");
    assert.doesNotMatch(Buffer.from(gray.bytes).toString("latin1"), /\/Separation \/DIC/);
  });
});
