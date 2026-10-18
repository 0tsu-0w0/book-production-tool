import { DEFAULT_SETTINGS, normalizeSettings, type Settings } from "./settings.js";

// 文書ファイル（.kolo）。中身は JSON で、形式の版番号を持つ（NF-07）。
// 旧名（tategumi）のころの文書（.tategumi・形式 tategumi-document）もそのまま読める。

export const FILE_EXTENSION = "kolo";
export const FORMAT_ID = "kolophon-document";
/** 前の拡張子（0.16〜0.27 の .kolophon、旧名のころの .tategumi）。読むだけ。 */
export const LEGACY_EXTENSIONS = ["kolophon", "tategumi"];
const LEGACY_FORMAT_ID = "tategumi-document";
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
  /** 取り込んだ元のファイル（リンク）。元のファイルが変わった・なくなったことを知らせるのに使う。なければ文書の中だけの画像。 */
  link?: ImageLink;
}

/** 画像のリンク：元のファイルの場所と、取り込んだときの更新日時・大きさ。 */
export interface ImageLink {
  /** 元のファイルの場所（絶対パス）。 */
  path: string;
  /** 文書のフォルダからの相対の場所（/ 区切り）。文書と画像をフォルダごと移しても見つけられるように。 */
  relative?: string;
  /** 取り込んだときの更新日時（ミリ秒）と大きさ（バイト）。 */
  modified: number;
  size: number;
}

/** リンクを読む（形が違えば、リンクなしにする）。 */
function linkOf(v: unknown): ImageLink | undefined {
  const l = (v && typeof v === "object" ? v : undefined) as Record<string, unknown> | undefined;
  if (!l || typeof l.path !== "string" || !l.path || !Number.isFinite(l.modified) || !Number.isFinite(l.size)) return undefined;
  return { path: l.path, ...(typeof l.relative === "string" && l.relative ? { relative: l.relative } : {}), modified: Number(l.modified), size: Number(l.size) };
}

export interface KolophonDocument {
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
  }).map((i) => {
    const { link, ...rest } = i;
    const l = linkOf(link);
    return l ? { ...rest, link: l } : rest;
  });
}

/** 組版に渡す画像の大きさ（名前で引く）。 */
export function imageInfos(images: DocImage[]): Record<string, { width: number; height: number }> {
  return Object.fromEntries(images.map((i) => [i.name, { width: i.width, height: i.height }]));
}

export function newDocument(text = ""): KolophonDocument {
  return { text, settings: structuredClone(DEFAULT_SETTINGS), images: [] };
}

export function serializeDocument(doc: KolophonDocument): string {
  return JSON.stringify({ format: FORMAT_ID, version: FORMAT_VERSION, text: doc.text, settings: doc.settings, images: doc.images }, null, 2);
}

export class DocumentFormatError extends Error {}

export function parseDocument(json: string): KolophonDocument {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new DocumentFormatError("文書ファイルを読めません（JSON として壊れています）。");
  }
  const d = data as { format?: unknown; version?: unknown; text?: unknown; settings?: unknown; images?: unknown };
  if (d?.format !== FORMAT_ID && d?.format !== LEGACY_FORMAT_ID) throw new DocumentFormatError("Kolophon の文書ファイルではありません。");
  if (typeof d.version !== "number" || d.version > FORMAT_VERSION) {
    throw new DocumentFormatError("新しい版の Kolophon で作られた文書です。Kolophon を更新してください。");
  }
  if (typeof d.text !== "string") throw new DocumentFormatError("文書ファイルに本文がありません。");
  return { text: d.text, settings: normalizeSettings(d.settings), images: normalizeImages(d.images) };
}
