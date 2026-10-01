import { DEFAULT_SETTINGS, normalizeSettings, type Settings } from "./settings.js";

// 文書ファイル（.tategumi）。中身は JSON で、形式の版番号を持つ（NF-07）。

export const FILE_EXTENSION = "tategumi";
export const FORMAT_ID = "tategumi-document";
export const FORMAT_VERSION = 1;

/** 文書に入れた画像（DTP-12・17）。中身は Base64 で文書ファイルに入れる。 */
export interface DocImage {
  /** ［＃画像：名前］で使う名前。 */
  name: string;
  mime: "image/png" | "image/jpeg";
  /** 画像ファイルの中身（Base64）。 */
  data: string;
  /** ピクセル数（組版で縦横比を決めるのに使う）。 */
  width: number;
  height: number;
}

export interface TategumiDocument {
  text: string;
  settings: Settings;
  images: DocImage[];
}

/** 画像の名前に使えない文字（記法の区切りと空白）。 */
export const INVALID_IMAGE_NAME = /[［］＃／：:\s]/u;

function normalizeImages(v: unknown): DocImage[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  return v.filter((i): i is DocImage => {
    const ok =
      !!i &&
      typeof i.name === "string" &&
      i.name !== "" &&
      !INVALID_IMAGE_NAME.test(i.name) &&
      !seen.has(i.name) &&
      (i.mime === "image/png" || i.mime === "image/jpeg") &&
      typeof i.data === "string" &&
      Number.isFinite(i.width) &&
      Number.isFinite(i.height) &&
      i.width > 0 &&
      i.height > 0;
    if (ok) seen.add(i.name);
    return ok;
  });
}

/** 組版に渡す画像の大きさ（名前で引く）。 */
export function imageInfos(images: DocImage[]): Record<string, { width: number; height: number }> {
  return Object.fromEntries(images.map((i) => [i.name, { width: i.width, height: i.height }]));
}

export function newDocument(text = ""): TategumiDocument {
  return { text, settings: structuredClone(DEFAULT_SETTINGS), images: [] };
}

export function serializeDocument(doc: TategumiDocument): string {
  return JSON.stringify({ format: FORMAT_ID, version: FORMAT_VERSION, text: doc.text, settings: doc.settings, images: doc.images }, null, 2);
}

export class DocumentFormatError extends Error {}

export function parseDocument(json: string): TategumiDocument {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new DocumentFormatError("文書ファイルを読めません（JSON として壊れています）。");
  }
  const d = data as { format?: unknown; version?: unknown; text?: unknown; settings?: unknown; images?: unknown };
  if (d?.format !== FORMAT_ID) throw new DocumentFormatError("tategumi の文書ファイルではありません。");
  if (typeof d.version !== "number" || d.version > FORMAT_VERSION) {
    throw new DocumentFormatError("新しい版の tategumi で作られた文書です。tategumi を更新してください。");
  }
  if (typeof d.text !== "string") throw new DocumentFormatError("文書ファイルに本文がありません。");
  return { text: d.text, settings: normalizeSettings(d.settings), images: normalizeImages(d.images) };
}
