import { leftBound, spineWidthMm, toLayoutSpec, type Settings } from "../document/settings.js";
import { AUTHOR_STYLE, TITLE_STYLE } from "../document/styles.js";
import { engineStyles, type FontTable } from "./index.js";
import { layoutCover, MM, type CoverText } from "./layout.js";
import { parseInline } from "./parse.js";
import { applyProportional, measureRotated, resolvePage } from "./resolve.js";
import { prepareSpacing } from "./spacing.js";
import { applyStyles } from "./styles.js";
import type { Block, DrawPage, ImageInfo } from "./types.js";

// 表紙（OUT-10 の背幅を使う）。表1・背・表4 を1枚に並べ、題と著者名を置く。
// 書体は段落スタイル「書名」「著者名」のもの（大きさは表紙の大きさから決める）。

/** 本文が pageCount ページのときの表紙を組む。 */
export function typesetCover(settings: Settings, fonts: FontTable, images: Record<string, ImageInfo>, pageCount: number): { page: DrawPage; spineMm: number; widthMm: number; heightMm: number } {
  const spec = toLayoutSpec(settings);
  const info = settings.bookInfo;
  const text = (s: string, style: string): Block & { kind: "para" } => ({ kind: "para", style, atoms: parseInline(s.replace(/\n/g, "　")) });
  const blocks = [text(info.title, TITLE_STYLE), text(info.author, AUTHOR_STYLE), text(info.title, TITLE_STYLE), text(info.author, AUTHOR_STYLE)];
  applyStyles(blocks, engineStyles(settings.styles, fonts));
  measureRotated(blocks, fonts.faces);
  prepareSpacing(blocks, spec.typography, spec.rubyScale);
  applyProportional(blocks, fonts.faces);
  const cover = (b: (typeof blocks)[number]): CoverText => ({ atoms: b.atoms, scale: b.atoms[0]?.cells[0]?.scale ?? 1 });
  const spineMm = spineWidthMm(pageCount, settings.output);
  const layout = layoutCover({
    trimWidth: spec.pageWidthMm * MM,
    trimHeight: spec.pageHeightMm * MM,
    spine: spineMm * MM,
    bleed: settings.advanced.bleedMm * MM,
    leftBound: leftBound(settings),
    horizontal: leftBound(settings),
    title: cover(blocks[0]),
    author: cover(blocks[1]),
    spineTitle: cover(blocks[2]),
    spineAuthor: cover(blocks[3]),
    spineText: settings.cover.spineText,
    background: settings.cover.background,
    frontImage: settings.cover.frontImage || undefined,
    backImage: settings.cover.backImage || undefined,
    images,
  });
  return { page: resolvePage(layout, fonts.faces, settings.cover.textColor), spineMm, widthMm: spec.pageWidthMm * 2 + spineMm, heightMm: spec.pageHeightMm };
}
