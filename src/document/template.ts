import { DocumentFormatError } from "./document.js";
import { DEFAULT_SETTINGS, normalizeSettings, type Settings } from "./settings.js";

// テンプレート（DTP-17）：原稿を除いた設定一式（判型・版面・スタイル・柱・ページ構成・書き出し）。
// 別の本に使い回すため、書名と著者名は保存しない。発行者・印刷所などはそのまま残す。

export const TEMPLATE_EXTENSION = "kolo-template";
export const TEMPLATE_FORMAT_ID = "kolophon-template";
/** 前のテンプレートの拡張子（読むだけ）。 */
export const LEGACY_TEMPLATE_EXTENSIONS = ["kolophon-template", "tategumi-template"];
/** 旧名（tategumi）のころのテンプレートの形式。読むだけ。 */
const LEGACY_TEMPLATE_FORMAT_ID = "tategumi-template";
export const TEMPLATE_FORMAT_VERSION = 1;

export interface Template {
  name: string;
  settings: Settings;
}

/** テンプレートに残す設定（書名・著者名は空にする）。 */
export function templateSettings(s: Settings): Settings {
  const out = structuredClone(s);
  out.bookInfo.title = "";
  out.bookInfo.author = "";
  out.master.bookTitle = "";
  return out;
}

export function serializeTemplate(t: Template): string {
  return JSON.stringify(
    { format: TEMPLATE_FORMAT_ID, version: TEMPLATE_FORMAT_VERSION, name: t.name, settings: templateSettings(t.settings) },
    null,
    2,
  );
}

export function parseTemplate(json: string): Template {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new DocumentFormatError("テンプレートを読めません（JSON として壊れています）。");
  }
  const d = data as { format?: unknown; version?: unknown; name?: unknown; settings?: unknown };
  if (d?.format !== TEMPLATE_FORMAT_ID && d?.format !== LEGACY_TEMPLATE_FORMAT_ID) throw new DocumentFormatError("Kolophon のテンプレートではありません。");
  if (typeof d.version !== "number" || d.version > TEMPLATE_FORMAT_VERSION) {
    throw new DocumentFormatError("新しい版の Kolophon で作られたテンプレートです。Kolophon を更新してください。");
  }
  return { name: typeof d.name === "string" && d.name ? d.name : "名前のないテンプレート", settings: normalizeSettings(d.settings) };
}

/** 今の文書にテンプレートを当てる。書名・著者名（と柱の書名）は今の文書のものを残す。 */
export function applyTemplate(current: Settings, template: Settings): Settings {
  const out = normalizeSettings(structuredClone(template));
  out.bookInfo.title = current.bookInfo.title;
  out.bookInfo.author = current.bookInfo.author;
  out.master.bookTitle = current.master.bookTitle;
  return out;
}

/** テンプレートの名前をファイル名にする（ファイル名に使えない文字を除く）。 */
export function templateFileName(name: string): string {
  const safe = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/^\.+/, "").trim().slice(0, 80) || "テンプレート";
  return `${safe}.${TEMPLATE_EXTENSION}`;
}

// ---- 最初から入っているテンプレート ----

const bookBase = (): Settings => {
  const s = structuredClone(DEFAULT_SETTINGS);
  s.layoutMode = "book";
  s.chapterStartsOdd = true;
  s.typography = { mode: "jis", lineHeadBracket: "full", lineEndPunct: "full", oikomi: true, rubyOverhang: true };
  s.pages = { front: [{ kind: "title", text: "" }, { kind: "blank", text: "" }], back: [{ kind: "colophon", text: "" }], padTo: 1 };
  return s;
};

function builtin(name: string, edit: (s: Settings) => void): Template {
  const s = bookBase();
  edit(s);
  return { name, settings: s };
}

export const BUILTIN_TEMPLATES: Template[] = [
  builtin("文庫の小説（38字×15行）", () => {}),
  builtin("新書（42字×15行）", (s) => {
    Object.assign(s.book, { trim: "新書", widthMm: 103, heightMm: 182, fontSizePt: 9, charsPerLine: 42, linesPerPage: 15, lineGapPercent: 170, topMm: 18, gutterMm: 12 });
  }),
  builtin("四六判の単行本（42字×17行）", (s) => {
    Object.assign(s.book, { trim: "四六判", widthMm: 127, heightMm: 188, fontSizePt: 9.25, charsPerLine: 42, linesPerPage: 17, lineGapPercent: 175, topMm: 25, gutterMm: 16 });
  }),
  builtin("A5 二段組の同人誌（26字×20行×2段）", (s) => {
    Object.assign(s.book, {
      trim: "A5",
      widthMm: 148,
      heightMm: 210,
      fontSizePt: 9,
      charsPerLine: 26,
      linesPerPage: 20,
      lineGapPercent: 175,
      columns: 2,
      columnGapChars: 2,
      topMm: 20,
      gutterMm: 20,
    });
    // 同人誌の入稿は4の倍数のページ数が多い。
    s.pages.padTo = 4;
  }),
  builtin("A5 横組みの本（35字×28行）", (s) => {
    Object.assign(s.book, {
      trim: "A5",
      widthMm: 148,
      heightMm: 210,
      fontSizePt: 9,
      charsPerLine: 35,
      linesPerPage: 28,
      lineGapPercent: 170,
      writingMode: "horizontal",
      punctuation: "、。",
      topMm: 25,
      gutterMm: 20,
    });
  }),
];
