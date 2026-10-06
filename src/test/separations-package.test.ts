import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { parseDocument } from "../document/document.js";
import { DEFAULT_SETTINGS } from "../document/settings.js";
import { writePackage } from "../output/package.js";
import { hexToCmyk as outputHexToCmyk } from "../output/color.js";
import { cmykToRgb, hexToCmyk } from "../engine/ink-color.js";
import { inkPreview, readInks } from "../renderer/ink-preview.js";

const SPOT = { name: "DIC 156", color: "#e4007f", cmyk: [0, 100, 0, 0] as [number, number, number, number], overprint: false };
const all = new Set(["C", "M", "Y", "K", "DIC 156"]);

describe("分版プレビュー", () => {
  it("書き出しと同じ式で CMYK にする（PDF の側と同じ値）", () => {
    assert.deepEqual(hexToCmyk("#ff0000"), [0, 1, 1, 0]);
    assert.deepEqual(outputHexToCmyk("#336699"), hexToCmyk("#336699"));
    assert.deepEqual(cmykToRgb(0, 1, 1, 0), [255, 0, 0]);
  });

  it("選んだ版だけで刷った色にする。どの版にも乗らない色は描かない", () => {
    const opts = { gray: false, spots: [SPOT], overprintBlack: true, showOverprint: true };
    const full = inkPreview({ ...opts, plates: all });
    assert.equal(full.color("#000000"), "#000000");
    assert.equal(full.color("#ff0000"), "#ff0000");
    // K の版を外すと、黒（K100%）は描かず、赤（M・Y）はそのまま。
    const noK = inkPreview({ ...opts, plates: new Set(["C", "M", "Y", "DIC 156"]) });
    assert.equal(noK.color("#000000"), null);
    assert.equal(noK.color("#ff0000"), "#ff0000");
    // M の版だけ：赤は M だけ（マゼンタ）、特色は特色の版を外したので描かない。
    const onlyM = inkPreview({ ...opts, plates: new Set(["M"]) });
    assert.equal(onlyM.color("#ff0000"), "#ff00ff");
    assert.equal(onlyM.color(SPOT.color), null);
    // 特色の版だけ：特色は登録した色で、プロセスの色は描かない。
    const onlySpot = inkPreview({ ...opts, plates: new Set(["DIC 156"]) });
    assert.equal(onlySpot.color("#E4007F"), "#e4007f");
    assert.equal(onlySpot.color("#000000"), null);
  });

  it("オーバープリント：スミ（K100%）とノセの特色は重ねて描く（見ないときは重ねない）", () => {
    const base = { gray: false, overprintBlack: true, plates: all };
    const p = inkPreview({ ...base, spots: [{ ...SPOT, overprint: true }], showOverprint: true });
    assert.equal(p.overprint("#000000"), true);
    assert.equal(p.overprint("#333333"), false);
    assert.equal(p.overprint(SPOT.color), true);
    assert.equal(inkPreview({ ...base, spots: [SPOT], showOverprint: false }).overprint("#000000"), false);
    assert.equal(inkPreview({ ...base, spots: [SPOT], overprintBlack: false, showOverprint: true }).overprint("#000000"), false);
  });

  it("グレースケールでは K の版だけ。画像の画素も版を外せる", () => {
    const g = inkPreview({ gray: true, spots: [SPOT], overprintBlack: true, showOverprint: true, plates: new Set(["K"]) });
    assert.equal(g.color("#ffffff"), null);
    assert.equal(g.color("#000000"), "#000000");
    const noK = inkPreview({ gray: true, spots: [], overprintBlack: true, showOverprint: true, plates: new Set() });
    assert.deepEqual(noK.pixel(10, 10, 10), [255, 255, 255]);
    const onlyC = inkPreview({ gray: false, spots: [], overprintBlack: true, showOverprint: true, plates: new Set(["C"]) });
    assert.deepEqual(onlyC.pixel(0, 0, 255), [0, 255, 255]);
    assert.deepEqual(readInks(0, 0, 0, { gray: false, spots: [] }), [
      { name: "C", percent: 0 },
      { name: "M", percent: 0 },
      { name: "Y", percent: 0 },
      { name: "K", percent: 100 },
    ]);
    assert.deepEqual(readInks(0xe4, 0, 0x7f, { gray: false, spots: [SPOT] }), [{ name: "DIC 156", percent: 100 }]);
  });
});

describe("パッケージ", () => {
  it("文書・画像・書体・入稿用 PDF・指示書を1つのフォルダに書き出す。見つからない書体は入れずに知らせる", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kolophon-pkg-"));
    const out = path.join(dir, "本 フォルダ");
    const fontDir = fs.mkdtempSync(path.join(os.tmpdir(), "kolophon-font-"));
    // 書体のファイル（中身は読めない偽物：埋め込みの許可が分からないものは入れる）。
    const fake = path.join(fontDir, "Fake.otf");
    fs.writeFileSync(fake, "not a font");
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.output.spotColors = [SPOT];
    settings.bookInfo.title = "雨の図書館";
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
    let pdfAsked = "";
    const r = await writePackage({
      dir: out,
      name: "本",
      text: "　本文。",
      settings,
      images: [{ name: "絵", mime: "image/png", data: png.toString("base64"), width: 1, height: 1 }],
      fonts: [
        { name: "偽の書体", postscriptName: "Fake", path: fake, index: 0 },
        { name: "偽の書体", postscriptName: "Fake", path: fake, index: 0 },
        { name: "ない書体", postscriptName: "None", path: path.join(fontDir, "none.ttf"), index: 0 },
      ],
      findings: [{ level: "warning", message: "仕上がり線の近くに文字があります。" }],
      pdf: async (file) => {
        pdfAsked = file;
        fs.writeFileSync(file, "%PDF-1.4");
        return { pages: 1, standard: "x1a", problems: [] };
      },
      appVersion: "0.0.0",
      now: new Date(2026, 9, 6, 9, 5),
    });
    assert.deepEqual(r.files.sort(), ["Fonts/Fake.otf".replace("/", path.sep), "Links/絵.png".replace("/", path.sep), "指示書.txt", "本.kolo", "本.pdf"].sort());
    assert.equal(path.basename(pdfAsked), "本.pdf");
    assert.deepEqual(r.skippedFonts, [{ name: "ない書体", reason: "ファイルが見つかりません" }]);
    // 文書はそのまま開ける。
    assert.equal(parseDocument(fs.readFileSync(path.join(out, "本.kolo"), "utf8")).images[0].name, "絵");
    const report = fs.readFileSync(path.join(out, "指示書.txt"), "utf8");
    assert.ok(report.startsWith("﻿"));
    for (const word of ["書名：雨の図書館", "DIC 156", "本.pdf（1ページ", "[注意] 仕上がり線の近く", "ない書体　→ 入れていません", "2026年10月6日 09:05"]) assert.ok(report.includes(word), word);
  });

  it("入稿用 PDF を書き出せなかったときは、指示書にそう書く", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kolophon-pkg-"));
    const r = await writePackage({
      dir: path.join(dir, "p"),
      name: "a/b",
      text: "",
      settings: structuredClone(DEFAULT_SETTINGS),
      images: [],
      fonts: [],
      findings: [],
      pdf: async () => ({ error: "ICC プロファイルが見つかりません" }),
      appVersion: "0.0.0",
    });
    assert.ok(r.files.includes("a_b.kolo"));
    assert.ok(!r.files.some((f) => f.endsWith(".pdf")));
    assert.match(fs.readFileSync(path.join(dir, "p", "指示書.txt"), "utf8"), /書き出せませんでした：ICC プロファイルが見つかりません/);
  });
});
