import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { parseDocument, serializeDocument, type DocImage } from "../document/document.js";
import { importIdml } from "../document/idml-import.js";
import { linkBaseName, linkOf, linkStatus, readLinkedImage, withRelative } from "../document/image-link.js";
import { linkFindings } from "../document/link-findings.js";
import { DEFAULT_SETTINGS } from "../document/settings.js";
import { buildIdml } from "../output/idml.js";
import { writePackage } from "../output/package.js";
import { ZipWriter } from "../output/zip.js";

// 1×1 の PNG（2つ。中身が違う）。
const PNG_A = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const PNG_B = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "kolophon-link-"));

describe("画像のリンクの状態", () => {
  it("元のファイルと同じ・変わった（更新日時か大きさ）・見つからない", () => {
    const dir = tmp();
    const file = path.join(dir, "絵.png");
    fs.writeFileSync(file, PNG_A);
    const link = linkOf(file);
    assert.equal(link.path, path.resolve(file));
    assert.equal(link.size, PNG_A.length);
    assert.equal(linkStatus(link).state, "ok");
    // 中身を替える（更新日時も進める）。
    fs.writeFileSync(file, Buffer.concat([PNG_B, Buffer.from([0])]));
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
    assert.equal(linkStatus(link).state, "modified");
    fs.rmSync(file);
    assert.deepEqual(linkStatus(link), { state: "missing" });
  });

  it("元の場所になければ、文書のフォルダからの相対の場所で探す（フォルダごと移したとき）", () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, "本", "画像"), { recursive: true });
    const doc = path.join(dir, "本", "原稿.kolo");
    const file = path.join(dir, "本", "画像", "表紙.png");
    fs.writeFileSync(file, PNG_A);
    const link = linkOf(file, doc);
    assert.equal(link.relative, "画像/表紙.png");
    // フォルダごと移す。
    fs.renameSync(path.join(dir, "本"), path.join(dir, "移した本"));
    const moved = path.join(dir, "移した本", "原稿.kolo");
    const st = linkStatus(link, moved);
    assert.equal(st.state, "ok");
    assert.equal(st.path, path.join(dir, "移した本", "画像", "表紙.png"));
    // 文書の場所が分からなければ、見つからない。
    assert.equal(linkStatus(link).state, "missing");
    // 保存するときは、保存する文書からの相対の場所に付け直す。
    assert.equal(withRelative({ ...link, path: st.path! }, path.join(dir, "移した本", "別", "x.kolo")).relative, "../画像/表紙.png");
  });

  it("読み直し：PNG・JPEG なら中身とリンク、ほかは理由", () => {
    const dir = tmp();
    const file = path.join(dir, "a.png");
    fs.writeFileSync(file, PNG_B);
    const r = readLinkedImage(file);
    assert.ok(!("error" in r));
    if (!("error" in r)) {
      assert.equal(r.mime, "image/png");
      assert.equal(Buffer.from(r.data, "base64").compare(PNG_B), 0);
      assert.equal(r.link.size, PNG_B.length);
    }
    fs.writeFileSync(path.join(dir, "b.png"), "not an image");
    assert.match((readLinkedImage(path.join(dir, "b.png")) as { error: string }).error, /PNG・JPEG ではありません/);
    assert.match((readLinkedImage(path.join(dir, "none.png")) as { error: string }).error, /見つかりません/);
  });

  it("文書に保存して読むとリンクが残る。形の違うリンクは外す（画像はそのまま）", () => {
    const img = (link: unknown) => ({ name: "絵", mime: "image/png", data: PNG_A.toString("base64"), width: 1, height: 1, link }) as DocImage;
    const ok = parseDocument(serializeDocument({ text: "", settings: structuredClone(DEFAULT_SETTINGS), images: [img({ path: "C:/絵.png", relative: "絵.png", modified: 1, size: 2 })] }));
    assert.deepEqual(ok.images[0].link, { path: "C:/絵.png", relative: "絵.png", modified: 1, size: 2 });
    const bad = parseDocument(serializeDocument({ text: "", settings: structuredClone(DEFAULT_SETTINGS), images: [img({ path: 3 })] }));
    assert.equal(bad.images.length, 1);
    assert.equal(bad.images[0].link, undefined);
  });
});

describe("リンクとパッケージ・IDML", () => {
  const linked = (dir: string): DocImage => {
    const file = path.join(dir, "元の絵 01.png");
    fs.writeFileSync(file, PNG_A);
    return { name: "絵", mime: "image/png", data: PNG_A.toString("base64"), width: 1, height: 1, link: linkOf(file) };
  };

  it("パッケージ：画像は元のファイル名で集め、中の文書のリンクは集めた画像（Links）を指す", async () => {
    const dir = tmp();
    const img = linked(dir);
    const out = path.join(dir, "pkg");
    const r = await writePackage({ dir: out, name: "本", text: "", settings: structuredClone(DEFAULT_SETTINGS), images: [img, { ...img, name: "絵2" }], fonts: [], findings: [], appVersion: "0.0.0" });
    assert.ok(r.files.includes(path.join("Links", "元の絵 01.png")));
    assert.ok(r.files.includes(path.join("Links", "元の絵 01_2.png")));
    assert.equal(r.files[0], "本.kolo");
    const doc = parseDocument(fs.readFileSync(path.join(out, "本.kolo"), "utf8"));
    assert.equal(doc.images[0].link?.relative, "Links/元の絵 01.png");
    // パッケージのフォルダを移しても、リンクが切れない。
    fs.renameSync(out, path.join(dir, "渡した"));
    assert.equal(linkStatus(doc.images[0].link!, path.join(dir, "渡した", "本.kolo")).state, "ok");
    assert.match(fs.readFileSync(path.join(dir, "渡した", "指示書.txt"), "utf8"), /元のファイル：/);
  });

  it("IDML：リンクのファイル名は元のファイル名。読み込むと、その画像にリンクを付ける", () => {
    const dir = tmp();
    const img = linked(dir);
    assert.equal(linkBaseName(img), "元の絵 01");
    const linkDir = path.join(dir, "out Links");
    const r = buildIdml("［＃画像：絵］", structuredClone(DEFAULT_SETTINGS), {
      pageCount: 1,
      pages: [{ images: [{ name: "絵", x: 10, y: 10, w: 100, h: 100 }], hasText: false }],
      images: [img],
      linkPath: (f) => path.join(linkDir, f),
    });
    assert.deepEqual(r.links.map((l) => path.basename(l.path)), ["元の絵 01.png"]);
    fs.mkdirSync(linkDir, { recursive: true });
    for (const l of r.links) fs.writeFileSync(l.path, l.data);
    const file = path.join(dir, "out.idml");
    const zip = new ZipWriter(file);
    for (const f of r.files) zip.add(f.name, f.data);
    zip.close();
    const back = importIdml(new Uint8Array(fs.readFileSync(file)));
    assert.equal(back.images[0].name, "絵");
    assert.equal(back.images[0].link?.path, path.join(linkDir, "元の絵 01.png"));
    assert.equal(linkStatus(back.images[0].link!).state, "ok");
  });
});

describe("書き出す前の検査の、画像のリンクの知らせ（#20）", () => {
  it("元のファイルが変わった画像は注意、見つからない画像は参考、同じなら知らせない。リンクのない画像も知らせない", () => {
    const dir = tmp();
    const a = path.join(dir, "変わる絵.png");
    const b = path.join(dir, "消える絵.png");
    const c = path.join(dir, "同じ絵.png");
    for (const f of [a, b, c]) fs.writeFileSync(f, PNG_A);
    const data = PNG_A.toString("base64");
    const images: DocImage[] = [
      { name: "変わる絵", mime: "image/png", data, width: 1, height: 1, link: linkOf(a) },
      { name: "消える絵", mime: "image/png", data, width: 1, height: 1, link: linkOf(b) },
      { name: "同じ絵", mime: "image/png", data, width: 1, height: 1, link: linkOf(c) },
      { name: "リンクなし", mime: "image/png", data, width: 1, height: 1 },
    ];
    fs.writeFileSync(a, Buffer.concat([PNG_B, Buffer.from([0])]));
    fs.utimesSync(a, new Date(), new Date(Date.now() + 5000));
    fs.rmSync(b);
    const findings = linkFindings(images, (img) => (img.link ? linkStatus(img.link).state : undefined));
    assert.deepEqual(
      findings.map((f) => f.level),
      ["warning", "info"],
    );
    assert.match(findings[0].message, /画像「変わる絵」の元のファイル.*変わっています/);
    assert.match(findings[1].message, /画像「消える絵」の元のファイル.*見つかりません/);
  });
});
