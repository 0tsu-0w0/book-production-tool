import type { TategumiDocument } from "../document/document.js";
import { applyTemplate } from "../document/template.js";
import { imageInfos, type DocImage } from "../document/document.js";
import type { ImageInfo } from "../engine/types.js";
import { ImageManager } from "./image-manager.js";
import { CoverPreview } from "./cover-preview.js";
import { PageTyping } from "./page-typing.js";
import { InlineEditor } from "./inline-editor.js";
import { ProofDialog, type ProofResult } from "./proof-dialog.js";
import { combineSpread, spreadLabel, spreadPairs } from "../output/imposition.js";
import { parsePageRange } from "../document/range.js";
import type { Finding } from "../output/preflight.js";
import { DEFAULT_SETTINGS, leftBound, normalizeSettings, spreadOutput, toFormatOptions, type FontChoice, type Settings } from "../document/settings.js";
import { formatText } from "../engine/format.js";
import type { DrawPage } from "../engine/types.js";
import { GlyphPaths, type DrawFont } from "./draw.js";
import type { ExportMessage, ExportRequest } from "./export-worker.js";
import { Preview, type ViewMode } from "./preview.js";
import { SettingsPanel, type FontOption } from "./settings-panel.js";
import { TemplateDialog, type TemplateApi } from "./template-dialog.js";

interface TypesetResult {
  /** 組版の版。組み直すたびに増える。ページを取り寄せるときに使う。 */
  version: number;
  pageCount: number;
  /** フォントごとの 1em の大きさ。DrawItem.face の番号順（0 は本文の書体）。 */
  upems: number[];
  /** フォントごとのキー（字形の輪郭の控えを分けるため）。upems と同じ並び。 */
  fontKeys: string[];
  /** 頼んだページだけが入る（全ページは本体が持っている）。 */
  pages: DrawPage[];
  /** まだ画面に送っていない字形の輪郭だけが入る。 */
  paths: Record<string, Record<number, string>>;
  lastPageLines: number;
  linesPerPage: number;
  charsPerLine: number;
  columns: number;
  font: FontChoice;
  fontWarning?: string;
  missingChars: string[];
  mathErrors: string[];
  engineMs: number;
  /** 紙面で入力しているときの、カーソルのあるページ（なければ -1）。 */
  caretPage?: number;
}

type Opened =
  | { text: string; settings?: Settings; images?: DocImage[]; filePath: string | null; tex?: { title?: string; author?: string } }
  | { error: string };

interface Api extends TemplateApi {
  init(): Promise<{
    sample: string;
    recovery?: { doc: TategumiDocument; filePath: string | null; savedAt: string };
    opened?: Opened;
    snapshot: boolean;
    autoExport: boolean;
    bench: boolean;
    startPage: number;
  }>;
  listFonts(): Promise<{ list: FontOption[]; defaultChoice: FontChoice }>;
  typeset(text: string, settings: Settings, reset: boolean, wanted: number[], images: Record<string, ImageInfo>, caret?: [number, number]): Promise<TypesetResult>;
  pages(version: number, indices: number[]): Promise<{ pages: DrawPage[]; paths: Record<string, Record<number, string>> } | null>;
  openDocument(): Promise<Opened | undefined>;
  openPath(file: string): Promise<Opened>;
  onOpenPath(fn: (file: string) => void): void;
  saveDocument(doc: TategumiDocument, filePath: string | null, saveAs: boolean): Promise<string | undefined>;
  setDocumentState(dirty: boolean, filePath: string | null): Promise<void>;
  saveRecovery(doc: TategumiDocument, filePath: string | null): Promise<void>;
  clearRecovery(): Promise<void>;
  exportPdf(text: string, settings: Settings, baseName: string, images: DocImage[]): Promise<
    { path: string; pages: number; pdfx: boolean; standard?: "x1a" | "x4"; problems: string[] } | { error: string } | undefined
  >;
  listIccProfiles(): Promise<{ path: string; name: string }[]>;
  coverPreview(settings: Settings, pageCount: number, images: DocImage[]): Promise<{
    page: DrawPage;
    paths: Record<string, Record<number, string>>;
    fontKeys: string[];
    upems: number[];
    spineMm: number;
    widthMm: number;
    heightMm: number;
  }>;
  exportCover(settings: Settings, pageCount: number, baseName: string, images: DocImage[]): Promise<
    { path: string; spineMm: number; standard?: "x1a" | "x4"; problems: string[] } | { error: string } | undefined
  >;
  chooseIccProfile(): Promise<{ path: string; name: string } | { error: string } | undefined>;
  beginImages(baseName: string, zip: boolean): Promise<string | undefined>;
  writeImage(name: string, bytes: ArrayBuffer): Promise<void>;
  endImages(ok: boolean): Promise<void>;
  preflight(text: string, settings: Settings, target: "pdf" | "images", images: Record<string, ImageInfo>): Promise<Finding[]>;
  proof(text: string, settings: Settings, images: Record<string, ImageInfo>): Promise<ProofResult>;
  saveSnapshot(images: ArrayBuffer[]): Promise<void>;
  closeWindow(): Promise<void>;
  onCommand(fn: (command: string) => void): void;
  onProgress(fn: (p: { label: string; done: number; total: number }) => void): void;
}

declare global {
  interface Window {
    api: Api;
  }
}

const api = window.api;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const source = $<HTMLTextAreaElement>("source");
const counts = $<HTMLDivElement>("counts");
const status = $<HTMLSpanElement>("status");
const progress = $<HTMLProgressElement>("progress");
const stage = $<HTMLDivElement>("stage");

/** フォントごとの字形の輪郭（キーはフォントのキー）。 */
const glyphStores = new Map<string, GlyphPaths>();
const preview = new Preview(stage, $("page-label"), fetchPages);
const panel = new SettingsPanel($("settings"), onSettingsChanged, onPanelAction);
const imageManager = new ImageManager({
  changed: () => {
    preview.images = imageManager.bitmaps;
    markChanged();
  },
  insertLine: (line) => insertLine(line),
  renameInText: (from, to) => {
    // ［＃画像：古い名前］・［＃画像：古い名前　全面］などの名前だけを置き換える。
    const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    source.value = source.value.replace(new RegExp(`(［＃画像[：:]\\s*)${escaped}(?=[\\s］])`, "gu"), `$1${to}`);
  },
});
panel.custom.set("images", () => imageManager.element());

// 表紙の見本と書き出し。
const coverPreview = new CoverPreview({
  load: async () => {
    const r = await api.coverPreview(settings, result?.pageCount ?? 0, imageManager.images);
    addPaths(r.paths);
    return { ...r, fonts: r.fontKeys.map((key, i) => ({ paths: storeFor(key), upem: r.upems[i] })) };
  },
  images: () => imageManager.bitmaps,
  exportPdf: () => void exportCover(),
});
panel.custom.set("cover", () => coverPreview.element());

function exportCover() {
  return withBusy(async () => {
    setStatus("表紙を書き出しています…");
    const r = await api.exportCover(settings, result?.pageCount ?? 0, baseName(), imageManager.images);
    if (!r) return setStatus("書き出しを取り消しました。");
    if ("error" in r) {
      setStatus(r.error);
      alert(r.error);
      return;
    }
    const pdfx = r.standard === "x4" ? "PDF/X-4" : "PDF/X-1a";
    if (!r.standard) setStatus(`表紙（背幅 ${r.spineMm.toFixed(1)}mm）を保存しました：${r.path}`);
    else if (r.problems.length === 0) setStatus(`表紙（背幅 ${r.spineMm.toFixed(1)}mm）は ${pdfx} の検査に通りました。保存先：${r.path}`);
    else setStatus(`表紙を保存しましたが、${pdfx} の条件を満たしていません（${r.problems.join("、")}）：${r.path}`);
  });
}

// ---- 紙面から原稿へ（DTP-15） ----

/** 原稿の line 行目（0始まり）の始まりの位置。 */
function lineStartOffset(line: number): number {
  const lines = source.value.split("\n");
  return lines.slice(0, line).reduce((s, l) => s + l.length + 1, 0);
}

const inlineEditor = new InlineEditor({
  lineText: (line) => source.value.split("\n")[line],
  replaceLine: (line, text) => {
    const start = lineStartOffset(line);
    const old = source.value.split("\n")[line] ?? "";
    source.focus();
    source.setSelectionRange(start, start + old.length);
    // execCommand を使うと、原稿欄の「元に戻す」（Ctrl+Z）で戻せる。
    document.execCommand("insertText", false, text);
    setStatus(`原稿の${line + 1}行目を直しました（Ctrl+Z で戻せます）。`);
  },
});

// 紙面に直接打って直す（カーソルを置いて打つ）。
const typing = new PageTyping(preview, {
  source,
  vertical: () => !(settings.layoutMode === "book" && settings.book.writingMode === "horizontal"),
  setStatus: (text) => setStatus(text),
  stopped: () => ($<HTMLInputElement>("page-typing").checked = false),
});
typing.onMissing = () => scheduleTypeset(0);
preview.onShown = () => typing.render();

preview.onPick = (item, ev, double) => {
  const [line, offset] = item.src!;
  if (typing.active) {
    typing.place([line, offset]);
    return;
  }
  if (double) {
    inlineEditor.open(line, offset, ev.clientX, ev.clientY);
    return;
  }
  // クリック：原稿のその字を選び、見えるところまで送る。
  const start = lineStartOffset(line) + offset;
  source.focus();
  source.setSelectionRange(start, start + Math.max(1, [...item.text].length));
  const lineHeight = parseFloat(getComputedStyle(source).lineHeight) || 24;
  source.scrollTop = Math.max(0, (line - 3) * lineHeight);
};
const proofDialog = new ProofDialog({
  run: () => api.proof(source.value, settings, imageInfos(imageManager.images)),
  selectInText: (line, index, length) => {
    const lines = source.value.split("\n");
    const start = lines.slice(0, line - 1).reduce((s, l) => s + l.length + 1, 0) + index;
    source.focus();
    source.setSelectionRange(start, start + length);
    // 選んだ行が見えるように、おおよその位置まで送る。
    const lineHeight = parseFloat(getComputedStyle(source).lineHeight) || 24;
    source.scrollTop = Math.max(0, (line - 3) * lineHeight);
  },
  showPage: (page) => {
    setView("single");
    preview.goTo(page);
  },
  firstPageNumber: () => settings.nombreStart,
});
document.getElementById("proof-close")!.addEventListener("click", () => ($<HTMLDialogElement>("proof-dialog")).close());
preview.images = imageManager.bitmaps;

let settings: Settings = structuredClone(DEFAULT_SETTINGS);
let filePath: string | null = null;
let dirty = false;
let result: TypesetResult | undefined;
let busy = false;
let firstTypeset = true;
/** 直近の組版で、頼んでから結果が届くまでの時間（計測用）。 */
let lastIpcMs = 0;

// ---- 文書の状態 ----

function currentDocument(): TategumiDocument {
  return { text: source.value, settings, images: imageManager.images };
}

function baseName(): string {
  if (!filePath) return "無題";
  return filePath.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, "");
}

function setDirty(value: boolean) {
  dirty = value;
  void api.setDocumentState(dirty, filePath);
}

let recoveryTimer: number | undefined;
function markChanged() {
  if (!dirty) setDirty(true);
  // 数秒ごとに作業中の内容を控えておき、異常終了しても次の起動で戻せるようにする（NF-07）。
  clearTimeout(recoveryTimer);
  recoveryTimer = window.setTimeout(() => void api.saveRecovery(currentDocument(), filePath), 2000);
  scheduleTypeset();
}

/** images を渡さなければ（テキストを読み込んだとき）、今の画像をそのまま使う。 */
function loadDocument(text: string, s: Settings | undefined, path: string | null, isDirty = false, images?: DocImage[]) {
  source.value = text;
  if (images) void imageManager.load(images).then(() => scheduleTypeset(0));
  if (s) settings = normalizeSettings(s);
  filePath = path;
  panel.render(settings);
  setDirty(isDirty);
  scheduleTypeset(0);
}

// ---- 組版とプレビュー ----

let typesetTimer: number | undefined;
let typesetSeq = 0;
// 打ち終わってから組み直すまでの待ち時間。続けて打っている間は組み直さない。
function scheduleTypeset(delay = 60) {
  clearTimeout(typesetTimer);
  typesetTimer = window.setTimeout(() => void runTypeset(), delay);
}

async function runTypeset() {
  const seq = ++typesetSeq;
  const started = performance.now();
  const caret = typing.active ? typing.caret : undefined;
  const r = await api.typeset(source.value, settings, firstTypeset, preview.wanted(), imageInfos(imageManager.images), caret);
  lastIpcMs = performance.now() - started;
  firstTypeset = false;
  // 輪郭は、組版の結果を捨てる場合でも受け取っておく（本体は送ったものとして覚えている）。
  addPaths(r.paths);
  if (seq !== typesetSeq) return; // 組んでいる間に次の変更があった
  result = r;
  // グレースケールで書き出すときは、プレビューもグレーで見せる。
  stage.classList.toggle("gray", settings.output.color === "gray");
  source.classList.toggle("tex", settings.format.markup === "tex");
  preview.leftBound = leftBound(settings);
  preview.bleedMm = settings.advanced.bleedMm;
  updatePager();
  panel.setPageCount(r.pageCount);
  panel.setImageNames(imageManager.images.map((i) => i.name));
  coverPreview.update();
  // 紙面で入力しているときは、カーソルのあるページを見せる。
  if (caret && r.caretPage !== undefined && r.caretPage >= 0) preview.jumpTo(r.caretPage);
  preview.setDocument(r.version, r.pageCount, drawFonts(r), settings.nombreStart, r.pages);
  const chars = [...source.value.replace(/\n/g, "")].length;
  counts.textContent =
    `${chars.toLocaleString()}字　${r.pageCount}ページ（最終ページ ${r.lastPageLines}行）` +
    `　${r.charsPerLine}字×${r.linesPerPage}行${r.columns > 1 ? `×${r.columns}段` : ""}　組版 ${(performance.now() - started).toFixed(0)}ms`;
  if (r.mathErrors?.length) setStatus(r.mathErrors.join(" "));
  else if (r.fontWarning) setStatus(r.fontWarning);
  else if (r.missingChars.length > 0) {
    const shown = r.missingChars.slice(0, 20).join("");
    const more = r.missingChars.length > 20 ? `ほか、全${r.missingChars.length}種類` : "";
    setStatus(`「${r.font.name}」で表示できない文字があります（空白になります）：${shown}${more}`);
  } else if (status.textContent?.includes("表示できない文字")) setStatus("");
}

function addPaths(paths: Record<string, Record<number, string>>) {
  for (const [key, glyphs] of Object.entries(paths)) storeFor(key).add(glyphs);
}

function drawFonts(r: TypesetResult): DrawFont[] {
  return r.fontKeys.map((key, i) => ({ paths: storeFor(key), upem: r.upems[i] }));
}

function storeFor(fontKey: string): GlyphPaths {
  let store = glyphStores.get(fontKey);
  if (!store) glyphStores.set(fontKey, (store = new GlyphPaths()));
  return store;
}

/** プレビューに必要なページを本体から取り寄せる。 */
async function fetchPages(version: number, indices: number[]): Promise<DrawPage[] | null> {
  const r = await api.pages(version, indices);
  if (!r || !result) return null;
  addPaths(r.paths);
  return r.pages;
}

function onSettingsChanged(s: Settings) {
  settings = s;
  markChanged();
}

function onPanelAction(action: string) {
  if (action === "choose-icc") void chooseIcc();
  else if (action === "show-diff") showDiff();
  else if (action === "save-template") void templates.open(true);
  else if (action === "open-templates") void templates.open();
}

/** PDF/X-4 の印刷条件（ICC プロファイル）をファイルから選ぶ。 */
async function chooseIcc() {
  const r = await api.chooseIccProfile();
  if (!r) return;
  if ("error" in r) {
    alert(`この ICC プロファイルは使えません：${r.error}`);
    return;
  }
  panel.setIccProfiles(await api.listIccProfiles());
  settings.output.iccPath = r.path;
  panel.render(settings);
  onSettingsChanged(settings);
}

function setStatus(text: string) {
  status.textContent = text;
}

// ---- 整形の差分 ----

function showDiff() {
  const { lines } = formatText(source.value, toFormatOptions(settings));
  const body = $("diff-body");
  body.replaceChildren();
  const changed = lines.map((l, i) => ({ ...l, no: i + 1 })).filter((l) => l.after !== l.before);
  if (changed.length === 0) {
    const p = document.createElement("p");
    p.className = "hint";
    p.style.padding = "8px";
    p.textContent = "今の整形の設定では、変わる行はありません。";
    body.append(p);
  }
  for (const l of changed.slice(0, 500)) {
    const pair = document.createElement("div");
    pair.className = "pair";
    const no = document.createElement("div");
    no.className = "no";
    no.textContent = String(l.no);
    const texts = document.createElement("div");
    const del = document.createElement("del");
    del.textContent = l.before || "（空行）";
    const ins = document.createElement("ins");
    if (l.after === null) {
      ins.className = "removed";
      ins.textContent = "（この行を削除）";
    } else {
      ins.textContent = l.after || "（空行）";
    }
    texts.append(del, ins);
    pair.append(no, texts);
    body.append(pair);
  }
  $<HTMLDialogElement>("diff-dialog").showModal();
}

// ---- 入力補助（IN-06） ----

function insert(text: string, selectFrom?: number, selectTo?: number) {
  source.focus();
  const start = source.selectionStart;
  // execCommand を使うと、元に戻す（Ctrl+Z）の履歴に残る。
  document.execCommand("insertText", false, text);
  if (selectFrom !== undefined) source.setSelectionRange(start + selectFrom, start + (selectTo ?? selectFrom));
}

function selectedText(): string {
  return source.value.slice(source.selectionStart, source.selectionEnd);
}

function lineStart(): number {
  return source.value.lastIndexOf("\n", source.selectionStart - 1) + 1;
}

/** 命令の行を入れる（行の途中なら、改行してから）。 */
function insertLine(line: string) {
  const atLineStart = source.selectionStart === lineStart();
  insert(atLineStart ? `${line}
` : `
${line}
`);
}

const assists: Record<string, () => void> = {
  ruby: () => {
    const base = selectedText();
    if (base) insert(`｜${base}《》`, base.length + 2);
    else insert("｜《》", 1);
  },
  kenten: () => {
    const base = selectedText();
    if (base) insert(`｜${base}《圏》`);
    else insert("｜《圏》", 1);
  },
  dash: () => insert("――"),
  ellipsis: () => insert("……"),
  heading: () => {
    source.setSelectionRange(lineStart(), lineStart());
    insert("＃");
  },
  pagebreak: () => {
    const atLineStart = source.selectionStart === lineStart();
    insert(atLineStart ? "＝＝＝\n" : "\n＝＝＝\n");
  },
  odd: () => insertLine("［＃改丁］"),
  blankpage: () => insertLine("［＃白ページ］"),
  tobira: () => {
    // 選んだ行（なければ今の行）を［＃扉］…［＃／扉］で囲む。
    const start = lineStart();
    const last = source.selectionEnd > source.selectionStart ? source.selectionEnd - 1 : source.selectionEnd;
    const endBreak = source.value.indexOf("\n", Math.max(last, start));
    const end = endBreak < 0 ? source.value.length : endBreak;
    const body = source.value.slice(start, end);
    source.setSelectionRange(start, end);
    insert(`［＃扉］\n${body}\n［＃／扉］`, 5, 5 + body.length);
  },
  end: () => {
    source.focus();
    source.setSelectionRange(source.value.length, source.value.length);
    source.scrollTop = source.scrollHeight;
  },
  clear: () => {
    if (!confirm("本文をすべて消します。よろしいですか？（元に戻す Ctrl+Z で戻せます）")) return;
    source.focus();
    source.select();
    document.execCommand("delete");
  },
};

// ---- ファイル ----

function confirmDiscard(): boolean {
  return !dirty || confirm("保存していない変更があります。破棄して続けますか？");
}

async function save(saveAs = false): Promise<boolean> {
  const saved = await api.saveDocument(currentDocument(), filePath, saveAs);
  if (!saved) return false;
  filePath = saved;
  setDirty(false);
  await api.clearRecovery();
  setStatus(`保存しました：${saved}`);
  return true;
}

async function open(file?: string) {
  if (!confirmDiscard()) return;
  const opened = file ? await api.openPath(file) : await api.openDocument();
  if (!opened) return;
  if ("error" in opened) {
    alert(opened.error);
    return;
  }
  loadOpened(opened);
  setStatus(opened.filePath ? `開きました：${opened.filePath}` : "テキストを読み込みました。保存すると tategumi 文書になります。");
}

/**
 * 開いたファイルを画面に入れる。テキストを読み込んだときは、設定は今のものを引き継ぎ、無題の文書として扱う。
 * TeX を読み込んだときは記法を TeX にし、書誌が空なら \title・\author を入れる。
 */
function loadOpened(opened: Exclude<Opened, { error: string }>) {
  if (opened.tex) {
    settings.format.markup = "tex";
    settings.bookInfo.title ||= opened.tex.title ?? "";
    settings.bookInfo.author ||= opened.tex.author ?? "";
  }
  loadDocument(opened.text, opened.tex ? settings : opened.settings, opened.filePath, opened.filePath === null, opened.images);
}

/** 新規作成：既定のテンプレートがあればその設定で、なければ標準の設定で始める。 */
async function newDocument() {
  if (!confirmDiscard()) return;
  const def = await api.getDefaultTemplate();
  startDocument(def ? def.settings : DEFAULT_SETTINGS);
  if (def) setStatus(`テンプレート「${def.name}」の設定で新しい文書を作りました。`);
}

function startDocument(from: Settings) {
  loadDocument("", structuredClone(from), null, false, []);
  void api.clearRecovery();
}

const templates = new TemplateDialog(api, {
  create(s) {
    if (!confirmDiscard()) return false;
    startDocument(s);
    return true;
  },
  apply(s) {
    settings = applyTemplate(settings, s);
    panel.render(settings);
    markChanged();
  },
  current: () => settings,
  status: setStatus,
  defaultChanged: (name) => panel.setDefaultTemplateName(name),
});
void api.getDefaultTemplate().then((d) => panel.setDefaultTemplateName(d?.name ?? ""));
// PDF/X-4 に使える ICC プロファイルを探しておく（起動の邪魔にならないよう、少し後で）。
setTimeout(() => void api.listIccProfiles().then((list) => panel.setIccProfiles(list)), 1500);

// ---- 書き出し ----

async function withBusy(fn: () => Promise<void>): Promise<void> {
  if (busy) {
    setStatus("書き出しの途中です。終わるまでお待ちください。");
    return;
  }
  busy = true;
  try {
    await fn();
  } finally {
    busy = false;
    progress.hidden = true;
  }
}

/**
 * 書き出す前の検査（OUT-09）。直したほうがよいこと（error・warning）があれば一覧を見せて、書き出すか聞く。
 * 知っておくとよいこと（info）だけなら、そのまま進める。
 */
async function checkBeforeExport(target: "pdf" | "images"): Promise<{ go: boolean; notes: string[] }> {
  setStatus("書き出す前の検査をしています…");
  const findings = await api.preflight(source.value, settings, target, imageInfos(imageManager.images));
  const notes = findings.filter((f) => f.level === "info").map((f) => f.message);
  const serious = findings.filter((f) => f.level !== "info");
  if (init.autoExport) {
    for (const f of findings) console.log(`[preflight] ${f.level} ${f.message}`);
    return { go: true, notes };
  }
  if (serious.length === 0) return { go: true, notes };
  const list = $("check-list");
  list.replaceChildren(
    ...findings.map((f) => {
      const li = document.createElement("li");
      li.className = f.level;
      li.textContent = f.message;
      return li;
    }),
  );
  const dialog = $<HTMLDialogElement>("check-dialog");
  dialog.returnValue = "";
  dialog.showModal();
  $("check-go").focus();
  await new Promise((resolve) => dialog.addEventListener("close", resolve, { once: true }));
  return { go: dialog.returnValue === "go", notes };
}

function exportPdf() {
  return withBusy(async () => {
    const check = await checkBeforeExport("pdf");
    if (!check.go) return setStatus("書き出しをやめました。");
    setStatus("PDF を書き出しています…");
    const r = await api.exportPdf(source.value, settings, baseName(), imageManager.images);
    if (!r) return setStatus("書き出しを取り消しました。");
    if ("error" in r) {
      setStatus(r.error);
      alert(r.error);
      return;
    }
    const note = check.notes.length > 0 ? `　※${check.notes.join(" ")}` : "";
    const pdfx = r.standard === "x4" ? "PDF/X-4" : "PDF/X-1a";
    if (!r.pdfx) setStatus(`PDF（${r.pages}枚）を保存しました：${r.path}${note}`);
    else if (r.problems.length === 0) setStatus(`${pdfx} の検査に通りました（${r.pages}ページ）。保存先：${r.path}${note}`);
    else setStatus(`保存しましたが、${pdfx} の条件を満たしていません（${r.problems.join("、")}）：${r.path}`);
  });
}

function exportImages() {
  if (!result) return Promise.resolve();
  const current = result;
  const { version, pageCount } = current;
  return withBusy(async () => {
    const check = await checkBeforeExport("images");
    if (!check.go) return setStatus("書き出しをやめました。");
    const name = baseName();
    const zip = settings.output.zipImages;
    const first = settings.nombreStart;
    // 書き出すページ（範囲の指定。見開きなら、範囲に入るページを含む見開き）。
    let wanted: Set<number>;
    try {
      wanted = parsePageRange(settings.image.range, first, pageCount);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
      return setStatus("ページの範囲を直してください。");
    }
    const spread = spreadOutput(settings, "images");
    const pairs = spread ? spreadPairs(pageCount, first, leftBound(settings)).filter((p) => [p.right, p.left].some((i) => i !== null && wanted.has(i))) : [];
    const needed = spread ? pairs.flatMap((p) => [p.right, p.left]).filter((i): i is number => i !== null) : [...wanted].sort((a, b) => a - b);
    const target = await api.beginImages(name, zip);
    if (!target) return setStatus("書き出しを取り消しました。");
    // 書き出すときだけ、要るページを本体から受け取る。
    const all = await api.pages(version, needed);
    if (!all) {
      await api.endImages(false);
      return setStatus("書き出しの準備中に原稿が変わりました。もう一度書き出してください。");
    }
    addPaths(all.paths);
    const fonts = drawFonts(current).map((f) => ({ paths: f.paths.record(), upem: f.upem }));
    const { format, dpi, jpegQuality } = settings.image;
    const ext = format === "jpeg" ? "jpg" : "png";
    // 見開きなら2ページを1枚に並べる。名前はページ番号（見開きは 002-003 のように）。
    const byIndex = new Map(all.pages.map((p) => [p.index, p]));
    const get = (i: number | null) => (i === null ? null : (byIndex.get(i) ?? null));
    const pages = spread ? pairs.map((p, k) => combineSpread(get(p.right), get(p.left), k)) : needed.map((i) => byIndex.get(i)!);
    const labels = spread ? pairs.map((p) => spreadLabel(p, first, leftBound(settings))) : needed.map((i) => String(first + i).padStart(3, "0"));
    // SNS 向け：4枚ずつの組（フォルダ「作品名_01」…）に分ける。
    const names = labels.map((l, k) => `${settings.image.snsGroups ? `${name}_${String(Math.floor(k / 4) + 1).padStart(2, "0")}/` : ""}${name}_${l}.${ext}`);
    // 画像は画面の裏（Worker）で描き、1枚できるごとに保存する（NF-04）。
    const worker = new Worker(new URL("./export-worker.js", import.meta.url), { type: "module" });
    progress.hidden = false;
    progress.max = pages.length;
    progress.value = 0;
    let done = 0;
    let failed = false;
    await new Promise<void>((resolve) => {
      worker.onmessage = async (e: MessageEvent<ExportMessage>) => {
        const msg = e.data;
        if (msg.type === "page") {
          await api.writeImage(msg.name, msg.bytes);
          done++;
          progress.value = done;
          setStatus(`画像を書き出しています… ${done} / ${pages.length}`);
          if (done === pages.length) resolve();
        } else if (msg.type === "error") {
          failed = true;
          setStatus(`画像の書き出しに失敗しました：${msg.message}`);
          resolve();
        }
      };
      const images = imageManager.images.map((i) => ({ name: i.name, mime: i.mime, bytes: Uint8Array.from(atob(i.data), (c) => c.charCodeAt(0)).buffer }));
      const credit = settings.image.credit.trim() ? { text: settings.image.credit.trim(), color: settings.textColor } : undefined;
      const req: ExportRequest = { pages, fonts, dpi, format, jpegQuality, gray: settings.output.color === "gray", names, images, credit };
      worker.postMessage(req);
    });
    worker.terminate();
    await api.endImages(!failed);
    if (!failed) {
      const kind = `${ext.toUpperCase()}・${Math.round(dpi)}dpi${settings.output.color === "gray" ? "・グレー" : ""}`;
      setStatus(`${done}枚の画像（${kind}）を${zip ? "ZIP にまとめて" : ""}保存しました：${target}`);
    }
  });
}

// ---- コマンド ----

async function runCommand(command: string) {
  switch (command) {
    case "new":
      return newDocument();
    case "proof":
      return proofDialog.open();
    case "save-template":
      return templates.open(true);
    case "new-from-template":
    case "templates":
      return templates.open();
    case "open":
      return open();
    case "save":
      await save();
      return;
    case "save-as":
      await save(true);
      return;
    case "save-and-close":
      if (await save()) await api.closeWindow();
      return;
    case "export-pdf":
      return exportPdf();
    case "export-images":
      return exportImages();
    case "view-single":
      return setView("single");
    case "view-spread":
      return setView("spread");
    case "view-grid":
      return setView("grid");
  }
}

function setView(mode: ViewMode) {
  preview.setMode(mode);
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-view]")) {
    b.setAttribute("aria-checked", String(b.dataset.view === mode));
  }
}

// ---- 画面の部品をつなぐ ----

source.addEventListener("input", markChanged);
$<HTMLInputElement>("page-typing").addEventListener("change", (e) => {
  const on = (e.target as HTMLInputElement).checked;
  // 紙面での入力は1ページ表示で行う。
  if (on) setView("single");
  typing.setActive(on);
});
for (const b of document.querySelectorAll<HTMLButtonElement>("[data-command]")) {
  b.addEventListener("click", () => void runCommand(b.dataset.command!));
}
for (const b of document.querySelectorAll<HTMLButtonElement>("[data-view]")) {
  b.addEventListener("click", () => setView(b.dataset.view as ViewMode));
}
for (const b of document.querySelectorAll<HTMLButtonElement>("[data-insert]")) {
  b.addEventListener("click", () => assists[b.dataset.insert!]());
}
stage.addEventListener("modechange", () => setView("single"));
/** ページ送りのボタン：右綴じは左が「次」、左綴じは右が「次」。 */
function updatePager() {
  const next = $("next");
  const prev = $("prev");
  if (preview.leftBound) {
    next.textContent = "次 ▶";
    prev.textContent = "◀ 前";
    next.title = "次のページ（右へ）";
    prev.title = "前のページ（左へ）";
    next.parentElement!.append(next);
    next.parentElement!.prepend(prev);
  } else {
    next.textContent = "◀ 次";
    prev.textContent = "前 ▶";
    next.title = "次のページ（左へ）";
    prev.title = "前のページ（右へ）";
    next.parentElement!.prepend(next);
    next.parentElement!.append(prev);
  }
}

$("next").addEventListener("click", () => preview.next());
$("prev").addEventListener("click", () => preview.prev());
$<HTMLInputElement>("guides").addEventListener("change", (e) => {
  preview.guides = (e.target as HTMLInputElement).checked;
  preview.show();
});
stage.tabIndex = 0;
stage.addEventListener("keydown", (e) => {
  // 右綴じは左へ、左綴じ（横組み）は右へめくると次のページ。
  const forward = preview.leftBound ? "ArrowRight" : "ArrowLeft";
  const back = preview.leftBound ? "ArrowLeft" : "ArrowRight";
  if (e.key === forward) preview.next();
  if (e.key === back) preview.prev();
});
window.addEventListener("resize", () => preview.show());
api.onCommand((c) => void runCommand(c));
// 起動中に、ほかから文書を開くよう頼まれたとき（文書のダブルクリックなど）。
api.onOpenPath((file) => void open(file));
api.onProgress((p) => {
  progress.hidden = false;
  progress.max = p.total;
  progress.value = p.done;
  setStatus(`${p.label}を書き出しています… ${p.done} / ${p.total}ページ`);
});

// ---- 起動 ----

const init = await api.init();
panel.render(settings);
void api.listFonts().then(({ list, defaultChoice }) => panel.setFonts(list, defaultChoice.name));

if (init.opened && "error" in init.opened) alert(init.opened.error);
if (init.opened && !("error" in init.opened)) {
  loadOpened(init.opened);
} else if (
  init.recovery &&
  confirm(`前回、保存せずに終了した作業があります（${new Date(init.recovery.savedAt).toLocaleString()}）。復元しますか？`)
) {
  loadDocument(init.recovery.doc.text, init.recovery.doc.settings, init.recovery.filePath, true, init.recovery.doc.images);
} else {
  if (init.recovery) void api.clearRecovery();
  loadDocument(init.sample, undefined, null);
}

if (init.snapshot) {
  // 確認用：組み終わるのを待ってから、3つの表示のプレビューを保存して終了する。
  await new Promise((r) => setTimeout(r, 300));
  await runTypeset();
  const shots: ArrayBuffer[] = [];
  for (const mode of ["single", "spread", "grid"] as ViewMode[]) {
    setView(mode);
    preview.goTo(init.startPage - 1);
    await new Promise((r) => setTimeout(r, 400));
    const canvas = [...stage.querySelectorAll("canvas")].find((c) => c.width > 1 && !c.classList.contains("blank"));
    if (canvas) shots.push(await (await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!)))).arrayBuffer());
  }
  if (init.bench) {
    // 原稿の真ん中に1文字足して組み直し、プレビューが描き終わるまでの時間を測る（NF-03）。
    const times: number[] = [];
    const engine: number[] = [];
    const ipc: number[] = [];
    const draw: number[] = [];
    setView("single");
    preview.goTo(Math.floor((result?.pageCount ?? 1) / 2));
    await new Promise((r) => setTimeout(r, 300));
    for (let i = 0; i < 10; i++) {
      const mid = Math.floor(source.value.length / 2);
      source.value = `${source.value.slice(0, mid)}あ${source.value.slice(mid)}`;
      const t = performance.now();
      await runTypeset();
      // プレビューの描画は、ページの受け取り（マイクロタスク）のあとに同期的に行われる。
      // 隠した窓では requestAnimationFrame が間引かれるので、setTimeout で描画の完了を待つ。
      await new Promise((r) => setTimeout(r, 0));
      times.push(performance.now() - t);
      engine.push(result!.engineMs);
      ipc.push(lastIpcMs);
      draw.push(preview.lastDrawMs);
    }
    times.sort((a, b) => a - b);
    engine.sort((a, b) => a - b);
    const med = (a: number[]) => [...a].sort((x, y) => x - y)[5].toFixed(0);
    console.log(`[bench] 中央値 本体での組版 ${med(engine)}ms／結果が届くまで ${med(ipc)}ms／描画 ${med(draw)}ms`);
    console.log(`[bench] ${result?.pageCount}ページ 組み直し〜描画: 中央値 ${times[5].toFixed(0)}ms 最大 ${times[9].toFixed(0)}ms`);
  }
  if (init.autoExport) {
    await exportPdf();
    await exportImages();
    console.log(`[snapshot] ${status.textContent}`);
  }
  await api.saveSnapshot(shots);
}
