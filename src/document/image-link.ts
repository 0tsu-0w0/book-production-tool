import fs from "node:fs";
import path from "node:path";
import type { DocImage, ImageLink } from "./document.js";

// 画像のリンク（#9）。文書の画像は中身を文書の中に持つが、取り込んだ元のファイルの場所・更新日時・大きさも覚えておき、
// 元のファイルが変わった・なくなったことを知らせる（InDesign のリンクパネルのように）。本体（main）で使う。

/** リンクの状態：元のファイルと同じ・元のファイルが変わった・見つからない。 */
export type LinkState = "ok" | "modified" | "missing";

export interface LinkStatus {
  state: LinkState;
  /** 見つけたファイルの場所（元の場所になく、文書からの相対の場所で見つけたときは、そちら）。 */
  path?: string;
  /** 文書のフォルダからの相対の場所（文書が保存してあり、ファイルが見つかったとき）。 */
  relative?: string;
}

/** 画像のファイルの中身から、種類とピクセル数を読む（PNG・JPEG だけ）。 */
export function imageInfo(data: Uint8Array): { mime: DocImage["mime"]; width: number; height: number } | undefined {
  const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { mime: "image/png", width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let p = 2;
    while (p + 9 < b.length) {
      if (b[p] !== 0xff) {
        p++;
        continue;
      }
      const marker = b[p + 1];
      const len = b.readUInt16BE(p + 2);
      // SOF（大きさの書いてある所）。DHT（C4）・JPG（C8）・DAC（CC）は除く。
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { mime: "image/jpeg", height: b.readUInt16BE(p + 5), width: b.readUInt16BE(p + 7) };
      p += 2 + len;
    }
  }
  return undefined;
}

/** そのファイルのリンク（場所・更新日時・大きさ）。docPath があれば、文書のフォルダからの相対の場所も。 */
export function linkOf(file: string, docPath?: string | null): ImageLink {
  const st = fs.statSync(file);
  const abs = path.resolve(file);
  return { path: abs, modified: Math.round(st.mtimeMs), size: st.size, ...(docPath ? { relative: relativeTo(docPath, abs) } : {}) };
}

/** リンクに、文書のフォルダからの相対の場所を付け直す。 */
export function withRelative(link: ImageLink, docPath: string): ImageLink {
  const { relative: _old, ...rest } = link;
  const relative = relativeTo(docPath, path.resolve(link.path));
  return relative ? { ...rest, relative } : rest;
}

/** 文書のフォルダからの相対の場所（区切りは / にそろえる。ドライブが違えば付けない）。 */
function relativeTo(docPath: string, abs: string): string | undefined {
  const rel = path.relative(path.dirname(path.resolve(docPath)), abs);
  if (!rel || path.isAbsolute(rel)) return undefined;
  return rel.split(path.sep).join("/");
}

/**
 * リンクの状態を調べる。元の場所になければ、文書のフォルダからの相対の場所を探す
 * （文書と画像をフォルダごと別の PC に移したとき）。更新日時か大きさが違えば「変わった」。
 */
export function linkStatus(link: ImageLink, docPath?: string | null): LinkStatus {
  const candidates = [link.path];
  if (docPath && link.relative) candidates.push(path.resolve(path.dirname(path.resolve(docPath)), ...link.relative.split("/")));
  for (const file of candidates) {
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    const same = Math.round(st.mtimeMs) === link.modified && st.size === link.size;
    return { state: same ? "ok" : "modified", path: path.resolve(file), ...(docPath ? { relative: relativeTo(docPath, path.resolve(file)) } : {}) };
  }
  return { state: "missing" };
}

/** リンクのファイルを読む（PNG・JPEG だけ）。読めなければ理由。 */
export function readLinkedImage(file: string, docPath?: string | null): { mime: DocImage["mime"]; data: string; link: ImageLink } | { error: string } {
  let data: Uint8Array;
  try {
    data = new Uint8Array(fs.readFileSync(file));
  } catch {
    return { error: `「${file}」が見つかりません。` };
  }
  if (data.byteLength > 30 * 1024 * 1024) return { error: `「${path.basename(file)}」は大きすぎます（30MB まで）。` };
  const info = imageInfo(data);
  if (!info) return { error: `「${path.basename(file)}」は PNG・JPEG ではありません。` };
  return { mime: info.mime, data: Buffer.from(data).toString("base64"), link: linkOf(file, docPath) };
}

/** 書き出すときのファイル名の元：リンクがあれば元のファイル名（拡張子を除く）、なければ画像の名前。 */
export function linkBaseName(img: DocImage): string {
  return img.link ? path.basename(img.link.path.replace(/\\/g, "/")).replace(/\.[^.]+$/, "") || img.name : img.name;
}
