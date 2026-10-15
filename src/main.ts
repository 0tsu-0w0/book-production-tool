import { BrowserWindow, Menu, MessageChannelMain, app, desktopCapturer, dialog, ipcMain, nativeTheme, net, protocol, screen, session, shell, utilityProcess, type MenuItemConstructorOptions, type UtilityProcess, type WebContents } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { DocumentFormatError, FILE_EXTENSION, imageInfos, parseDocument, serializeDocument, type DocImage, type KolophonDocument, LEGACY_EXTENSIONS } from "./document/document.js";
import { compositeFonts, type FontChoice, type Settings } from "./document/settings.js";
import { BUILTIN_TEMPLATES, LEGACY_TEMPLATE_EXTENSIONS, TEMPLATE_EXTENSION, parseTemplate, serializeTemplate, templateFileName } from "./document/template.js";
import { glyphPaths, typesetLazy, type ImageInfo } from "./engine/index.js";
import { FontService } from "./fonts/service.js";
import { glyphVariants } from "./fonts/glyph-variants.js";
import { buildEpub, writeEpub } from "./output/epub.js";
import { epubFonts } from "./output/epub-fonts.js";
import { writePackage } from "./output/package.js";
import { BOOK_EXTENSION, BookFormatError, LEGACY_BOOK_EXTENSIONS, combineBook, docLabel, newBook, parseBook, serializeBook, type Book, type BookDocument } from "./document/book.js";
import { typesetCover } from "./engine/cover.js";
import { checkPdfX } from "./output/check-pdfx.js";
import { pdfOptions } from "./output/export-pdf.js";
import { renderPdf } from "./output/pdf.js";
import { IccError, findCmykProfiles, iccProblem, readIcc } from "./output/icc.js";
import { BACKGROUND_SCHEME, IMAGE_EXTENSIONS, VIDEO_EXTENSIONS, normalizeAppearance, type Appearance, type WindowGeometry } from "./appearance.js";
import { texToMarkup } from "./engine/tex.js";
import { ZipWriter } from "./output/zip.js";
import { buildIdml } from "./output/idml.js";
import { importIdml } from "./document/idml-import.js";
import type { PdfWorkerInput, PdfWorkerMessage } from "./pdf-worker.js";
import type { TypesetConnect } from "./typeset-worker.js";
import { SAMPLE_TEXT } from "./sample.js";

// 旧名（tategumi）のときの設定（テンプレート・既定のテンプレート・控え・最後に開いたブックなど）を、初めて起動したときに引き継ぐ。
function migrateUserData() {
  const dir = app.getPath("userData");
  const old = path.join(app.getPath("appData"), "tategumi");
  if (path.resolve(old).toLowerCase() === path.resolve(dir).toLowerCase() || !fs.existsSync(old)) return;
  // 引き継ぐのは一度だけ（復元を断って控えを消したあとに、また古い控えを写さないように）。
  const done = path.join(dir, "migrated-from-tategumi");
  if (fs.existsSync(done)) return;
  // 0.16.0・0.17.0 ですでに引き継いだ PC（印はまだない）は、印だけ残す。
  const already = fs.existsSync(path.join(dir, "Local Storage"));
  for (const name of already ? [] : ["templates", "default-template.json", "recovery.json", "font-cache.json", "Local Storage"]) {
    const from = path.join(old, name);
    const to = path.join(dir, name);
    if (!fs.existsSync(from) || fs.existsSync(to)) continue;
    try {
      fs.cpSync(from, to, { recursive: true });
    } catch {
      // 引き継げなくても使える。
    }
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(done, new Date().toISOString(), "utf8");
  } catch {
    // 印を残せなくても使える。
  }
}
migrateUserData();

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
// PC のフォントを調べた結果は控えておき、次の起動では変わったファイルだけを調べる。
const fontCacheFile = path.join(app.getPath("userData"), "font-cache.json");
const fonts = new FontService({ cacheFile: fontCacheFile });

// 確認用：--snapshot=<フォルダ> で起動すると、先頭のページを PNG に書き出して終了する。--doc=<文書> でその文書を開く。
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const snapshotDir = arg("snapshot");
/** 文書をダブルクリックして起動したとき（Windows）は、コマンドラインにそのパスが来る。 */
function fileFromArgv(argv: string[]): string | undefined {
  return argv.slice(1).find((a) => !a.startsWith("-") && /\.(kolo|kolob|kolophon|kolbook|tategumi|tgbook|txt|tex|idml)$/i.test(a) && fs.existsSync(a));
}
let startupDoc = arg("doc") ?? fileFromArgv(process.argv);
// 確認用：ダイアログを出さずに、指定した場所へ書き出す（--snapshot と一緒に使う）。
const autoPdf = snapshotDir ? arg("export-pdf") : undefined;
const autoImages = snapshotDir ? arg("export-images") : undefined;
const autoEpub = snapshotDir ? arg("export-epub") : undefined;
const autoPackage = snapshotDir ? arg("export-package") : undefined;
const autoIdml = snapshotDir ? arg("export-idml") : undefined;
// 確認用：--bench を付けると、原稿の途中を何度か書き換えて組み直しの時間を測り、標準出力に書く。
const bench = !!snapshotDir && process.argv.includes("--bench");

let win: BrowserWindow | undefined;
let dirty = false;
let currentPath: string | null = null;
let forceClose = false;
/**
 * 窓はいつも透明にできる作りにする（Windows・Mac）。背景はすべて画面の側で描くので、どの背景にも起動し直さずに切り替えられる。
 * 透明な窓では Windows の枠が使えないので、Windows では画面の側で題名の欄（メニュー・最小化・最大化・閉じる）を出す。Mac は枠を残す。
 */
const TRANSPARENT_WINDOW = process.platform === "win32" || process.platform === "darwin";
const FRAMELESS = process.platform === "win32";

const recoveryFile = () => path.join(app.getPath("userData"), "recovery.json");

function updateTitle() {
  const name = currentPath ? path.basename(currentPath) : "無題";
  const title = `${name}${dirty ? " *" : ""} — Kolophon`;
  win?.setTitle(title);
  send("window-title", title);
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

/** 書体のファミリー名から、PC の書体を探す（IDML の読み込み）。見つからなければ null。 */
function fontByFamily(name: string | undefined): FontChoice | null {
  if (!name) return null;
  const plain = (s: string) => s.replace(/\s/g, "").toLowerCase();
  const list = fonts.list();
  const f = list.find((e) => e.family === name) ?? list.find((e) => e.name === name) ?? list.find((e) => plain(e.family) === plain(name) || plain(e.name) === plain(name));
  return f ? { name: f.name, postscriptName: f.postscriptName, path: f.path, index: f.index } : null;
}

/** IDML（InDesign）を読み込む。書体は PC の書体に読み替え、ない書体は知らせる。 */
function openIdml(file: string): Opened {
  const r = importIdml(fs.readFileSync(file));
  const missing = new Set<string>();
  const pick = (name: string | undefined) => {
    const f = fontByFamily(name);
    if (name && !f) missing.add(name);
    return f;
  };
  // 書体：PC で見つかればその書体に。元の原稿に戻したときは、見つからなければ元の書体のまま。
  if (r.fonts.body) {
    const f = pick(r.fonts.body);
    if (f || !r.restored) r.settings.font = f;
  }
  for (const p of r.settings.styles.paragraph) if (r.fonts.paragraph[p.name] && r.fonts.paragraph[p.name] !== r.fonts.body) p.font = pick(r.fonts.paragraph[p.name]);
  for (const c of r.settings.styles.character) if (r.fonts.character[c.name]) c.font = pick(r.fonts.character[c.name]);
  const notes = [...r.notes, ...(missing.size > 0 ? [`PC にない書体（${[...missing].join("・")}。本文の書体で組みます）`] : [])];
  return { text: r.text, settings: r.settings, images: r.images, filePath: null, imported: { from: path.basename(file), notes } };
}

type Opened = { text: string; settings?: Settings; images?: DocImage[]; filePath: string | null; tex?: { title?: string; author?: string }; imported?: { from: string; notes: string[] } };

/** 文書（.kolo・前の .kolophon・.tategumi）かテキスト（.txt）・TeX・IDML を開く。テキストは本文だけを返し、設定は今のものを使う。 */
function openFile(file: string): Opened {
  if (file.toLowerCase().endsWith(".idml")) return openIdml(file);
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

const isBookFile = (file: string) => [BOOK_EXTENSION, ...LEGACY_BOOK_EXTENSIONS].some((e) => file.toLowerCase().endsWith(`.${e}`));
/** 文書（設定を持つファイル）か。 */
const isDocFile = (file: string) => [FILE_EXTENSION, ...LEGACY_EXTENSIONS].some((e) => file.toLowerCase().endsWith(`.${e}`));
/** 開くダイアログで選べる文書の拡張子。 */
const DOC_EXTENSIONS = [FILE_EXTENSION, ...LEGACY_EXTENSIONS];

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
  let recovery: { doc: KolophonDocument; filePath: string | null; savedAt: string } | undefined;
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
    autoExport: !!(autoPdf || autoImages || autoEpub || autoPackage || autoIdml),
    autoPackage: !!autoPackage,
    autoIdml: !!autoIdml,
    bench,
    /** 確認用：--page=N で、スナップショットを N ページ目から撮る。 */
    startPage: Number(arg("page")) || 1,
  };
});

// 画面の見た目（窓の背景）。アプリの設定のフォルダに appearance.json と、取り込んだ画像・動画（backgrounds）を置く。
const appearanceFile = () => path.join(app.getPath("userData"), "appearance.json");
const backgroundsDir = () => path.join(app.getPath("userData"), "backgrounds");
/** 確認用：--appearance=<JSON ファイル> で、保存してある見た目の代わりにそれを使う（保存はしない）。 */
const appearanceArg = arg("appearance");

function loadAppearance(): Appearance {
  try {
    return normalizeAppearance(JSON.parse(fs.readFileSync(appearanceArg ?? appearanceFile(), "utf8")));
  } catch {
    return normalizeAppearance({});
  }
}

/** すりガラスは窓そのものの機能なので、ここで窓に当てる（画像・動画は画面の側で描く）。 */
function applyWindowBackground(a: Appearance) {
  if (!win) return;
  // 後ろの窓のすりガラス：画面を取り込むとき、Kolophon 自身は写らないようにする（窓の中に窓が映り続けないように）。
  // その間は、スクリーンショットや画面共有にも Kolophon が写らない。
  win.setContentProtection(a.kind === "behind");
  // Mac のすりガラス（vibrancy）。Windows のすりガラス（アクリル・マイカ）は透明な窓では効かないので使わない。
  if (process.platform === "darwin") win.setVibrancy(a.kind === "glass" ? "under-window" : null);
  // 透明にできない窓（Linux）は、画面の地の色にしておく（描き始める前にちらつかないように）。
  if (!TRANSPARENT_WINDOW) win.setBackgroundColor(nativeTheme.shouldUseDarkColors ? "#1c1b19" : "#efece6");
}

/** デスクトップの壁紙のファイル（Windows：今の壁紙を Windows が写しておくファイル）。なければ undefined。 */
function wallpaperFile(): string | undefined {
  if (process.platform !== "win32") return undefined;
  const f = path.join(app.getPath("appData"), "Microsoft", "Windows", "Themes", "TranscodedWallpaper");
  return fs.existsSync(f) ? f : undefined;
}
/** 壁紙が変わったかを知るための値（ファイルの更新時刻）。壁紙がなければ 0。 */
function wallpaperVersion(): number {
  const f = wallpaperFile();
  try {
    return f ? Math.round(fs.statSync(f).mtimeMs) : 0;
  } catch {
    return 0;
  }
}

/** 窓の中身がディスプレイのどこにあるかを画面に知らせる（壁紙を窓の位置に合わせて敷くため）。 */
function sendGeometry() {
  if (!win || win.isDestroyed()) return;
  const c = win.getContentBounds();
  const display = screen.getDisplayMatching(c);
  const d = display.bounds;
  const g: WindowGeometry = { x: c.x - d.x, y: c.y - d.y, width: d.width, height: d.height, display: display.id };
  send("window-geometry", g);
}

ipcMain.handle("appearance:get", () => ({
  appearance: loadAppearance(),
  platform: process.platform,
  wallpaper: wallpaperVersion(),
  transparentWindow: TRANSPARENT_WINDOW,
  frameless: FRAMELESS,
  maximized: !!win?.isMaximized(),
}));

// 透明な窓の題名の欄から使う：最小化・最大化・メニュー。
ipcMain.handle("window:minimize", () => win?.minimize());
/** 閉じる（保存していなければ、いつもどおり聞く）。 */
ipcMain.handle("window:request-close", () => win?.close());
ipcMain.handle("window:toggle-maximize", () => {
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
ipcMain.handle("window:menu", (_e, x: number, y: number) => {
  Menu.getApplicationMenu()?.popup({ window: win, x: Math.round(x), y: Math.round(y) });
});
ipcMain.handle("appearance:wallpaper", () => {
  sendGeometry();
  return wallpaperVersion();
});

ipcMain.handle("appearance:set", (_e, value: unknown) => {
  const a = normalizeAppearance(value);
  applyWindowBackground(a);
  if (appearanceArg) return a;
  fs.mkdirSync(path.dirname(appearanceFile()), { recursive: true });
  fs.writeFileSync(appearanceFile(), JSON.stringify(a, null, 2), "utf8");
  // 使っていない背景のファイルは消す。
  try {
    for (const f of fs.readdirSync(backgroundsDir())) if (f !== a.file) fs.rmSync(path.join(backgroundsDir(), f), { force: true });
  } catch {
    // フォルダがなければ何もしない。
  }
  return a;
});

/** 背景にする画像・動画を選び、アプリの設定のフォルダに取り込む（元のファイルを動かしても消えないように）。 */
ipcMain.handle("appearance:choose", async (_e, kind: "image" | "video") => {
  const extensions = kind === "video" ? VIDEO_EXTENSIONS : IMAGE_EXTENSIONS;
  const { canceled, filePaths } = await dialog.showOpenDialog(win!, {
    title: kind === "video" ? "背景にする動画を選ぶ" : "背景にする画像を選ぶ",
    filters: [{ name: kind === "video" ? "動画" : "画像", extensions }],
    properties: ["openFile"],
  });
  if (canceled || !filePaths[0]) return undefined;
  const src = filePaths[0];
  const ext = path.extname(src).toLowerCase();
  const name = `${kind}-${Date.now()}${ext}`;
  try {
    fs.mkdirSync(backgroundsDir(), { recursive: true });
    fs.copyFileSync(src, path.join(backgroundsDir(), name));
  } catch (e) {
    return { error: `ファイルを取り込めませんでした：${String(e)}` };
  }
  return { file: name, label: path.basename(src) };
});

ipcMain.handle("fonts:list", () => ({ list: fonts.list(), defaultChoice: fonts.defaultChoice() }));
/** 合成フォントの欧文に使える書体の一覧（埋め込めるフォントすべて。初めて頼まれたときに調べる）。 */
ipcMain.handle("fonts:list-all", () => fonts.listAll());

/** 字形パネル：本文の書体（font）で、字 base の別の字形（異体字・字形の候補）を調べる。vertical なら縦組みの字形で。 */
ipcMain.handle("glyphs:variants", (_e, font: FontChoice | null, base: string, vertical: boolean) => {
  const l = fonts.load(font);
  return {
    upem: l.face.upem,
    emBottom: l.face.emBottom,
    font: l.choice.name,
    variants: glyphVariants(l.face, l.bytes, l.choice.index ?? 0, base, vertical),
  };
});

/** 本体から送った字形の輪郭（表紙の見本の分）。画面の組版の分は、組版のプロセスが覚えている。 */
const sentPaths = new Map<string, Set<number>>();

/**
 * 画面のための組版のプロセス（typeset-worker。Electron の utilityProcess）。大きな本を組んでいる間も、
 * 窓の移動やメニューが止まらないようにする。画面とは MessagePort で直接つなぐ（本体は口を渡すだけ）。
 * 画面が読み込まれるたびに、画面（preload）から口を頼まれる。プロセスが落ちたときは、作り直してつなぎ直す。
 */
let typesetter: UtilityProcess | undefined;
/** 組版のプロセスとつないでいる画面。 */
let typesetClient: WebContents | undefined;

function connectTypesetter(client: WebContents | undefined = typesetClient) {
  if (!client || client.isDestroyed()) return;
  typesetClient = client;
  if (!typesetter) {
    const child = utilityProcess.fork(path.join(here, "typeset-worker.js"), [], { serviceName: "Kolophon 組版" });
    child.on("exit", () => {
      if (typesetter !== child) return;
      typesetter = undefined;
      // 落ちたら作り直して、画面とつなぎ直す（画面は待っている頼みを失敗にして、次から新しい口を使う）。
      if (!quitting) connectTypesetter();
    });
    typesetter = child;
  }
  const { port1, port2 } = new MessageChannelMain();
  const connect: TypesetConnect = { type: "connect", fontCacheFile };
  typesetter.postMessage(connect, [port1]);
  client.postMessage("typesetter-port", null, [port2]);
  // 新しい画面は、字形の輪郭をまだ何も持っていない（表紙の見本の分も送り直す）。
  sentPaths.clear();
}

// 画面（preload）が読み込まれたら、組版のプロセスとつなぐ口を渡す。
ipcMain.on("typesetter:connect", (e) => connectTypesetter(e.sender));

/** 終了するときは、組版のプロセスを作り直さない。 */
let quitting = false;
app.on("before-quit", () => {
  quitting = true;
  typesetter?.kill();
});

ipcMain.handle("doc:open", async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win!, {
    filters: [
      { name: "Kolophon 文書・テキスト・TeX・IDML", extensions: [...DOC_EXTENSIONS, "txt", "tex", "idml"] },
      { name: "Kolophon 文書", extensions: DOC_EXTENSIONS },
      { name: "テキスト", extensions: ["txt"] },
      { name: "TeX", extensions: ["tex"] },
      { name: "InDesign（IDML）", extensions: ["idml"] },
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

ipcMain.handle("doc:save", async (_e, doc: KolophonDocument, filePath: string | null, saveAs: boolean) => {
  let target = saveAs ? null : filePath;
  if (!target) {
    const { canceled, filePath: chosen } = await dialog.showSaveDialog(win!, {
      defaultPath: filePath ?? `無題.${FILE_EXTENSION}`,
      filters: [{ name: "Kolophon 文書", extensions: [FILE_EXTENSION] }],
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

ipcMain.handle("recovery:save", (_e, doc: KolophonDocument, filePath: string | null) => {
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
    files = fs.readdirSync(templatesDir()).filter((f) => [TEMPLATE_EXTENSION, ...LEGACY_TEMPLATE_EXTENSIONS].some((e) => f.endsWith(`.${e}`)));
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
    filters: [{ name: "Kolophon テンプレート", extensions: [TEMPLATE_EXTENSION, ...LEGACY_TEMPLATE_EXTENSIONS] }],
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
  const { table } = fonts.loadTable(settings.font, settings.styles, compositeFonts(settings));
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
    const { loaded, table } = fonts.loadTable(settings.font, settings.styles, compositeFonts(settings));
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
  const { loaded, table } = fonts.loadTable(settings.font, settings.styles, compositeFonts(settings));
  const { canceled, filePath } = autoPdf
    ? { canceled: false, filePath: path.resolve(autoPdf) }
    : await dialog.showSaveDialog(win!, { defaultPath: `${baseName}.pdf`, filters: [{ name: "PDF", extensions: ["pdf"] }] });
  if (canceled || !filePath) return undefined;

  return renderPdfFile(text, settings, images, filePath, loaded, table);
}

/** PDF を別スレッドで組んで filePath に書き出し、入稿用なら検査する（書き出しの中心。パッケージでも使う）。 */
async function renderPdfFile(
  text: string,
  settings: Settings,
  images: DocImage[],
  filePath: string,
  loaded: ReturnType<FontService["loadTable"]>["loaded"],
  table: ReturnType<FontService["loadTable"]>["table"],
): Promise<{ error: string } | { path: string; pages: number; pdfx: boolean; standard?: string; problems: string[] }> {
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

// ---- パッケージ（InDesign のパッケージにあたるもの） ----

/**
 * 入稿に要るものを1つのフォルダにまとめる：文書・Links（画像）・Fonts（書体）・入稿用 PDF・指示書.txt。
 * 保存先のフォルダの名前を聞く（同じ名前のフォルダがあって中身があれば、作り直さずに知らせる）。
 * 入稿用 PDF は、閲覧用を選んでいても入稿用（トンボ付き）で書き出す。
 */
ipcMain.handle(
  "package:export",
  async (_e, text: string, settings: Settings, baseName: string, images: DocImage[] = [], findings: { level: "error" | "warning" | "info"; message: string }[] = []) => {
    if (snapshotDir && !autoPackage) return undefined;
    const { canceled, filePath } = autoPackage
      ? { canceled: false, filePath: path.resolve(autoPackage) }
      : await dialog.showSaveDialog(win!, { title: "パッケージ（フォルダ）の保存先", defaultPath: `${baseName} フォルダ`, buttonLabel: "パッケージを作る", properties: ["createDirectory", "showOverwriteConfirmation"] });
    if (canceled || !filePath) return undefined;
    if (fs.existsSync(filePath) && (!fs.statSync(filePath).isDirectory() || fs.readdirSync(filePath).length > 0)) {
      return { error: `「${path.basename(filePath)}」はもうあります（中身のあるフォルダかファイル）。別の名前にしてください。` };
    }
    const { loaded, table } = fonts.loadTable(settings.font, settings.styles, compositeFonts(settings));
    const printSettings: Settings = settings.pdfKind === "screen" ? { ...settings, pdfKind: "print" } : settings;
    try {
      const r = await writePackage({
        dir: filePath,
        name: baseName,
        text,
        settings,
        images,
        fonts: loaded.map((l) => l.choice),
        findings,
        appVersion: app.getVersion(),
        pdf: async (file) => {
          const res = await renderPdfFile(text, printSettings, images, file, loaded, table);
          return "error" in res ? { error: res.error } : { pages: res.pages, standard: res.standard, problems: res.problems };
        },
      });
      return { path: r.dir, files: r.files.length, skippedFonts: r.skippedFonts, pdf: r.pdf };
    } catch (e) {
      return { error: `パッケージを作れませんでした：${e instanceof Error ? e.message : String(e)}` };
    }
  },
);

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

const bookFilters = [{ name: "Kolophon ブック", extensions: [BOOK_EXTENSION, ...LEGACY_BOOK_EXTENSIONS] }];
/** ブックのファイル名から拡張子を除いた名前。 */
const bookName = (bookPath: string) => path.basename(bookPath).replace(/\.(kolob|kolbook|tgbook)$/i, "");

ipcMain.handle("book:new", async () => {
  const { canceled, filePath } = await dialog.showSaveDialog(win!, { defaultPath: `新しいブック.${BOOK_EXTENSION}`, filters: [{ name: "Kolophon ブック", extensions: [BOOK_EXTENSION] }] });
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
    filters: [{ name: "Kolophon 文書・テキスト・TeX", extensions: [...DOC_EXTENSIONS, "txt", "tex"] }],
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
  const { table } = fonts.loadTable(combined.settings.font, combined.settings.styles, compositeFonts(combined.settings));
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
  return exportPdfFile(combined.text, combined.settings, bookName(bookPath), combined.images);
});

/** ブック全体をつないだ原稿を、新しい（無題の）文書として開く（画像の書き出しや全体の確認に）。 */
ipcMain.handle("book:combined", (_e, bookPath: string, book: Book) => {
  const combined = combineBook(book, loadBookDocs(bookPath, book).docs);
  return { text: combined.text, settings: combined.settings, images: combined.images, filePath: null };
});

/** スタイルの元の文書の設定を、ほかの文書（Kolophon 文書だけ）に書き込む。書き込んだ数を返す。 */
ipcMain.handle("book:sync", (_e, bookPath: string, book: Book) => {
  const dir = path.dirname(bookPath);
  const { docs } = loadBookDocs(bookPath, book);
  const source = docs[book.styleSource]?.settings;
  if (!source) return { error: "スタイルの元の文書に設定がありません（Kolophon 文書を選んでください）。" };
  let count = 0;
  book.documents.forEach((entry, i) => {
    const doc = docs[i];
    if (i === book.styleSource || !doc?.settings || !isDocFile(entry.path)) return;
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

/** EPUB を書き出す（保存先を聞いて）。 */
async function exportEpubFile(text: string, settings: Settings, baseName: string, images: DocImage[]) {
  if (snapshotDir && !autoEpub) return undefined;
  const { canceled, filePath } = autoEpub
    ? { canceled: false, filePath: path.resolve(autoEpub) }
    : await dialog.showSaveDialog(win!, { defaultPath: `${baseName}.epub`, filters: [{ name: "EPUB（電子書籍）", extensions: ["epub"] }] });
  if (canceled || !filePath) return undefined;
  try {
    let files = buildEpub(text, settings, images);
    // 書体を埋め込む：使った字を集めてから、その字だけに絞った書体を入れて作り直す。
    if (settings.output.epubFonts) {
      const { table, loaded } = fonts.loadTable(settings.font, settings.styles, compositeFonts(settings));
      const embedded = epubFonts(files, settings, loaded, table.keys);
      if (embedded.length > 0) files = buildEpub(text, settings, images, new Date(), embedded);
    }
    const zip = new ZipWriter(filePath);
    writeEpub(files, (name, data) => zip.add(name, data));
    zip.close();
    return { path: filePath, files: files.length };
  } catch (e) {
    return { error: `EPUB を書き出せませんでした：${e instanceof Error ? e.message : String(e)}` };
  }
}

ipcMain.handle("epub:export", (_e, text: string, settings: Settings, baseName: string, images: DocImage[] = []) => exportEpubFile(text, settings, baseName, images));

/**
 * IDML（InDesign の受け渡し用の形式）を書き出す。ページ数とページ番号の参照の番号は、Kolophon で組んだ結果から取る。
 * 書体は、PC の書体の一覧からファミリー名とスタイルを引いて入れる。
 */
ipcMain.handle("idml:export", async (_e, text: string, settings: Settings, baseName: string, images: DocImage[] = []) => {
  if (snapshotDir && !autoIdml) return undefined;
  const { canceled, filePath } = autoIdml
    ? { canceled: false, filePath: path.resolve(autoIdml) }
    : await dialog.showSaveDialog(win!, { defaultPath: `${baseName}.idml`, filters: [{ name: "InDesign（IDML）", extensions: ["idml"] }] });
  if (canceled || !filePath) return undefined;
  let zip: ZipWriter | undefined;
  try {
    const { table } = fonts.loadTable(settings.font, settings.styles, compositeFonts(settings));
    const result = typesetLazy(text, settings, table);
    const labels = result.labelPages();
    const list = fonts.list();
    const entryOf = (f: FontChoice | null) => (f ? list.find((e) => e.postscriptName === f.postscriptName && e.path === f.path) ?? list.find((e) => e.postscriptName === f.postscriptName) : list[0]);
    // 画像のリンクのファイルは、IDML の隣の「名前 Links」フォルダに書く。
    const linkDir = path.join(path.dirname(filePath), `${path.basename(filePath, path.extname(filePath))} Links`);
    // Kolophon で組んだページの、画像の置き場所とノンブルの所。
    const pages = Array.from({ length: result.pageCount }, (_, i) => {
      const p = result.page(i);
      return { images: p.shapes.flatMap((s) => (s.kind === "image" ? [s] : [])), nombre: p.nombre, hasText: result.lines(i).some((l) => l.text.trim() !== "") };
    });
    // 前付けを別に数えるときの本文の始まり：ページの名前が数字になる最初のページ。
    const bodyStart = result.pageLabels.findIndex((l) => /^\d+$/.test(l));
    const { files, skipped, links } = buildIdml(text, settings, {
      pageCount: result.pageCount,
      pages,
      images,
      linkPath: (file) => path.join(linkDir, file),
      bodyStart: bodyStart > 0 ? bodyStart : undefined,
      // ページの名前（001・i など）から、紙面に出す番号の字にする。
      pageOf: (label) => {
        const i = labels.get(label);
        return i === undefined ? undefined : result.pageLabels[i]?.replace(/^0+(?=\d)/, "");
      },
      fontName: (f) => {
        const e = entryOf(f);
        return e ? { family: e.family, style: e.style, postscriptName: e.postscriptName, cff: e.cff } : undefined;
      },
    });
    zip = new ZipWriter(filePath);
    for (const f of files) zip.add(f.name, f.data);
    zip.close();
    if (links.length > 0) {
      fs.mkdirSync(linkDir, { recursive: true });
      for (const l of links) fs.writeFileSync(l.path, l.data);
    }
    return { path: filePath, pages: result.pageCount, skipped, links: links.length, linkDir: links.length > 0 ? linkDir : undefined };
  } catch (e) {
    zip?.abort();
    return { error: `IDML を書き出せませんでした：${e instanceof Error ? e.message : String(e)}` };
  }
});

/** ブック全体を1つの EPUB に書き出す。 */
ipcMain.handle("book:export-epub", (_e, bookPath: string, book: Book) => {
  const { docs, errors } = loadBookDocs(bookPath, book);
  const missing = errors.flatMap((e, i) => (e && book.documents[i].include ? [`${book.documents[i].path}：${e}`] : []));
  if (missing.length > 0) return { error: `読めない文書があります。\n${missing.join("\n")}` };
  const combined = combineBook(book, docs);
  if (combined.included.length === 0) return { error: "書き出す文書がありません。" };
  return exportEpubFile(combined.text, combined.settings, bookName(bookPath), combined.images);
});

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


ipcMain.handle("snapshot:save", async (_e, images: ArrayBuffer[]) => {
  if (!snapshotDir) return;
  fs.mkdirSync(snapshotDir, { recursive: true });
  // 隠した窓は描き直しが間引かれるので、描き直させてから撮る。
  win!.webContents.invalidate();
  await new Promise((r) => setTimeout(r, 300));
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

/**
 * Kolophon の窓の中身を PNG で保存する。背景の「後ろの窓のすりガラス」の間は、OS のスクリーンショットに Kolophon が
 * 写らないので、その代わりに使う（アプリが自分で描いた画面を保存するので、背景も含めて写る）。
 */
async function saveWindowImage() {
  if (!win) return;
  const image = await win.webContents.capturePage();
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: "画面を画像で保存",
    defaultPath: path.join(app.getPath("pictures"), `Kolophon-${stamp}.png`),
    filters: [{ name: "PNG 画像", extensions: ["png"] }],
  });
  if (canceled || !filePath) return;
  try {
    fs.writeFileSync(filePath, image.toPNG());
  } catch (e) {
    dialog.showErrorBox("保存できませんでした", String(e));
  }
}

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
        cmd("EPUB（電子書籍）を書き出す…", "export-epub"),
        cmd("パッケージ（入稿用にまとめる）…", "export-package"),
        cmd("IDML（InDesign）を書き出す…", "export-idml"),
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
        { type: "separator" },
        cmd("検索…", "find", "CmdOrCtrl+F"),
        cmd("置換…", "replace", "CmdOrCtrl+H"),
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
        cmd("背景…", "background"),
        { label: "画面を画像で保存…", accelerator: "CmdOrCtrl+Shift+P", click: () => void saveWindowImage() },
        { type: "separator" },
        { role: "toggleDevTools", label: "開発者ツール" },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// 取り込んだ背景の画像・動画を画面で読むための scheme（動画の頭出しのため stream を許す）。
protocol.registerSchemesAsPrivileged([
  { scheme: BACKGROUND_SCHEME, privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } },
]);

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
  protocol.handle(BACKGROUND_SCHEME, async (req) => {
    if (new URL(req.url).host === "wallpaper") {
      // 壁紙のファイルには拡張子がないので、中身から種類を決めて返す。
      const f = wallpaperFile();
      if (!f) return new Response(null, { status: 404 });
      const bytes = await fs.promises.readFile(f);
      const type = bytes[0] === 0x89 && bytes[1] === 0x50 ? "image/png" : "image/jpeg";
      return new Response(bytes, { headers: { "content-type": type } });
    }
    const name = path.basename(decodeURIComponent(new URL(req.url).pathname));
    // 背景のフォルダの中のファイルだけを返す。
    const dir = appearanceArg ? path.dirname(path.resolve(appearanceArg)) : backgroundsDir();
    return net.fetch(pathToFileURL(path.join(dir, name)).toString(), { headers: req.headers });
  });
  // 後ろの窓のすりガラス：画面の取り込み（getDisplayMedia）を頼まれたら、窓のあるディスプレイを選ぶ（選ぶ画面は出さない）。
  // ほかの使い方では取り込ませない。
  session.defaultSession.setDisplayMediaRequestHandler(async (_req, callback) => {
    if (loadAppearance().kind !== "behind" || !win) return callback({});
    const display = screen.getDisplayMatching(win.getBounds());
    const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } });
    const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
    callback(source ? { video: source } : {});
  });
  win = new BrowserWindow({
    ...(TRANSPARENT_WINDOW ? { transparent: true, frame: !FRAMELESS } : {}),
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: !snapshotDir,
    title: "Kolophon",
    // すりガラスを使うときに窓の地が透けるよう、地は透明にしておく（画面の側でいつも地の色を塗る）。
    backgroundColor: "#00000000",
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
  applyWindowBackground(loadAppearance());
  for (const ev of ["move", "resize", "maximize", "unmaximize", "restore"] as const) win.on(ev as "move", sendGeometry);
  // 題名の欄の最大化のボタンを、窓の状態に合わせる。
  win.on("maximize", () => send("window-maximized", true));
  win.on("unmaximize", () => send("window-maximized", false));
  // 窓に戻ってきたとき、壁紙が変わっていれば読み直させる。
  win.on("focus", () => send("wallpaper-version", wallpaperVersion()));
  win.loadFile(path.join(root, "renderer", "index.html"));
});

app.on("window-all-closed", () => app.quit());
