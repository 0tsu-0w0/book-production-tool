import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { importIdml } from "../document/idml-import.js";
import { DEFAULT_SETTINGS, type Settings } from "../document/settings.js";
import { DEFAULT_STYLES } from "../document/styles.js";
import { findAll, parseXml } from "../document/xml.js";
import { Face, typesetLazy } from "../engine/index.js";
import { FontService } from "../fonts/service.js";
import { buildIdml } from "../output/idml.js";
import { ZipWriter } from "../output/zip.js";

let bytes: Uint8Array | undefined;
try {
  bytes = new FontService().load(null).bytes;
} catch {
  bytes = undefined;
}
const noFont = !bytes && "フォントがない";
const dec = new TextDecoder();

function settings(over: (s: Settings) => void = () => {}): Settings {
  const s = structuredClone(DEFAULT_SETTINGS);
  s.styles = structuredClone(DEFAULT_STYLES);
  over(s);
  return s;
}

function zipOf(files: { name: string; data: Uint8Array }[]): Uint8Array {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kolophon-toc-")), "t.idml");
  const zip = new ZipWriter(file);
  for (const f of files) zip.add(f.name, f.data);
  zip.close();
  return new Uint8Array(fs.readFileSync(file));
}
const withoutHint = (files: { name: string; data: Uint8Array }[]) => files.filter((f) => f.name !== "META-INF/kolophon.json");
const fileText = (files: { name: string; data: Uint8Array }[], name: string) => dec.decode(files.find((f) => f.name === name)!.data);

const DOC = [
  "［＃目次］",
  "＃第一章　雨",
  "　｜傘《かさ》［＃索引：傘（かさ）］を差す。" + "あ".repeat(600),
  "＃＃一　朝",
  "　［＃索引］長靴［＃／索引］を履く。",
  "＃第二章　晴れ",
  "　また傘［＃索引：傘（かさ）］。",
  "［＃索引ページ］",
].join("\n");

/** Kolophon で組んで、ページ番号の字と目次・索引の段落を渡して書き出す（main.ts と同じ渡し方）。 */
function exportWithLayout(text: string, s: Settings) {
  const r = typesetLazy(text, s, new Face(bytes!));
  const labels = r.labelPages();
  return buildIdml(text, s, {
    pageCount: r.pageCount,
    generated: r.generated(),
    pageOf: (label) => {
      const i = labels.get(label);
      return i === undefined ? undefined : r.pageLabels[i]?.replace(/^0+(?=\d)/, "");
    },
  });
}

describe("IDML の目次", () => {
  it("Kolophon で組んだ目次を、ページ番号の字のまま入れる。見出しと番号の間はタブ、タブはリーダー付きの右揃え", { skip: noFont }, () => {
    const r = exportWithLayout(DOC, settings());
    assert.ok(!r.skipped.some((x) => x.startsWith("目次")), r.skipped.join());
    const story = fileText(r.files, "Stories/Story_u1.xml");
    // 題と項目（大見出しは「目次の項目1」、中見出しは「目次の項目2」）。
    assert.match(story, /AppliedParagraphStyle="ParagraphStyle\/目次の題"[^>]*>(?:<[^>]+>)*<Content>目次<\/Content>/);
    const entries = [...story.matchAll(/AppliedParagraphStyle="ParagraphStyle\/(目次の項目[12])"[^>]*>([\s\S]*?)<\/ParagraphStyleRange>/g)].map((m) => [
      m[1],
      [...m[2].matchAll(/<Content>([^<]*)<\/Content>/g)].map((c) => c[1]).join(""),
    ]);
    assert.deepEqual(
      entries.map(([style, t]) => [style, t.split("\t")[0]]),
      [
        ["目次の項目1", "第一章　雨"],
        ["目次の項目2", "一　朝"],
        ["目次の項目1", "第二章　晴れ"],
      ],
    );
    // 番号は、Kolophon で組んだページの番号（目次は1ページ目、第一章は3ページ目から＝改丁）。
    for (const [, t] of entries) assert.match(t, /\t[0-9０-９]+$/);
    // 目次の項目の段落スタイル：右揃えのタブとリーダー。InDesign で作り直すための目次スタイル。
    const styles = fileText(r.files, "Resources/Styles.xml");
    assert.match(styles, /<ParagraphStyle Self="ParagraphStyle\/目次の項目1"[\s\S]*?<TabList type="list"><ListItem type="record"><Alignment type="enumeration">RightAlign<\/Alignment>[\s\S]*?<Leader type="string">…<\/Leader>/);
    assert.match(styles, /<TOCStyle Self="TOCStyle\/Kolophon目次" Name="Kolophon目次" Title="目次" TitleStyle="ParagraphStyle\/目次の題"[^>]*><TOCStyleEntry [^>]*Name="大見出し" FormatStyle="ParagraphStyle\/目次の項目1" Level="1"/);
  });

  it("組んだ目次を渡さなければ、目次は入れずに知らせる（前と同じ）", () => {
    const r = buildIdml(DOC, settings(), { pageCount: 3 });
    assert.ok(r.skipped.some((x) => x.startsWith("目次")));
    assert.ok(r.skipped.includes("索引"));
  });

  it("読み込むと、目次の段落の並びは［＃目次］に、題は目次の設定に戻す", { skip: noFont }, () => {
    const r = exportWithLayout(DOC, settings((s) => (s.toc.title = "もくじ")));
    const back = importIdml(zipOf(withoutHint(r.files)));
    const lines = back.text.split("\n");
    assert.equal(lines[0], "［＃目次］");
    assert.equal(lines.filter((l) => l === "［＃目次］").length, 1);
    assert.ok(!lines.some((l) => l.includes("目次の項目")), back.text.slice(0, 300));
    assert.equal(back.settings.toc.title, "もくじ");
  });
});

describe("IDML の索引", () => {
  it("本文の語の所に索引の項目（PageReference）、語の一覧（Topic）、組んだ索引の段落を入れる", { skip: noFont }, () => {
    const r = exportWithLayout(DOC, settings());
    const story = fileText(r.files, "Stories/Story_u1.xml");
    const refs = findAll(parseXml(story), "PageReference").map((p) => p.attrs.ReferencedTopic);
    assert.equal(refs.length, 3);
    const dm = fileText(r.files, "designmap.xml");
    const topics = findAll(parseXml(dm), "Topic").map((t) => [t.attrs.Self, t.attrs.Name, t.attrs.SortOrder]);
    // 同じ語（傘・かさ）は1つの項目。
    assert.deepEqual(
      topics.map(([, name, sort]) => [name, sort]),
      [
        ["傘", "かさ"],
        ["長靴", "長靴"],
      ],
    );
    assert.equal(refs[0], refs[2]);
    // 索引の段落：行の見出し（か・な）と、語・タブ・ページ番号（同じページなら1つ）。
    const entries = [...story.matchAll(/AppliedParagraphStyle="ParagraphStyle\/索引の項目"[^>]*>([\s\S]*?)<\/ParagraphStyleRange>/g)].map((m) =>
      [...m[1].matchAll(/<Content>([^<]*)<\/Content>/g)].map((c) => c[1]).join(""),
    );
    assert.equal(entries.length, 2);
    assert.match(entries[0], /^傘\t[0-9０-９]+(、[0-9０-９]+)?$/);
    assert.match(story, /AppliedParagraphStyle="ParagraphStyle\/索引の見出し"[^>]*>(?:<[^>]+>)*<Content>か<\/Content>/);
  });

  it("読み込むと、索引の項目は［＃索引：語（よみ）］（その語の1字目のあと）に、索引の段落は［＃索引ページ］に戻す", { skip: noFont }, () => {
    const r = exportWithLayout(DOC, settings());
    const back = importIdml(zipOf(withoutHint(r.files)));
    // ルビの付いた語は、ルビの記法のあとに。
    assert.match(back.text, /｜傘《かさ》［＃索引：傘（かさ）］を差す/);
    assert.match(back.text, /長［＃索引：長靴］靴を履く/);
    assert.match(back.text, /また傘［＃索引：傘（かさ）］。/);
    const lines = back.text.split("\n");
    assert.equal(lines.filter((l) => l === "［＃索引ページ］").length, 1);
    assert.ok(!lines.some((l) => /^［＃索引の(項目|見出し)］/.test(l)));
    // 読み直して組むと、Kolophon でも同じ語の索引になる。
    const again = typesetLazy(back.text, back.settings, new Face(bytes!)).generated().index;
    assert.ok(again && again.length > 0);
  });
});

describe("IDML の段落の罫線・網掛け", () => {
  const decorated = () =>
    settings((s) => {
      const p = s.styles.paragraph.find((x) => x.name === "中見出し")!;
      p.decoration = {
        ruleBefore: { on: true, kind: "double", width: 1.5, color: "#c00000", gap: 0.5 },
        ruleAfter: { on: true, kind: "dotted", width: 0.5, color: null, gap: 0.25 },
        border: { on: false, kind: "solid", width: 0.5, color: null, gap: 0.5 },
        shading: "#eeeeee",
        pad: 0.5,
        length: "text",
      };
      const q = s.styles.paragraph.find((x) => x.name === "大見出し")!;
      q.decoration = { ...structuredClone(q.decoration), border: { on: true, kind: "dashed", width: 1, color: null, gap: 0.5 }, pad: 1 };
    });

  it("段落境界線（前・後）・段落の囲み罫・段落の背景色にする", () => {
    const r = buildIdml("＃章\n＃＃節\n本文。", decorated(), { pageCount: 1 });
    assert.ok(!r.skipped.some((x) => x.includes("罫線")), r.skipped.join());
    const styles = parseXml(fileText(r.files, "Resources/Styles.xml"));
    const style = (name: string) => findAll(styles, "ParagraphStyle").find((p) => p.attrs.Name === name)!.attrs;
    const mid = style("中見出し");
    assert.equal(mid.RuleAbove, "true");
    assert.equal(mid.RuleAboveLineWeight, "1.5");
    assert.equal(mid.RuleAboveType, "StrokeStyle/$ID/ThinThin");
    assert.match(mid.RuleAboveColor, /^Color\/C=/);
    assert.equal(mid.RuleAboveWidth, "TextWidth");
    assert.equal(mid.RuleBelow, "true");
    assert.equal(mid.RuleBelowType, "StrokeStyle/$ID/Dotted");
    assert.equal(mid.ParagraphShadingOn, "true");
    assert.equal(mid.ParagraphBorderOn, undefined);
    const big = style("大見出し");
    assert.equal(big.ParagraphBorderOn, "true");
    assert.equal(big.ParagraphBorderType, "StrokeStyle/$ID/Dashed");
    assert.equal(big.ParagraphBorderTopLineWeight, "1");
    // 罫の種類は Graphic に定義がある。
    const graphic = fileText(r.files, "Resources/Graphic.xml");
    for (const t of ["Solid", "ThinThin", "Dotted", "Dashed"]) assert.ok(graphic.includes(`StrokeStyle/$ID/${t}"`), t);
  });

  it("読み込むと、Kolophon の段落の罫線・網掛けに戻す", () => {
    const s = decorated();
    const r = buildIdml("＃章\n＃＃節\n本文。", s, { pageCount: 1 });
    const back = importIdml(zipOf(withoutHint(r.files)));
    const mid = back.settings.styles.paragraph.find((p) => p.name === "中見出し")!.decoration;
    const want = s.styles.paragraph.find((p) => p.name === "中見出し")!.decoration;
    assert.deepEqual([mid.ruleBefore.on, mid.ruleBefore.kind, mid.ruleBefore.width, mid.ruleBefore.gap], [true, "double", 1.5, 0.5]);
    // 色は CMYK を通るので、少しずれる（ほかの色の読み込みと同じ）。
    const near = (a: string | null, b: string) => !!a && [1, 3, 5].every((i) => Math.abs(parseInt(a.slice(i, i + 2), 16) - parseInt(b.slice(i, i + 2), 16)) <= 4);
    assert.ok(near(mid.ruleBefore.color, "#c00000"), String(mid.ruleBefore.color));
    assert.deepEqual([mid.ruleAfter.on, mid.ruleAfter.kind, mid.ruleAfter.gap], [true, "dotted", 0.25]);
    assert.ok(near(mid.shading, want.shading!), String(mid.shading));
    assert.equal(mid.length, "text");
    assert.equal(mid.border.on, false);
    const big = back.settings.styles.paragraph.find((p) => p.name === "大見出し")!.decoration;
    assert.deepEqual([big.border.on, big.border.kind, big.border.width, big.pad], [true, "dashed", 1, 1]);
  });
});
