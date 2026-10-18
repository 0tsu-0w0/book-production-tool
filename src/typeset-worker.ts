import type { MessagePortMain } from "electron";
import { compositeFonts, type Settings } from "./document/settings.js";
import { glyphPaths, typesetLazy, type FontTable, type ImageInfo, type LazyTypesetResult } from "./engine/index.js";
import { checkLines, findVariants } from "./engine/proof.js";
import { FontService } from "./fonts/service.js";
import { preflight } from "./output/preflight.js";
import { packPage } from "./engine/packed-page.js";

// 画面のための組版を、別のプロセス（Electron の utilityProcess）で行う。
// 本体（main）は窓の移動・メニュー・保存なども受け持つので、大きな本を組んでいる間にそれらが止まらないようにする。
// 画面とは、本体が渡した MessagePort で直接やりとりする（本体を通さないので、本体の忙しさに左右されない）。
// 最新の組版はこのプロセスが持ち、画面が頼んだページだけを送る。書き出す前の検査と校正の補助も、
// 原稿と設定が画面と同じなら、その組版を使い回す（同じ本を組み直さない）。
// （Node の worker_threads は、本体のプロセスでは返事に気づくのが遅れることがあるので使わない。）

/** 本体から届く知らせ：画面とつなぐ口（ports[0]）と、フォントの控えの場所。 */
export interface TypesetConnect {
  type: "connect";
  /** フォントを調べた結果の控え（読むだけ。書くのは本体）。 */
  fontCacheFile?: string;
}

export type TypesetRequest =
  | { type: "typeset"; text: string; settings: Settings; reset: boolean; wanted: number[]; images: Record<string, ImageInfo>; caret?: [number, number] }
  | { type: "pages"; version: number; indices: number[] }
  | { type: "proof"; text: string; settings: Settings; images: Record<string, ImageInfo> }
  | { type: "preflight"; text: string; settings: Settings; target: "pdf" | "images"; images: Record<string, ImageInfo> };

export type TypesetWorkerMessage = { id: number; ok: true; value: unknown } | { id: number; ok: false; message: string };

let fonts = new FontService({ writeCache: false });

/** 画面にすでに送った字形の輪郭（フォントごと）。同じ輪郭を毎回送り直さないため。 */
const sentPaths = new Map<string, Set<number>>();

/**
 * 最新の組版結果。全ページはこのスレッドが持ち、画面には見えているページだけを送る
 * （10万字・約300ページを毎回送ると、それだけで 10MB を超えるため）。
 * source は組んだ原稿・設定・画像（検査で同じ組版を使い回せるかを見分ける）。
 */
let latest: { version: number; result: LazyTypesetResult; fonts: FontTable; source: { text: string; settings: string; images: string } } | undefined;
let version = 0;

function pagesPayload(indices: number[]) {
  const { result, fonts: table } = latest!;
  const picked = [...new Set(indices)].filter((i) => i >= 0 && i < result.pageCount).map((i) => result.page(i));
  // ページは詰めた形で送る（画面への受け渡しを軽くする。#11）。
  return { pages: picked.map(packPage), paths: glyphPaths(picked, table, sentPaths) };
}

/** 原稿と設定が画面の最新の組版と同じならそれを、違えば組み直したものを返す。 */
function resultFor(text: string, settings: Settings, images: Record<string, ImageInfo>) {
  const { table, warnings } = fonts.loadTable(settings.font, settings.styles, compositeFonts(settings));
  const same = latest && latest.source.text === text && latest.source.settings === JSON.stringify(settings) && latest.source.images === JSON.stringify(images);
  return { result: same ? latest!.result : typesetLazy(text, settings, table, images), warnings };
}

function handle(req: TypesetRequest): unknown {
  switch (req.type) {
    case "typeset": {
      const { text, settings, reset, wanted, caret } = req;
      const images = req.images ?? {};
      const started = performance.now();
      const { table, loaded, warnings } = fonts.loadTable(settings.font, settings.styles, compositeFonts(settings));
      const result = typesetLazy(text, settings, table, images);
      if (reset) sentPaths.clear();
      latest = { version: ++version, result, fonts: table, source: { text, settings: JSON.stringify(settings), images: JSON.stringify(images) } };
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
        pageLabels: result.pageLabels,
        pages,
        paths,
        caretPage,
        font: loaded[0].choice,
        fontWarning: warnings.join(" "),
        /** 組版にかかった時間（計測用）。 */
        engineMs: performance.now() - started,
      };
    }
    case "pages":
      // 組み直しで版が変わっていたら null（画面は新しい版を待つ）。
      if (!latest || latest.version !== req.version) return null;
      return pagesPayload(req.indices);
    case "proof": {
      // 校正の補助（DTP-16）：表記ゆれは原稿から、禁則違反と段落末の1文字の行は組んだ結果から探す。
      const { result } = resultFor(req.text, req.settings, req.images ?? {});
      const extra = { start: req.settings.advanced.kinsokuStartExtra, end: req.settings.advanced.kinsokuEndExtra };
      const custom = req.settings.kinsoku === "custom" ? req.settings.kinsokuCustom : undefined;
      return { variants: findVariants(req.text), ...checkLines(result.pageCount, (i) => result.lines(i), extra, custom) };
    }
    case "preflight": {
      // 書き出す前の検査（OUT-09）。
      const images = req.images ?? {};
      const { result, warnings } = resultFor(req.text, req.settings, images);
      return preflight({
        settings: req.settings,
        pageCount: result.pageCount,
        page: (i) => result.page(i),
        missingChars: result.missingChars,
        fontWarnings: warnings,
        target: req.target,
        images,
        mathErrors: result.mathErrors,
        missingLabels: result.missingLabels,
      });
    }
  }
}

/** 画面とつなぐ口。窓を読み直したら、新しい口が届く（前の口は閉じる）。 */
let port: MessagePortMain | undefined;

function answer(p: MessagePortMain, { id, req }: { id: number; req: TypesetRequest }) {
  let msg: TypesetWorkerMessage;
  try {
    msg = { id, ok: true, value: handle(req) };
  } catch (err) {
    msg = { id, ok: false, message: err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err) };
  }
  p.postMessage(msg);
}

process.parentPort.on("message", (e) => {
  const data = e.data as TypesetConnect;
  if (data?.type !== "connect" || !e.ports[0]) return;
  if (data.fontCacheFile) fonts = new FontService({ cacheFile: data.fontCacheFile, writeCache: false });
  port?.close();
  const p = (port = e.ports[0]);
  // 新しい画面：送った字形の輪郭は、まだ何もない。
  sentPaths.clear();
  latest = undefined;
  p.on("message", (m) => answer(p, m.data as { id: number; req: TypesetRequest }));
  p.start();
});
