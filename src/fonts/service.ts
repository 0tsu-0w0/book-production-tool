import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FontChoice } from "../document/settings.js";
import { fontKey, requiredFonts, type StyleSheet } from "../document/styles.js";
import { Face } from "../engine/face.js";
import type { FontTable } from "../engine/index.js";
import { loadFontBytes, scanFonts, type FontEntry } from "./catalog.js";

// 使うフォントを決めて読み込む。同じフォントは一度だけ読む。

export interface LoadedFont {
  choice: FontChoice;
  bytes: Uint8Array;
  face: Face;
  /** 文書で指定されたフォントが見つからず、代わりのフォントを使ったときの説明。 */
  warning?: string;
}

/** アプリに同梱しているフォントの置き場所（dist/fonts から見て ../../assets/fonts）。 */
export const BUNDLED_FONT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "assets", "fonts");

/** 同梱フォント。既定の本文フォントで、どの PC でも同じ組版になる（NF-05）。 */
export const BUNDLED_FONTS: FontEntry[] = [
  {
    name: "Noto Serif JP（同梱）",
    family: "Noto Serif JP",
    style: "",
    postscriptName: "NotoSerifJP-Regular",
    path: path.join(BUNDLED_FONT_DIR, "NotoSerifJP-Regular.ttf"),
    index: 0,
    cff: false,
  },
];

export class FontService {
  private catalog: FontEntry[] | undefined;
  private readonly cache = new Map<string, LoadedFont>();

  /** 同梱フォントを先頭に、PC に入っている縦書き用の日本語フォントを続けた一覧。 */
  list(): FontEntry[] {
    if (!this.catalog) {
      const bundled = BUNDLED_FONTS.filter((f) => fs.existsSync(f.path));
      const bundledNames = new Set(bundled.map((f) => f.postscriptName));
      this.catalog = [...bundled, ...scanFonts().filter((f) => !bundledNames.has(f.postscriptName))];
    }
    return this.catalog;
  }

  /**
   * 既定のフォント（文書でフォントを選んでいないときに使う）。同梱の Noto Serif JP。
   * 環境変数 TATEGUMI_FONT（.ttf / .otf のパス）があれば、そちらを優先する。
   */
  defaultChoice(): FontChoice {
    const env = process.env.TATEGUMI_FONT;
    if (env && fs.existsSync(env)) return { name: env, postscriptName: "", path: env, index: 0 };
    const found = this.list().find((f) => !f.cff);
    if (!found) throw new Error("縦書きに使える日本語フォント（TrueType）が見つかりません。");
    return { name: found.name, postscriptName: found.postscriptName, path: found.path, index: found.index };
  }

  load(choice: FontChoice | null): LoadedFont {
    let warning: string | undefined;
    let target = choice ?? this.defaultChoice();
    if (choice && !fs.existsSync(choice.path)) {
      // 別の PC で作った文書など。フォントがなければ既定のフォントで組み、そのことを知らせる。
      const byName = this.list().find((f) => f.postscriptName === choice.postscriptName);
      target = byName ?? this.defaultChoice();
      if (!byName) warning = `フォント「${choice.name}」が見つからないため、「${target.name}」で組んでいます。`;
    }
    const key = `${target.path}#${target.index}`;
    let loaded = this.cache.get(key);
    if (!loaded) {
      const bytes = loadFontBytes(target);
      loaded = { choice: target, bytes, face: new Face(bytes) };
      this.cache.set(key, loaded);
    }
    return warning ? { ...loaded, warning } : loaded;
  }

  /**
   * 文書で使うフォントをまとめて読む。先頭が本文の書体、続いてスタイルで指定した書体。
   * keys には、スタイルが指定したフォントのキーを入れる（見つからず代わりのフォントになっても、指定の側で引けるように）。
   */
  loadTable(body: FontChoice | null, styles: StyleSheet): { table: FontTable; loaded: LoadedFont[]; warnings: string[] } {
    const choices = requiredFonts(body, styles);
    const loaded = choices.map((c) => this.load(c));
    const keys = choices.map((c, i) => (i === 0 || !c ? fontKey(loaded[i].choice) : fontKey(c)));
    const warnings = [...new Set(loaded.flatMap((l) => (l.warning ? [l.warning] : [])))];
    return { table: { faces: loaded.map((l) => l.face), keys }, loaded, warnings };
  }
}
