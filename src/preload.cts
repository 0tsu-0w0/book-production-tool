import { contextBridge, ipcRenderer } from "electron";

// 画面（renderer）から呼べる処理だけを公開する。
const invoke =
  (channel: string) =>
  (...args: unknown[]) =>
    ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld("api", {
  init: invoke("init"),
  listFonts: invoke("fonts:list"),
  typeset: invoke("typeset"),
  pages: invoke("pages"),
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
  preflight: invoke("preflight"),
  proof: invoke("proof"),
  saveSnapshot: invoke("snapshot:save"),
  closeWindow: invoke("window:close"),
  onCommand: (fn: (command: string) => void) => ipcRenderer.on("command", (_e, command: string) => fn(command)),
  onProgress: (fn: (p: { label: string; done: number; total: number }) => void) =>
    ipcRenderer.on("progress", (_e, p: { label: string; done: number; total: number }) => fn(p)),
});
