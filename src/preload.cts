import { contextBridge, ipcRenderer } from "electron";

// 画面（renderer）から呼べる処理だけを公開する。

// 組版（typeset・pages・proof・preflight）は、本体を通さずに組版のプロセスへ直接頼む（本体が渡す MessagePort で）。
// 口が届く前の頼みは、届くまで待つ。口が替わったら（組版のプロセスが作り直されたら）、待っていた頼みは失敗にする。
let port: MessagePort | undefined;
let portReady: (p: MessagePort) => void;
let portPromise = new Promise<MessagePort>((r) => (portReady = r));
let nextId = 0;
const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
ipcRenderer.on("typesetter-port", (e) => {
  for (const w of waiting.values()) w.reject(new Error("組版のプロセスが作り直されました"));
  waiting.clear();
  port?.close();
  const p = (port = e.ports[0]);
  p.onmessage = (m: MessageEvent) => {
    const msg = m.data as { id: number; ok: boolean; value?: unknown; message?: string };
    const w = waiting.get(msg.id);
    if (!w) return;
    waiting.delete(msg.id);
    if (msg.ok) w.resolve(msg.value);
    else w.reject(new Error(msg.message));
  };
  p.start();
  portReady(p);
  portPromise = Promise.resolve(p);
});
// 画面が読み込まれたので、本体に口を頼む。
ipcRenderer.send("typesetter:connect");
const typesetter =
  (type: string, names: string[]) =>
  async (...args: unknown[]) => {
    const p = await portPromise;
    const id = ++nextId;
    const req: Record<string, unknown> = { type };
    names.forEach((n, i) => (req[n] = args[i]));
    return new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      p.postMessage({ id, req });
    });
  };

const invoke =
  (channel: string) =>
  (...args: unknown[]) =>
    ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld("api", {
  init: invoke("init"),
  listFonts: invoke("fonts:list"),
  listAllFonts: invoke("fonts:list-all"),
  glyphVariants: invoke("glyphs:variants"),
  typeset: typesetter("typeset", ["text", "settings", "reset", "wanted", "images", "caret"]),
  pages: typesetter("pages", ["version", "indices"]),
  openDocument: invoke("doc:open"),
  openPath: invoke("doc:open-path"),
  onOpenPath: (fn: (file: string) => void) => ipcRenderer.on("open-path", (_e, file: string) => fn(file)),
  saveDocument: invoke("doc:save"),
  setDocumentState: invoke("doc:state"),
  saveRecovery: invoke("recovery:save"),
  clearRecovery: invoke("recovery:clear"),
  listTemplates: invoke("templates:list"),
  getTemplate: invoke("templates:get"),
  saveTemplate: invoke("templates:save"),
  deleteTemplate: invoke("templates:delete"),
  importTemplate: invoke("templates:import"),
  openTemplateFolder: invoke("templates:open-folder"),
  getDefaultTemplate: invoke("templates:get-default"),
  setDefaultTemplate: invoke("templates:set-default"),
  exportPdf: invoke("pdf:export"),
  exportEpub: invoke("epub:export"),
  exportIdml: invoke("idml:export"),
  exportPackage: invoke("package:export"),
  bookExportEpub: invoke("book:export-epub"),
  listIccProfiles: invoke("icc:list"),
  bookNew: invoke("book:new"),
  bookOpen: invoke("book:open"),
  bookSave: invoke("book:save"),
  bookChooseDocs: invoke("book:choose-docs"),
  bookInfo: invoke("book:info"),
  bookExportPdf: invoke("book:export-pdf"),
  bookCombined: invoke("book:combined"),
  bookSync: invoke("book:sync"),
  bookDocPath: invoke("book:doc-path"),
  coverPreview: invoke("cover:preview"),
  exportCover: invoke("cover:export"),
  chooseIccProfile: invoke("icc:choose"),
  beginImages: invoke("images:begin"),
  writeImage: invoke("images:write"),
  endImages: invoke("images:end"),
  preflight: typesetter("preflight", ["text", "settings", "target", "images"]),
  proof: typesetter("proof", ["text", "settings", "images"]),
  saveSnapshot: invoke("snapshot:save"),
  closeWindow: invoke("window:close"),
  getAppearance: invoke("appearance:get"),
  setAppearance: invoke("appearance:set"),
  chooseBackground: invoke("appearance:choose"),
  wallpaper: invoke("appearance:wallpaper"),
  minimizeWindow: invoke("window:minimize"),
  requestClose: invoke("window:request-close"),
  toggleMaximize: invoke("window:toggle-maximize"),
  popupMenu: invoke("window:menu"),
  onWindowTitle: (fn: (t: string) => void) => ipcRenderer.on("window-title", (_e, t: string) => fn(t)),
  onWindowMaximized: (fn: (m: boolean) => void) => ipcRenderer.on("window-maximized", (_e, m: boolean) => fn(m)),
  onWindowGeometry: (fn: (g: unknown) => void) => ipcRenderer.on("window-geometry", (_e, g) => fn(g)),
  onWallpaperVersion: (fn: (v: number) => void) => ipcRenderer.on("wallpaper-version", (_e, v: number) => fn(v)),
  onCommand: (fn: (command: string) => void) => ipcRenderer.on("command", (_e, command: string) => fn(command)),
  onProgress: (fn: (p: { label: string; done: number; total: number }) => void) =>
    ipcRenderer.on("progress", (_e, p: { label: string; done: number; total: number }) => fn(p)),
});
