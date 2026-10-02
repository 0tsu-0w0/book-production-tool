import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BOOK_EXTENSION, LEGACY_BOOK_EXTENSIONS, parseBook, serializeBook, newBook } from "../document/book.js";
import { FILE_EXTENSION, FORMAT_ID, LEGACY_EXTENSIONS, newDocument, parseDocument, serializeDocument } from "../document/document.js";
import { LEGACY_TEMPLATE_EXTENSIONS, TEMPLATE_EXTENSION, parseTemplate, serializeTemplate } from "../document/template.js";
import { DEFAULT_SETTINGS } from "../document/settings.js";

describe("名前の変更（tategumi → Kolophon）", () => {
  it("新しく保存する文書・ブック・テンプレートは Kolophon の形式", () => {
    assert.equal(FORMAT_ID, "kolophon-document");
    assert.match(serializeDocument(newDocument("本文")), /"format":\s*"kolophon-document"/);
    assert.match(serializeBook(newBook()), /"format": "kolophon-book"/);
    assert.match(serializeTemplate({ name: "t", settings: DEFAULT_SETTINGS }), /"format": "kolophon-template"/);
  });

  it("旧名（tategumi）のころの文書・ブック・テンプレートも読める", () => {
    const doc = parseDocument(JSON.stringify({ format: "tategumi-document", version: 1, text: "昔の本文" }));
    assert.equal(doc.text, "昔の本文");
    const book = parseBook(JSON.stringify({ format: "tategumi-book", version: 1, documents: [{ path: "ch1.tategumi" }] }));
    assert.equal(book.documents[0].path, "ch1.tategumi");
    const t = parseTemplate(JSON.stringify({ format: "tategumi-template", version: 1, name: "昔のテンプレート" }));
    assert.equal(t.name, "昔のテンプレート");
  });

  it("拡張子は .kolo・.kolob・.kolo-template。前の .kolophon・.kolbook・.kolophon-template も読む", () => {
    assert.equal(FILE_EXTENSION, "kolo");
    assert.equal(BOOK_EXTENSION, "kolob");
    assert.equal(TEMPLATE_EXTENSION, "kolo-template");
    assert.deepEqual(LEGACY_EXTENSIONS, ["kolophon", "tategumi"]);
    assert.deepEqual(LEGACY_BOOK_EXTENSIONS, ["kolbook", "tgbook"]);
    assert.ok(LEGACY_TEMPLATE_EXTENSIONS.includes("kolophon-template"));
  });
});
