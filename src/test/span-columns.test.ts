import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { importIdml } from "../document/idml-import.js";
import { DEFAULT_SETTINGS, normalizeSettings, type Settings } from "../document/settings.js";
import { DEFAULT_STYLES } from "../document/styles.js";
import { Face, typesetLazy } from "../engine/index.js";
import type { DrawItem } from "../engine/types.js";
import { FontService } from "../fonts/service.js";
import { buildIdml } from "../output/idml.js";
import { ZipWriter } from "../output/zip.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let bytes: Uint8Array | undefined;
try {
  bytes = new FontService().load(null).bytes;
} catch {
  bytes = undefined;
}
const noFont = !bytes && "フォントがない";

function settings(columns: number, span = true, over: (s: Settings) => void = () => {}): Settings {
  const s = structuredClone(DEFAULT_SETTINGS);
  s.styles = structuredClone(DEFAULT_STYLES);
  s.layoutMode = "book";
  s.book.columns = columns;
  if (span) s.styles.paragraph.find((p) => p.name === "大見出し")!.spanColumns = true;
  over(s);
  return s;
}

const body = (mark: string, n: number) => Array.from({ length: n }, (_, i) => `${mark.repeat(30)}${i}`);

/** ページの行（x の同じ字）ごとに、y の範囲と字。右の行から。 */
function rows(items: DrawItem[]) {
  const map = new Map<number, { x: number; top: number; bottom: number; text: string }>();
  for (const it of items) {
    if (!it.src) continue;
    const k = Math.round(it.x);
    const r = map.get(k) ?? { x: it.x, top: Infinity, bottom: -Infinity, text: "" };
    r.top = Math.min(r.top, it.y);
    r.bottom = Math.max(r.bottom, it.y);
    r.text += it.text;
    map.set(k, r);
  }
  return [...map.values()].sort((a, b) => b.x - a.x);
}

describe("段抜きの見出し（#8）", () => {
  it("見出しはすべての段をまたぐ長さで組み、前の本文は段の長さをそろえて割り直す", { skip: noFont }, () => {
    const text = [...body("あ", 8), "＃第二章　晴れ", ...body("い", 18)].join("\n");
    const r = typesetLazy(text, settings(2), new Face(bytes!));
    assert.equal(r.pageCount, 1);
    const page = r.page(0);
    const rs = rows(page.items);
    const head = rs.findIndex((x) => x.text.startsWith("第二章"));
    // 前の本文 8行は、2段に4行ずつ（どの行も、2段目まで字がある）。
    assert.equal(head, 4);
    const columnLength = r.charsPerLine * page.items[0].size;
    for (const row of rs.slice(0, 4)) assert.ok(row.bottom - row.top > columnLength, row.text.slice(0, 5));
    // 見出しは1行（段をまたぐ長さなので折り返さない）。字は1段目の上から。
    assert.equal(rs[head].text, "第二章　晴れ");
    // 見出しのあとの本文は、見出しより左（縦組み）から、残りの幅で1段目・2段目と流れる。
    const after = rs.slice(head + 1);
    assert.ok(after.every((x) => x.x < rs[head].x));
    assert.equal(after.length, r.linesPerPage - 5);
  });

  it("見出しとそのあと1行が入らなければ、見出しは次のページの頭へ", { skip: noFont }, () => {
    const s = settings(2);
    const r0 = typesetLazy(body("あ", 1).join("\n"), s, new Face(bytes!));
    const per = r0.linesPerPage;
    // 2段の本文がほぼ埋まる量（段の長さをそろえると、ページの幅いっぱい）。
    const text = [...body("あ", per * 2 - 1), "＃第二章", ...body("い", 3)].join("\n");
    const r = typesetLazy(text, s, new Face(bytes!));
    assert.equal(r.pageCount, 2);
    const second = rows(r.page(1).items);
    assert.ok(second[0].text.startsWith("第二章"), second[0].text);
  });

  it("段組みでなければ、段抜きにしても組み方は変わらない。段抜きをしないときも、今までどおり", { skip: noFont }, () => {
    const text = [...body("あ", 8), "＃第二章　晴れ", ...body("い", 18)].join("\n");
    const fp = (s: Settings) => {
      const r = typesetLazy(text, s, new Face(bytes!));
      return Array.from({ length: r.pageCount }, (_, i) => JSON.stringify(r.page(i).items.map((it) => [it.text, Math.round(it.x * 100), Math.round(it.y * 100)]))).join("|");
    };
    assert.equal(fp(settings(1, true)), fp(settings(1, false)));
    // 2段組みで段抜きをしないと、見出しは1段目の9行目（見出しの前の本文はそろえず、1段目に8行）。
    const r = typesetLazy(text, settings(2, false), new Face(bytes!));
    const rs = rows(r.page(0).items);
    assert.equal(rs.findIndex((x) => x.text.includes("第二章")), 8);
  });

  it("スタイルを読むとき段抜きを残す。IDML では SpanColumnType にし、読み込むと戻す", () => {
    const n = normalizeSettings(settings(2));
    assert.equal(n.styles.paragraph.find((p) => p.name === "大見出し")!.spanColumns, true);
    assert.equal(n.styles.paragraph.find((p) => p.name === "本文")!.spanColumns, undefined);
    const r = buildIdml("＃章\n本文。", settings(2), { pageCount: 1 });
    const styles = new TextDecoder().decode(r.files.find((f) => f.name === "Resources/Styles.xml")!.data);
    assert.match(styles, /<ParagraphStyle Self="ParagraphStyle\/大見出し"[^>]*SpanColumnType="SpanColumns" SpanSplitColumnCount="All"/);
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kolophon-span-")), "t.idml");
    const zip = new ZipWriter(file);
    for (const f of r.files.filter((f) => f.name !== "META-INF/kolophon.json")) zip.add(f.name, f.data);
    zip.close();
    const back = importIdml(new Uint8Array(fs.readFileSync(file)));
    assert.equal(back.settings.styles.paragraph.find((p) => p.name === "大見出し")!.spanColumns, true);
  });
});
