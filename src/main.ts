import { BrowserWindow, Menu, app, dialog, ipcMain, shell, type MenuItemConstructorOptions } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { DocumentFormatError, FILE_EXTENSION, imageInfos, parseDocument, serializeDocument, type DocImage, type TategumiDocument } from "./document/document.js";
import type { Settings } from "./document/settings.js";
import { BUILTIN_TEMPLATES, TEMPLATE_EXTENSION, parseTemplate, serializeTemplate, templateFileName } from "./document/template.js";
import { glyphPaths, typesetLazy, type FontTable, type ImageInfo, type LazyTypesetResult } from "./engine/index.js";
import { FontService } from "./fonts/service.js";
import { preflight } from "./output/preflight.js";
import { BOOK_EXTENSION, BookFormatError, combineBook, docLabel, newBook, parseBook, serializeBook, type Book, type BookDocument } from "./document/book.js";
import { typesetCover } from "./engine/cover.js";
import { checkPdfX } from "./output/check-pdfx.js";
import { pdfOptions } from "./output/export-pdf.js";
import { renderPdf } from "./output/pdf.js";
import { IccError, findCmykProfiles, iccProblem, readIcc } from "./output/icc.js";
import { checkLines, findVariants } from "./engine/proof.js";
import { texToMarkup } from "./engine/tex.js";
import { ZipWriter } from "./output/zip.js";
import type { PdfWorkerInput, PdfWorkerMessage } from "./pdf-worker.js";
import { SAMPLE_TEXT } from "./sample.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
// PC のフォントを調べた結果は控えておき、次の起動では変わったファイルだけを調べる。
const fonts = new FontService({ cacheFile: path.join(app.getPath("userData"), "font-cache.json") });

// 確認用：--snapshot=<フォルダ> で起動すると、先頭のページを PNG に書き出して終了する。--doc=<文書> でその文書を開く。
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const snapshotDir = arg("snapshot");
/** 文書をダブルクリックして起動したとき（Windows）は、コマンドラインにそのパスが来る。 */
function fileFromArgv(argv: string[]): string | undefined {
  return argv.slice(1).find((a) => !a.startsWith("-") && /\.(tategumi|txt|tex|tgbook)$/i.test(a) && fs.existsSync(a));
}
let startupDoc = arg("doc") ?? fileFromArgv(process.argv);
// 確認用：ダイアログを出さずに、指定した場所へ書き出す（--snapshot と一緒に使う）。
const autoPdf = snapshotDir ? arg("export-pdf") : undefined;
const autoImages = snapshotDir ? arg("export-images") : undefined;
// 確認用：--bench を付けると、原稿の途中を何度か書き換えて組み直しの時間を測り、標準出力に書く。
const bench = !!snapshotDir && process.argv.includes("--bench");

let win: BrowserWindow | undefined;
let dirty = false;
let currentPath: string | null = null;
let forceClose = false;

const recoveryFile = () => path.join(app.getPath("userData"), "recovery.json");

function updateTitle() {
  const name = currentPath ? path.basename(currentPath) : "無題";
  win?.setTitle(`${name}${dirty ? " *" : ""} — tategumi`);
}

function send(channel: string, ...args: unknown[]) {
  win?.webContents.send(channel, ...args);
}

/** テキストファイルを読む。UTF-8 として読めなければ Shift_JIS とみなす。 */
function readTextFile(file: string): string {
  const bytes = fs.readFileSync(file);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/, "");
  } catch {
    return new TextDecoder("shift_jis").decode(bytes);
  }
}

/** 文書（.tategumi）かテキスト（.txt）を開く。テキストは本文だけを返し、設定は今のものを使う。 */
function openFile(file: string): { text: string; settings?: Settings; images?: DocImage[]; filePath: string | null; tex?: { title?: string; author?: string } } {
  if (file.toLowerCase().endsWith(".txt")) return { text: readTextFile(file), filePath: null };
  if (file.toLowerCase().endsWith(".tex")) {
    // TeX の原稿：記法を TeX にし、プリアンブルの書名・著者名を書誌に使う。
    const text = readTextFile(file);
    const { title, author } = texToMarkup(text);
    return { text, filePath: null, tex: { title, author } };
  }
  const doc = parseDocument(fs.readFileSync(file, "utf8"));
  return { text: doc.text, settings: doc.settings, images: doc.images, filePath: file };
}

const isBookFile = (file: string) => file.toLowerCase().endsWith(`.${BOOK_EXTENSION}`);

function openSafely(file: string) {
  try {
    return openFile(file);
  } catch (e) {
    return { error: e instanceof DocumentFormatError ? e.message : `ファイルを開けませんでした：${String(e)}` };
  }
}

/** 起動したあとに開くよう頼まれた文書（2つめの起動・Mac の open-file）を画面に渡す。 */
function requestOpen(file: string) {
  if (!win) {
    startupDoc = file;
    return;
  }
  if (win.isMinimized()) win.restore();
  win.focus();
  send("open-path", file);
}

ipcMain.handle("doc:open-path", (_e, file: string) => openSafely(file));

ipcMain.handle("init", () => {
  let recovery: { doc: TategumiDocument; filePath: string | null; savedAt: string } | undefined;
  try {
    const data = JSON.parse(fs.readFileSync(recoveryFile(), "utf8"));
    recovery = { doc: parseDocument(data.document), filePath: data.filePath ?? null, savedAt: data.savedAt };
  } catch {
    recovery = undefined;
  }
  return {
    sample: SAMPLE_TEXT,
    recovery: snapshotDir ? undefined : recovery,
    // ブックのファイルなら、ブックの画面で開く。
    opened: startupDoc && !isBookFile(startupDoc) ? openSafely(startupDoc) : undefined,
    book: startupDoc && isBookFile(startupDoc) ? startupDoc : undefined,
    snapshot: !!snapshotDir,
    autoExport: !!(autoPdf || autoImages),
    bench,
    /** 確認用：--page=N で、スナップショットを N ページ目から撮る。 */
    startPage: Number(arg("page")) || 1,
  };
});

ipcMain.handle("fonts:list", () => ({ list: fonts.list(), defaultChoice: fonts.defaultChoice() }));

/** 画面にすでに送った字形の輪郭（フォントごと）。同じ輪郭を毎回送り直さないため。 */
const sentPaths = new Map<string, Set<number>>();

/**
 * 最新の組版結果。全ページは本体が持ち、画面には見えているページだけを送る
 * （10万字・約300ページを毎回送ると、それだけで 10MB を超えるため）。
 */
let latest: { version: number; result: LazyTypesetResult; fonts: FontTable } | undefined;
let version = 0;

function pagesPayload(indices: number[]) {
  const { result, fonts: table } = latest!;
  const picked = [...new Set(indices)].filter((i) => i >= 0 && i < result.pageCount).map((i) => result.page(i));
  return { pages: picked, paths: glyphPaths(picked, table, sentPaths) };
}

ipcMain.handle("typeset", (_e, text: string, settings: Settings, reset: boolean, wanted: number[], images: Record<string, ImageInfo> = {}, caret?: [number, number]) => {
  const started = performance.now();
  const { table, loaded, warnings } = fonts.loadTable(settings.font, settings.styles);
  const result = typesetLazy(text, settings, table, images);
  if (reset) sentPaths.clear();
  latest = { version: ++version, result, fonts: table };
  // 紙面で入力しているときは、カーソルのあるページも一緒に送る（DTP-15）。
  const caretPage = caret ? result.pageOf(caret[0], caret[1]) : -1;
  const { pages, paths } = pagesPayload(caretPage >= 0 ? [...wanted, caretPage - 1, caretPage, caretPage + 1].filter((i) => i >= 0 && i < result.pageCount) : wanted);
  return {
    version,
    pageCount: result.pageCount,
    upems: result.upems,
    fontKeys: table.keys,
    missingChars: result.missingChars,
    mathErrors: result.mathErrors,
    lastPageLines: result.lastPageLines,
    linesPerPage: result.linesPerPage,
    charsPerLine: result.charsPerLine,
    columns: result.columns,
    pages,
    paths,
    caretPage,
    font: loaded[0].choice,
    fontWarning: warnings.join(" "),
    /** 本体での組版にかかった時間（計測用）。 */
    engineMs: performance.now() - started,
  };
});

/** 指定したページを送る。組み直しで版が変わっていたら null（画面は新しい版を待つ）。 */
ipcMain.handle("pages", (_e, v: number, indices: number[]) => {
  if (!latest || latest.version !== v) return null;
  return pagesPayload(indices);
});

ipcMain.handle("doc:open", async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win!, {
    filters: [
      { name: "tategumi 文書・テキスト・TeX", extensions: [FILE_EXTENSION, "txt", "tex"] },
      { name: "tategumi 文書", extensions: [FILE_EXTENSION] },
      { name: "テキスト", extensions: ["txt"] },
      { name: "TeX", extensions: ["tex"] },
    ],
    properties: ["openFile"],
  });
  if (canceled || !filePaths[0]) return undefined;
  try {
    return openFile(filePaths[0]);
  } catch (e) {
    return { error: e instanceof DocumentFormatError ? e.message : `ファイルを開けませんでした：${String(e)}` };
  }
});

ipcMain.handle("doc:save", async (_e, doc: TategumiDocument, filePath: string | null, saveAs: boolean) => {
  let target = saveAs ? null : filePath;
  if (!target) {
    const { canceled, filePath: chosen } = await dialog.showSaveDialog(win!, {
      defaultPath: filePath ?? `無題.${FILE_EXTENSION}`,
      filters: [{ name: "tategumi 文書", extensions: [FILE_EXTENSION] }],
    });
    if (canceled || !chosen) return undefined;
    target = chosen;
  }
  // 途中で落ちても元のファイルが壊れないよう、一時ファイルに書いてから置き換える。
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, serializeDocument(doc), "utf8");
  fs.renameSync(tmp, target);
  return target;
});

ipcMain.handle("doc:state", (_e, isDirty: boolean, filePath: string | null) => {
  dirty = isDirty;
  currentPath = filePath;
  updateTitle();
});

ipcMain.handle("recovery:save", (_e, doc: TategumiDocument, filePath: string | null) => {
  const data = { document: serializeDocument(doc), filePath, savedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(recoveryFile()), { recursive: true });
  fs.writeFileSync(recoveryFile(), JSON.stringify(data), "utf8");
});

ipcMain.handle("recovery:clear", () => {
  fs.rmSync(recoveryFile(), { force: true });
});

// ---- テンプレート（DTP-17）。自分のテンプレートは、ユーザーデータの templates フォルダに1つずつファイルで置く。 ----

const templatesDir = () => path.join(app.getPath("userData"), "templates");

/** 新規作成で使うテンプレート（id）を覚えておくファイル。なければ標準の設定で新規作成する。 */
const defaultTemplateFile = () => path.join(app.getPath("userData"), "default-template.json");

function defaultTemplateId(): string | null {
  try {
    const id = JSON.parse(fs.readFileSync(defaultTemplateFile(), "utf8")).id;
    return typeof id === "string" ? id : null;
  } catch {
    return null;
  }
}

/** 新規作成の既定のテンプレート。消されていたり読めなかったりしたら null（標準の設定）。 */
ipcMain.handle("templates:get-default", () => {
  const id = defaultTemplateId();
  if (!id) return null;
  try {
    const t = templateById(id);
    return t ? { id, name: t.name, settings: t.settings } : null;
  } catch {
    return null;
  }
});

/** 新規作成の既定のテンプレートを決める（null なら標準の設定に戻す）。 */
ipcMain.handle("templates:set-default", (_e, id: string | null) => {
  if (id === null) fs.rmSync(defaultTemplateFile(), { force: true });
  else {
    fs.mkdirSync(path.dirname(defaultTemplateFile()), { recursive: true });
    fs.writeFileSync(defaultTemplateFile(), JSON.stringify({ id }), "utf8");
  }
});

/** 一覧：最初から入っているもの（id は builtin:番号）と、自分で保存したもの（id はファイル名）。 */
ipcMain.handle("templates:list", () => {
  const def = defaultTemplateId();
  const list: { id: string; name: string; builtin: boolean; isDefault?: boolean }[] = BUILTIN_TEMPLATES.map((t, i) => ({
    id: `builtin:${i}`,
    name: t.name,
    builtin: true,
    isDefault: def === `builtin:${i}`,
  }));
  let files: string[] = [];
  try {
    files = fs.readdirSync(templatesDir()).filter((f) => f.endsWith(`.${TEMPLATE_EXTENSION}`));
  } catch {
    files = [];
  }
  for (const file of files.sort()) {
    try {
      list.push({ id: file, name: parseTemplate(fs.readFileSync(path.join(templatesDir(), file), "utf8")).name, builtin: false, isDefault: def === file });
    } catch {
      // 読めないファイルは一覧に出さない。
    }
  }
  return list;
});

function templateById(id: string) {
  if (id.startsWith("builtin:")) return BUILTIN_TEMPLATES[Number(id.slice(8))];
  return parseTemplate(fs.readFileSync(path.join(templatesDir(), path.basename(id)), "utf8"));
}

ipcMain.handle("templates:get", (_e, id: string) => {
  try {
    return { settings: templateById(id).settings };
  } catch (e) {
    return { error: e instanceof DocumentFormatError ? e.message : `テンプレートを読めませんでした：${String(e)}` };
  }
});

ipcMain.handle("templates:save", (_e, name: string, settings: Settings) => {
  const file = templateFileName(name);
  const target = path.join(templatesDir(), file);
  if (fs.existsSync(target)) {
    const choice = dialog.showMessageBoxSync(win!, {
      type: "question",
      buttons: ["置き換える", "キャンセル"],
      defaultId: 1,
      cancelId: 1,
      message: `テンプレート「${name}」はもうあります。置き換えますか？`,
    });
    if (choice !== 0) return undefined;
  }
  fs.mkdirSync(templatesDir(), { recursive: true });
  fs.writeFileSync(target, serializeTemplate({ name, settings }), "utf8");
  return file;
});

ipcMain.handle("templates:delete", (_e, id: string) => {
  if (id.startsWith("builtin:")) return;
  // 既定にしていたテンプレートを消したら、既定は標準の設定に戻す。
  if (defaultTemplateId() === id) fs.rmSync(defaultTemplateFile(), { force: true });
  fs.rmSync(path.join(templatesDir(), path.basename(id)), { force: true });
});

/** ほかの PC で保存したテンプレートのファイルを取り込む。 */
ipcMain.handle("templates:import", async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win!, {
    filters: [{ name: "tategumi テンプレート", extensions: [TEMPLATE_EXTENSION] }],
    properties: ["openFile"],
  });
  if (canceled || !filePaths[0]) return undefined;
  try {
    const t = parseTemplate(fs.readFileSync(filePaths[0], "utf8"));
    fs.mkdirSync(templatesDir(), { recursive: true });
    const file = templateFileName(t.name);
    fs.writeFileSync(path.join(templatesDir(), file), serializeTemplate(t), "utf8");
    return { id: file, name: t.name };
  } catch (e) {
    return { error: e instanceof DocumentFormatError ? e.message : `テンプレートを読めませんでした：${String(e)}` };
  }
});

/** PDF/X-4：印刷条件の ICC プロファイルを読む（入稿用で PDF/X-4 のときだけ）。 */
function readIccFor(settings: Settings): { icc?: Uint8Array } | { error: string } {
  if (settings.pdfKind === "screen" || settings.output.pdfStandard !== "x4") return {};
  if (!settings.output.iccPath) return { error: "PDF/X-4 には、印刷条件の ICC プロファイル（CMYK）が要ります。設定の「書き出し」で選んでください。" };
  try {
    return { icc: fs.readFileSync(settings.output.iccPath) };
  } catch {
    return { error: `ICC プロファイルが見つかりません：${settings.output.iccPath}` };
  }
}

/** 表紙の見本（設定欄に出す）。字形の輪郭は、まだ送っていないものだけ。 */
ipcMain.handle("cover:preview", (_e, settings: Settings, pageCount: number, images: DocImage[] = []) => {
  const { table } = fonts.loadTable(settings.font, settings.styles);
  const r = typesetCover(settings, table, imageInfos(images), pageCount);
  return { page: r.page, paths: glyphPaths([r.page], table, sentPaths), fontKeys: table.keys, upems: table.faces.map((f) => f.upem), spineMm: r.spineMm, widthMm: r.widthMm, heightMm: r.heightMm };
});

/** 表紙を PDF に書き出す（入稿用なら本文と同じ PDF/X・トンボ・塗り足し）。 */
ipcMain.handle("cover:export", async (_e, settings: Settings, pageCount: number, baseName: string, images: DocImage[] = []) => {
  if (snapshotDir && !autoPdf) return undefined;
  const iccRead = readIccFor(settings);
  if ("error" in iccRead) return iccRead;
  const { canceled, filePath } = autoPdf
    ? { canceled: false, filePath: path.resolve(autoPdf.replace(/\.pdf$/i, "") + "_表紙.pdf") }
    : await dialog.showSaveDialog(win!, { defaultPath: `${baseName}_表紙.pdf`, filters: [{ name: "PDF", extensions: ["pdf"] }] });
  if (canceled || !filePath) return undefined;
  try {
    const { loaded, table } = fonts.loadTable(settings.font, settings.styles);
    const r = typesetCover(settings, table, imageInfos(images), pageCount);
    const options = { ...pdfOptions(settings, path.basename(filePath, ".pdf")), icc: iccRead.icc };
    const sources = images.map((i) => ({ name: i.name, mime: i.mime, bytes: Buffer.from(i.data, "base64") }));
    const bytes = await renderPdf([r.page], loaded.map((l) => l.bytes), options, undefined, sources);
    fs.writeFileSync(filePath, bytes);
    const check = options.pdfx ? await checkPdfX(bytes, options.standard ?? "x1a") : undefined;
    return { path: filePath, spineMm: r.spineMm, standard: options.standard, problems: check?.filter((c) => !c.ok).map((c) => c.rule) ?? [] };
  } catch (e) {
    return { error: `表紙を書き出せませんでした：${e instanceof Error ? e.message : String(e)}` };
  }
});

/** PDF/X-4 に使える ICC プロファイル（OS とアプリのフォルダから探す。一度探したら覚えておく）。 */
let iccProfiles: { path: string; name: string }[] | undefined;
ipcMain.handle("icc:list", () => (iccProfiles ??= findCmykProfiles()));

ipcMain.handle("icc:choose", async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win!, {
    title: "印刷条件の ICC プロファイル（CMYK）を選ぶ",
    filters: [{ name: "ICC プロファイル", extensions: ["icc", "icm"] }],
    properties: ["openFile"],
  });
  if (canceled || !filePaths[0]) return undefined;
  try {
    const info = readIcc(fs.readFileSync(filePaths[0]));
    const problem = iccProblem(info);
    if (problem) return { error: problem };
    const entry = { path: filePaths[0], name: info.name || path.basename(filePaths[0]) };
    iccProfiles = [...(iccProfiles ?? []).filter((p) => p.path !== entry.path), entry];
    return entry;
  } catch (e) {
    return { error: e instanceof IccError ? e.message : `読めませんでした：${String(e)}` };
  }
});

ipcMain.handle("templates:open-folder", () => {
  fs.mkdirSync(templatesDir(), { recursive: true });
  void shell.openPath(templatesDir());
});

ipcMain.handle("pdf:export", (_e, text: string, settings: Settings, baseName: string, images: DocImage[] = []) => exportPdfFile(text, settings, baseName, images));

/** PDF を書き出す（保存先を聞いて、別スレッドで組んで書き出し、入稿用なら検査する）。 */
async function exportPdfFile(text: string, settings: Settings, baseName: string, images: DocImage[]) {
  if (snapshotDir && !autoPdf) return undefined;
  const { loaded, table } = fonts.loadTable(settings.font, settings.styles);
  const { canceled, filePath } = autoPdf
    ? { canceled: false, filePath: path.resolve(autoPdf) }
    : await dialog.showSaveDialog(win!, { defaultPath: `${baseName}.pdf`, filters: [{ name: "PDF", extensions: ["pdf"] }] });
  if (canceled || !filePath) return undefined;

  const iccRead = readIccFor(settings);
  if ("error" in iccRead) return iccRead;
  const icc = iccRead.icc;
  const input: PdfWorkerInput = {
    text,
    settings,
    fonts: loaded.map((l, i) => ({ key: table.keys[i], bytes: l.bytes })),
    title: path.basename(filePath, ".pdf"),
    images,
    icc,
  };
  const worker = new Worker(path.join(here, "pdf-worker.js"), { workerData: input });
  return new Promise((resolve) => {
    worker.on("message", (msg: PdfWorkerMessage) => {
      if (msg.type === "progress") send("progress", { label: "PDF", done: msg.done, total: msg.total });
      else if (msg.type === "error") resolve({ error: msg.message });
      else {
        try {
          fs.writeFileSync(filePath, msg.result.bytes);
        } catch (e) {
          resolve({ error: `PDF を保存できませんでした：${e instanceof Error ? e.message : String(e)}` });
          return;
        }
        const problems = msg.result.check?.filter((c) => !c.ok).map((c) => c.rule) ?? [];
        resolve({ path: filePath, pages: msg.result.pages, pdfx: !!msg.result.check, standard: msg.result.standard, problems });
      }
    });
    worker.on("error", (err: Error) => resolve({ error: err.message }));
  });
}

// ---- ブック（InDesign のブック機能にあたるもの） ----

/** ブックの文書を読む。読めなかった文書は undefined にし、理由を errors に入れる。 */
function loadBookDocs(bookPath: string, book: Book): { docs: (BookDocument | undefined)[]; errors: string[] } {
  const dir = path.dirname(bookPath);
  const errors: string[] = [];
  const docs = book.documents.map((entry, i) => {
    const file = path.resolve(dir, entry.path);
    try {
      const opened = openFile(file);
      return {
        name: path.basename(file),
        text: opened.text,
        settings: opened.settings,
        images: opened.images ?? [],
        tex: !!opened.tex || opened.settings?.format.markup === "tex",
      };
    } catch (e) {
      errors[i] = fs.existsSync(file) ? (e instanceof DocumentFormatError ? e.message : `読めません：${String(e)}`) : "ファイルが見つかりません";
      return undefined;
    }
  });
  return { docs, errors };
}

const bookFilters = [{ name: "tategumi ブック", extensions: [BOOK_EXTENSION] }];

ipcMain.handle("book:new", async () => {
  const { canceled, filePath } = await dialog.showSaveDialog(win!, { defaultPath: `新しいブック.${BOOK_EXTENSION}`, filters: bookFilters });
  if (canceled || !filePath) return undefined;
  const book = newBook();
  fs.writeFileSync(filePath, serializeBook(book), "utf8");
  return { path: filePath, book };
});

ipcMain.handle("book:open", async (_e, file?: string) => {
  if (!file) {
    const { canceled, filePaths } = await dialog.showOpenDialog(win!, { filters: bookFilters, properties: ["openFile"] });
    if (canceled || !filePaths[0]) return undefined;
    file = filePaths[0];
  }
  try {
    return { path: file, book: parseBook(fs.readFileSync(file, "utf8")) };
  } catch (e) {
    return { error: e instanceof BookFormatError ? e.message : `ブックを開けませんでした：${String(e)}` };
  }
});

ipcMain.handle("book:save", (_e, bookPath: string, book: Book) => {
  const tmp = `${bookPath}.tmp`;
  fs.writeFileSync(tmp, serializeBook(book), "utf8");
  fs.renameSync(tmp, bookPath);
});

/** ブックに入れる文書を選ぶ（ブックのファイルからの相対パスで返す）。 */
ipcMain.handle("book:choose-docs", async (_e, bookPath: string) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win!, {
    title: "ブックに入れる文書を選ぶ",
    filters: [{ name: "tategumi 文書・テキスト・TeX", extensions: [FILE_EXTENSION, "txt", "tex"] }],
    properties: ["openFile", "multiSelections"],
  });
  if (canceled) return [];
  return filePaths.map((f) => path.relative(path.dirname(bookPath), f).replace(/\\/g, "/"));
});

/** ブックを組んで、文書ごとのページの範囲を返す（ページ番号はノンブル）。 */
ipcMain.handle("book:info", (_e, bookPath: string, book: Book) => {
  const { docs, errors } = loadBookDocs(bookPath, book);
  const combined = combineBook(book, docs);
  if (combined.included.length === 0) return { pages: 0, ranges: [], errors, renamed: [] };
  const { table } = fonts.loadTable(combined.settings.font, combined.settings.styles);
  const result = typesetLazy(combined.text, combined.settings, table, imageInfos(combined.images));
  const starts = result.labelPages();
  const first = combined.settings.nombreStart;
  const ranges = combined.included.map((i, k) => {
    const start = starts.get(docLabel(i)) ?? 0;
    const next = k + 1 < combined.included.length ? (starts.get(docLabel(combined.included[k + 1])) ?? result.pageCount) : result.pageCount;
    return { index: i, from: first + start, to: first + Math.max(start, next - 1) };
  });
  return { pages: result.pageCount, ranges, errors, renamed: combined.renamed };
});

/** ブック全体を1つの PDF に書き出す。 */
ipcMain.handle("book:export-pdf", (_e, bookPath: string, book: Book) => {
  const { docs, errors } = loadBookDocs(bookPath, book);
  const missing = errors.flatMap((e, i) => (e && book.documents[i].include ? [`${book.documents[i].path}：${e}`] : []));
  if (missing.length > 0) return { error: `読めない文書があります。\n${missing.join("\n")}` };
  const combined = combineBook(book, docs);
  if (combined.included.length === 0) return { error: "書き出す文書がありません。" };
  return exportPdfFile(combined.text, combined.settings, path.basename(bookPath, `.${BOOK_EXTENSION}`), combined.images);
});

/** ブック全体をつないだ原稿を、新しい（無題の）文書として開く（画像の書き出しや全体の確認に）。 */
ipcMain.handle("book:combined", (_e, bookPath: string, book: Book) => {
  const combined = combineBook(book, loadBookDocs(bookPath, book).docs);
  return { text: combined.text, settings: combined.settings, images: combined.images, filePath: null };
});

/** スタイルの元の文書の設定を、ほかの文書（tategumi 文書だけ）に書き込む。書き込んだ数を返す。 */
ipcMain.handle("book:sync", (_e, bookPath: string, book: Book) => {
  const dir = path.dirname(bookPath);
  const { docs } = loadBookDocs(bookPath, book);
  const source = docs[book.styleSource]?.settings;
  if (!source) return { error: "スタイルの元の文書に設定がありません（tategumi 文書を選んでください）。" };
  let count = 0;
  book.documents.forEach((entry, i) => {
    const doc = docs[i];
    if (i === book.styleSource || !doc?.settings || !entry.path.toLowerCase().endsWith(`.${FILE_EXTENSION}`)) return;
    const file = path.resolve(dir, entry.path);
    // 記法（標準・TeX）は文書ごとのまま。
    const settings = { ...structuredClone(source), format: { ...structuredClone(source.format), markup: doc.settings.format.markup } };
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, serializeDocument({ text: doc.text, settings, images: doc.images }), "utf8");
    fs.renameSync(tmp, file);
    count++;
  });
  return { count };
});

/** ブックの文書の場所（開くため）。 */
ipcMain.handle("book:doc-path", (_e, bookPath: string, rel: string) => path.resolve(path.dirname(bookPath), rel));

/** 画像の書き出し先：フォルダか ZIP（OUT-05）。書き出しの間だけ持つ。 */
let imageTarget: { kind: "dir"; dir: string } | { kind: "zip"; zip: ZipWriter } | undefined;

ipcMain.handle("images:begin", async (_e, baseName: string, zip: boolean) => {
  imageTarget = undefined;
  // 確認用の実行（--snapshot）では、書き出し先を指定されていなければ書き出さない（ダイアログを出さない）。
  if (snapshotDir && !autoImages) return undefined;
  if (zip) {
    const chosen = autoImages
      ? { canceled: false, filePath: path.resolve(`${autoImages}.zip`) }
      : await dialog.showSaveDialog(win!, { defaultPath: `${baseName}.zip`, filters: [{ name: "ZIP", extensions: ["zip"] }] });
    if (chosen.canceled || !chosen.filePath) return undefined;
    imageTarget = { kind: "zip", zip: new ZipWriter(chosen.filePath) };
    return chosen.filePath;
  }
  let dir: string | undefined;
  if (autoImages) {
    fs.mkdirSync(autoImages, { recursive: true });
    dir = path.resolve(autoImages);
  } else {
    const { canceled, filePaths } = await dialog.showOpenDialog(win!, { properties: ["openDirectory", "createDirectory"] });
    dir = canceled ? undefined : filePaths[0];
  }
  if (!dir) return undefined;
  imageTarget = { kind: "dir", dir };
  return dir;
});

ipcMain.handle("images:write", (_e, name: string, bytes: ArrayBuffer) => {
  if (!imageTarget) throw new Error("書き出し先が決まっていません。");
  // 名前は「ファイル名」か「フォルダ名/ファイル名」（SNS 向けの組）。それより深い場所や上のフォルダには書かない。
  const parts = name.split(/[\\/]/).map((p) => path.basename(p)).filter((p) => p && p !== "." && p !== "..").slice(-2);
  const file = parts.join("/");
  if (imageTarget.kind === "zip") imageTarget.zip.add(file, new Uint8Array(bytes));
  else {
    const target = path.join(imageTarget.dir, ...parts);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.from(bytes));
  }
});

/** ok が false なら、書きかけの ZIP を消す（フォルダに書いた画像はそのまま）。 */
ipcMain.handle("images:end", (_e, ok: boolean) => {
  if (imageTarget?.kind === "zip") {
    if (ok) imageTarget.zip.close();
    else imageTarget.zip.abort();
  }
  imageTarget = undefined;
});

/** 校正の補助（DTP-16）：表記ゆれは原稿から、禁則違反と段落末の1文字の行は組んだ結果から探す。 */
ipcMain.handle("proof", (_e, text: string, settings: Settings, images: Record<string, ImageInfo> = {}) => {
  const { table } = fonts.loadTable(settings.font, settings.styles);
  const result = typesetLazy(text, settings, table, images);
  const extra = { start: settings.advanced.kinsokuStartExtra, end: settings.advanced.kinsokuEndExtra };
  return { variants: findVariants(text), ...checkLines(result.pageCount, (i) => result.lines(i), extra) };
});

/** 書き出す前の検査（OUT-09）。 */
ipcMain.handle("preflight", (_e, text: string, settings: Settings, target: "pdf" | "images", images: Record<string, ImageInfo> = {}) => {
  const { table, warnings } = fonts.loadTable(settings.font, settings.styles);
  const result = typesetLazy(text, settings, table, images);
  return preflight({
    settings,
    pageCount: result.pageCount,
    page: (i) => result.page(i),
    missingChars: result.missingChars,
    fontWarnings: warnings,
    target,
    images,
    mathErrors: result.mathErrors,
  });
});

ipcMain.handle("snapshot:save", async (_e, images: ArrayBuffer[]) => {
  if (!snapshotDir) return;
  fs.mkdirSync(snapshotDir, { recursive: true });
  const window = await win!.webContents.capturePage();
  fs.writeFileSync(path.join(snapshotDir, "window.png"), window.toPNG());
  images.forEach((b, i) => fs.writeFileSync(path.join(snapshotDir, `shot-${String(i + 1).padStart(2, "0")}.png`), Buffer.from(b)));
  forceClose = true;
  app.quit();
});

ipcMain.handle("window:close", () => {
  forceClose = true;
  win?.close();
});

function buildMenu() {
  const cmd = (label: string, command: string, accelerator?: string): MenuItemConstructorOptions => ({
    label,
    accelerator,
    click: () => send("command", command),
  });
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" as const }] : []),
    {
      label: "ファイル",
      submenu: [
        cmd("新規", "new", "CmdOrCtrl+N"),
        cmd("開く…", "open", "CmdOrCtrl+O"),
        cmd("テンプレートから新規…", "new-from-template", "CmdOrCtrl+Shift+N"),
        { type: "separator" },
        cmd("上書き保存", "save", "CmdOrCtrl+S"),
        cmd("名前を付けて保存…", "save-as", "CmdOrCtrl+Shift+S"),
        cmd("テンプレート…", "templates"),
        cmd("今の設定をテンプレートとして保存…", "save-template"),
        { type: "separator" },
        cmd("ブック…", "book", "CmdOrCtrl+B"),
        { type: "separator" },
        cmd("PDF を書き出す…", "export-pdf", "CmdOrCtrl+E"),
        cmd("画像を書き出す…", "export-images", "CmdOrCtrl+Shift+E"),
        { type: "separator" },
        process.platform === "darwin" ? { role: "close", label: "閉じる" } : { role: "quit", label: "終了" },
      ],
    },
    {
      label: "編集",
      submenu: [
        { role: "undo", label: "元に戻す" },
        { role: "redo", label: "やり直す" },
        { type: "separator" },
        { role: "cut", label: "切り取り" },
        { role: "copy", label: "コピー" },
        { role: "paste", label: "貼り付け" },
        { role: "selectAll", label: "すべて選択" },
      ],
    },
    {
      label: "表示",
      submenu: [
        cmd("1ページ", "view-single", "CmdOrCtrl+1"),
        cmd("見開き", "view-spread", "CmdOrCtrl+2"),
        cmd("一覧", "view-grid", "CmdOrCtrl+3"),
        { type: "separator" },
        cmd("校正の補助…", "proof", "CmdOrCtrl+K"),
        { type: "separator" },
        { role: "toggleDevTools", label: "開発者ツール" },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// 同時に開くウィンドウは1つ。2つめの起動は、最初のウィンドウに文書を渡して終わる。
if (!snapshotDir && !app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", (_e, argv) => {
  const file = fileFromArgv(argv);
  if (file) requestOpen(file);
  else win?.focus();
});
// Mac：Finder で文書を開いたとき（起動前にも届く）。
app.on("open-file", (e, file) => {
  e.preventDefault();
  requestOpen(file);
});

app.whenReady().then(() => {
  buildMenu();
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: !snapshotDir,
    title: "tategumi",
    webPreferences: {
      preload: path.join(root, "dist", "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
    },
  });
  win.on("close", (e) => {
    if (forceClose || !dirty) return;
    e.preventDefault();
    const choice = dialog.showMessageBoxSync(win!, {
      type: "question",
      buttons: ["保存する", "保存しない", "キャンセル"],
      defaultId: 0,
      cancelId: 2,
      message: "変更を保存しますか？",
      detail: "保存しないと、最後に保存したあとの変更は失われます。",
    });
    if (choice === 0) send("command", "save-and-close");
    else if (choice === 1) {
      fs.rmSync(recoveryFile(), { force: true });
      forceClose = true;
      win!.close();
    }
  });
  if (snapshotDir) {
    // 確認用の実行では、画面側の console.log を標準出力に流す。
    win.webContents.on("console-message", (e) => console.log(e.message));
  }
  win.loadFile(path.join(root, "renderer", "index.html"));
});

app.on("window-all-closed", () => app.quit());
