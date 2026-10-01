import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FontChoice } from "../document/settings.js";
import { extractFace, faceOffsets, normalizeGlyf, readFaceInfo, type FaceInfo, type ReadAt } from "./sfnt.js";

// PC に入っているフォントのうち、縦書きに使える日本語フォントの一覧を作る（Windows / Mac）。

export interface FontEntry extends FontChoice {
  family: string;
  style: string;
  cff: boolean;
}

export function fontDirectories(): string[] {
  const home = os.homedir();
  if (process.platform === "win32") {
    const windir = process.env.WINDIR ?? "C:\\Windows";
    return [path.join(windir, "Fonts"), path.join(process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "Microsoft", "Windows", "Fonts")];
  }
  if (process.platform === "darwin") {
    return ["/System/Library/Fonts", "/System/Library/Fonts/Supplemental", "/Library/Fonts", path.join(home, "Library", "Fonts")];
  }
  return ["/usr/share/fonts", "/usr/local/share/fonts", path.join(home, ".local", "share", "fonts"), path.join(home, ".fonts")];
}

const FONT_FILE = /\.(ttf|otf|ttc|otc)$/i;

function listFiles(dir: string, depth = 0): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth < 3) return listFiles(p, depth + 1);
    return e.isFile() && FONT_FILE.test(e.name) ? [p] : [];
  });
}

/** 1つのファイルの中のフォントを調べる。読めないファイルは空の一覧を返す。 */
export function inspectFontFile(file: string): FaceInfo[] {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const read: ReadAt = (offset, length) => {
      if (offset < 0 || offset + length > size) throw new RangeError("ファイルの外を読もうとしました。");
      const buf = Buffer.alloc(length);
      fs.readSync(fd!, buf, 0, length, offset);
      return buf;
    };
    return faceOffsets(read).map((o, i) => readFaceInfo(read, o, i));
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** 縦書きに使える日本語フォントの一覧。可変フォントと埋め込み禁止のフォントは除く。 */
export function scanFonts(dirs = fontDirectories()): FontEntry[] {
  const seen = new Set<string>();
  const out: FontEntry[] = [];
  for (const file of dirs.flatMap((d) => listFiles(d))) {
    for (const info of inspectFontFile(file)) {
      if (!info.japanese || !info.vertical || !info.embeddable || info.variable || !info.postscriptName) continue;
      if (seen.has(info.postscriptName)) continue;
      seen.add(info.postscriptName);
      const style = info.subfamilyName && !/^(Regular|標準|R)$/i.test(info.subfamilyName) ? info.subfamilyName : "";
      out.push({
        name: style ? `${info.familyName} ${style}` : info.familyName,
        family: info.familyName,
        style,
        postscriptName: info.postscriptName,
        path: file,
        index: info.index,
        cff: info.cff,
      });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, "ja"));
}

/**
 * 選んだフォントのバイト列を読む。.ttc なら中の1つを取り出し、
 * PDF に埋め込めるよう字形データの境界をそろえる（normalizeGlyf）。
 */
export function loadFontBytes(choice: Pick<FontChoice, "path" | "index">): Uint8Array {
  return normalizeGlyf(extractFace(fs.readFileSync(choice.path), choice.index));
}
