import type { DocImage } from "./document.js";
import { normalizeSettings, type Settings } from "./settings.js";
import { texToMarkup } from "../engine/tex.js";

// ブック（InDesign のブック機能にあたるもの）。章ごとの文書を1冊にまとめ、通しのページ番号で組む。
// 組むときは、文書をつないで1つの原稿にし、「スタイルの元」の文書の設定で組む。そのため、目次・注・
// ページ番号の参照（ラベル）・柱は本全体で続き、扉・奥付などのページ構成はスタイルの元のものを使う。

export const BOOK_EXTENSION = "kolob";
const FORMAT = "kolophon-book";
/** 前のブックの拡張子（0.16〜0.27 の .kolbook、旧名のころの .tgbook）。読むだけ。 */
export const LEGACY_BOOK_EXTENSIONS = ["kolbook", "tgbook"];
const LEGACY_FORMAT = "tategumi-book";

export interface BookEntry {
  /** 文書のパス（ブックのファイルからの相対パス。区切りは /）。 */
  path: string;
  /** 書き出しに含める。 */
  include: boolean;
}

export interface Book {
  documents: BookEntry[];
  /** スタイルの元にする文書（documents の番号）。 */
  styleSource: number;
  /** 文書の始まり：奇数ページから（改丁）か、次のページから（改ページ）。 */
  startOdd: boolean;
}

export class BookFormatError extends Error {}

export function newBook(): Book {
  return { documents: [], styleSource: 0, startOdd: true };
}

export function serializeBook(book: Book): string {
  return `${JSON.stringify({ format: FORMAT, version: 1, ...book }, null, 2)}\n`;
}

export function parseBook(json: string): Book {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new BookFormatError("ブックのファイルを読めません（壊れているか、ブックではありません）。");
  }
  const d = data as Partial<Book> & { format?: string };
  if (!d || (d.format !== FORMAT && d.format !== LEGACY_FORMAT)) throw new BookFormatError("Kolophon のブックではありません。");
  const documents = (Array.isArray(d.documents) ? d.documents : [])
    .filter((e): e is BookEntry => !!e && typeof (e as BookEntry).path === "string")
    .map((e) => ({ path: e.path, include: e.include !== false }));
  const styleSource = typeof d.styleSource === "number" && d.styleSource >= 0 && d.styleSource < documents.length ? d.styleSource : 0;
  return { documents, styleSource, startOdd: d.startOdd !== false };
}

/** ブックに入れる文書の中身（読み込んだもの）。 */
export interface BookDocument {
  /** 表示用の名前（ファイル名）。 */
  name: string;
  text: string;
  /** .kolo（前の .kolophon・.tategumi）なら設定がある（.txt・.tex はない）。 */
  settings?: Settings;
  images: DocImage[];
  /** TeX の記法か（.tex、または設定の記法が TeX）。 */
  tex: boolean;
}

/** つないだ原稿の中で、文書の始まりに付けるラベル。 */
export const docLabel = (i: number) => `kolophon-book-${i}`;

export interface CombinedBook {
  text: string;
  settings: Settings;
  images: DocImage[];
  /** 含めた文書の、もとの番号（docLabel の番号）。 */
  included: number[];
  /** 名前が重なったので付け替えた画像（文書の名前と、元の名前 → 新しい名前）。 */
  renamed: { doc: string; from: string; to: string }[];
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * 文書をつないで1つの原稿にする。文書の間は改丁（または改ページ）。文書の頭に、ページを調べるためのラベルを付ける。
 * TeX の文書は Kolophon の記法にしてからつなぐ。画像は1つにまとめ、名前が重なれば「文書名_名前」に付け替える。
 */
export function combineBook(book: Book, docs: (BookDocument | undefined)[]): CombinedBook {
  const source = docs[book.styleSource] ?? docs.find((d) => d?.settings);
  const settings = normalizeSettings(structuredClone(source?.settings ?? {}));
  // つないだ原稿は Kolophon の記法で書く。
  settings.format.markup = "standard";
  const parts: string[] = [];
  const images: DocImage[] = [];
  const renamed: CombinedBook["renamed"] = [];
  const included: number[] = [];
  book.documents.forEach((entry, i) => {
    const doc = docs[i];
    if (!entry.include || !doc) return;
    let text = doc.tex ? texToMarkup(doc.text).text : doc.text;
    for (const img of doc.images) {
      if (!images.some((x) => x.name === img.name)) {
        images.push(img);
        continue;
      }
      // 名前が重なった画像は付け替え、その文書の［＃画像：名前…］も書き換える。
      const base = `${doc.name.replace(/\.[^.]+$/, "")}_${img.name}`;
      let to = base;
      for (let n = 2; images.some((x) => x.name === to); n++) to = `${base}${n}`;
      images.push({ ...img, name: to });
      renamed.push({ doc: doc.name, from: img.name, to });
      text = text.replace(new RegExp(`(［＃画像[：:]\\s*)${escape(img.name)}(?=[\\s　］])`, "gu"), `$1${to}`);
    }
    // 奇数ページから始めるなら最初の文書も（扉・目次などのページのあと）。次のページからなら文書の間だけ改ページ。
    if (book.startOdd) parts.push("［＃改丁］");
    else if (parts.length > 0) parts.push("［＃改ページ］");
    parts.push(`［＃ラベル：${docLabel(i)}］`, text);
    included.push(i);
  });
  return { text: parts.join("\n"), settings, images, included, renamed };
}

/** ブックのファイルの場所から見た、文書の相対パス（区切りは /）。 */
export function relativeDocPath(bookDir: string, docPath: string, rel: (from: string, to: string) => string): string {
  return rel(bookDir, docPath).replace(/\\/g, "/");
}
