import type { FontChoice, Settings } from "../document/settings.js";
import { fontKey } from "../document/styles.js";
import type { EpubFile, EpubFont } from "./epub.js";
import { embedRestriction } from "../fonts/sfnt.js";
import { subsetFont } from "./subset-font.js";

// EPUB に埋め込む書体を作る。本文の書体・スタイルで選んだ書体・合成フォント（かな・欧文）を、
// EPUB の中で使った字だけに絞る。合成フォントは、その字の範囲だけに当てる（組版と同じ使い分け）。

/** 合成フォントの字の範囲（組版の KANA・LATIN と同じ）。 */
const KANA_RANGE = "U+3040-309F, U+30A0-30FF, U+31F0-31FF";
const LATIN_RANGE = "U+0020-007E";

/** EPUB の XHTML に出てくる字（タグを除き、文字参照を戻したもの）。 */
export function usedText(files: EpubFile[]): string {
  const dec = new TextDecoder();
  const chars = new Set<string>();
  for (const f of files) {
    if (!/\.xhtml$/.test(f.name)) continue;
    const text = dec
      .decode(f.data)
      .replace(/<[^>]*>/g, "")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&");
    for (const ch of text) chars.add(ch);
  }
  return [...chars].join("");
}

/**
 * 埋め込む書体を作る。loaded と keys は FontService.loadTable の結果（0 番が本文の書体）。
 * 絞れなかった書体は埋め込まない（その書体の所は読む側の書体になる）。
 */
export function epubFonts(files: EpubFile[], settings: Settings, loaded: { choice: FontChoice; bytes: Uint8Array }[], keys: string[]): EpubFont[] {
  const text = usedText(files);
  // 書体の番号 → 絞った書体（同じ書体は1度だけ絞る）。絞れなかった書体は null。
  const subsets = new Map<number, { data: Uint8Array; mime: EpubFont["mime"]; file: string } | null>();
  const subset = (i: number) => {
    if (!subsets.has(i)) {
      const l = loaded[i];
      // 埋め込みを禁じた書体は入れない（その書体の所は読む側の書体になる。#5）。
      const data = l && !embedRestriction(l.bytes) ? subsetFont(l.bytes, text, l.choice.index ?? 0) : null;
      // CFF（PostScript 系）のフォントは OTTO で始まる。
      const otf = !!data && data[0] === 0x4f && data[1] === 0x54 && data[2] === 0x54 && data[3] === 0x4f;
      subsets.set(i, data ? { data, mime: otf ? "font/otf" : "font/ttf", file: `font${i}.${otf ? "otf" : "ttf"}` } : null);
    }
    return subsets.get(i) ?? null;
  };
  const indexOf = (c: FontChoice | null) => (c ? keys.indexOf(fontKey(c)) : -1);
  const out: EpubFont[] = [];
  // 埋め込む書体を1つ足す。role は使い道（本文・段落スタイル・文字スタイル）、range は当てる字の範囲。
  const push = (i: number, role: EpubFont["role"], index?: number, range?: string) => {
    const s = i >= 0 ? subset(i) : null;
    if (s) out.push({ role, ...(index !== undefined ? { index } : {}), ...s, ...(range ? { range } : {}) });
  };
  push(0, "body");
  // 合成フォント：本文の書体のうち、かな・欧文だけを別の書体に。
  const kana = indexOf(settings.compositeFont.kana);
  const latin = indexOf(settings.compositeFont.latin);
  if (kana > 0) push(kana, "body", undefined, KANA_RANGE);
  if (latin > 0) push(latin, "body", undefined, LATIN_RANGE);
  settings.styles.paragraph.forEach((p, i) => {
    const f = indexOf(p.font);
    if (f > 0) push(f, "ps", i);
  });
  settings.styles.character.forEach((c, i) => {
    const f = indexOf(c.font);
    if (f > 0) push(f, "cs", i);
  });
  // 同じ書体のファイルは1つにまとめる（スタイルで同じ書体を何度使っても、ファイルは1つ）。
  const seen = new Map<string, Uint8Array>();
  for (const f of out) {
    const d = seen.get(f.file);
    if (d) f.data = d;
    else seen.set(f.file, f.data);
  }
  return out;
}
