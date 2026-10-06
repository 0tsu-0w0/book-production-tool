import { createHash } from "node:crypto";
import type { DocImage } from "../document/document.js";
import { horizontalPunctuation, leftBound, toFormatOptions, toParseOptions, type Settings } from "../document/settings.js";
import { CAPTION_STYLE, NOTE_STYLE, TABLE_HEADER_STYLE, TABLE_STYLE, hasDecoration, type CharacterStyle, type ParagraphRule, type ParagraphStyle } from "../document/styles.js";
import { bookPageBlocks } from "../engine/book-pages.js";
import { formatText } from "../engine/format.js";
import { compileGrep, grepCellStyles } from "../engine/grep.js";
import { renderMath } from "../engine/math.js";
import { parse } from "../engine/parse.js";
import { texToMarkup } from "../engine/tex.js";
import type { Atom, Block, Cell, ImageBlock, TableBlock } from "../engine/types.js";

// EPUB 3（リフロー型）の書き出し。原稿を Kolophon の記法で読み、段落・見出し・ルビ・圏点・縦中横・注・表・画像・
// 数式（SVG）を XHTML にする。縦組みの本は縦書き（右から左へめくる）、横組みの本は横書き。
// 改ページ・改丁・大見出しで XHTML を分ける。目次は見出しから作る（nav）。
// 書体は、渡されれば埋め込む（使った字だけに絞ったもの。epub-fonts.ts）。なければ読む側の書体。

export interface EpubFile {
  name: string;
  data: Uint8Array;
}

/**
 * 埋め込む書体。role：body は本文、ps・cs は段落・文字スタイル（index の番号）。
 * range があれば、その字の範囲だけに使う（合成フォントのかな・欧文。CSS の unicode-range）。
 */
export interface EpubFont {
  role: "body" | "ps" | "cs";
  index?: number;
  file: string;
  mime: "font/ttf" | "font/otf";
  data: Uint8Array;
  range?: string;
}

/** CSS の書体の名前。 */
const fontFamily = (f: Pick<EpubFont, "role" | "index">) => (f.role === "body" ? "kolophon-body" : `kolophon-${f.role}${f.index}`);

const enc = new TextEncoder();
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** 圏点の記号 → CSS の text-emphasis-style。 */
const EMPHASIS: Record<string, string> = {
  "﹅": "filled sesame",
  "﹆": "open sesame",
  "●": "filled circle",
  "○": "open circle",
  "◎": "filled double-circle",
  "◉": '"◉"',
  "▲": "filled triangle",
  "△": "open triangle",
};
const SIDELINE_STYLE: Record<string, string> = { single: "solid", double: "double", wave: "wavy", dotted: "dotted", dashed: "dashed" };

interface Chapter {
  id: string;
  title: string;
  /** 本文の HTML（ページ番号の参照は後で差し込む印 \u0001ref:名前\u0001 のまま）。 */
  body: string;
  bodyClass: string;
  hasSvg: boolean;
}

interface Heading {
  level: 1 | 2;
  text: string;
  file: string;
  id: string;
}

/** 文書を EPUB のファイルの一覧にする（mimetype が先頭）。 */
export function buildEpub(text: string, settings: Settings, images: DocImage[], now = new Date(), fonts: EpubFont[] = []): EpubFile[] {
  const vertical = !leftBound(settings);
  const opts = toParseOptions(settings);
  const tex = settings.format.markup === "tex" ? texToMarkup(text) : null;
  const formatted = horizontalPunctuation(formatText(tex ? tex.text : text, toFormatOptions(settings)).text, settings);
  const book = bookPageBlocks(settings.pages, settings.bookInfo, opts);
  const blocks = [...book.front, ...parse(formatted, opts), ...book.back];

  // 段落スタイル・文字スタイルは番号で CSS のクラスにする。
  const pIndex = new Map(settings.styles.paragraph.map((s, i) => [s.name, i]));
  const cIndex = new Map(settings.styles.character.map((s, i) => [s.name, i]));
  // 正規表現スタイル（段落スタイルの名前 → 規則）。紙面と同じ規則で、文字スタイルの span を付ける。
  const characterNames = new Set(cIndex.keys());
  const grepOf = new Map(settings.styles.paragraph.map((s) => [s.name, compileGrep(s.grep, characterNames)]));
  // ドロップキャップを使う段落スタイル。
  const dropCapStyles = new Set(settings.styles.paragraph.filter((s) => s.dropCap.lines >= 2).map((s) => s.name));
  const imageFile = new Map(images.map((img, i) => [img.name, `img${String(i + 1).padStart(3, "0")}.${img.mime === "image/png" ? "png" : "jpg"}`]));

  const chapters: Chapter[] = [];
  const headings: Heading[] = [];
  const labels = new Map<string, string>();
  let navAt: number | undefined;
  let html = "";
  let hasSvg = false;
  let bodyClass = "";
  let notes: string[] = [];
  let noteNo = 0;
  let headingNo = 0;
  const notesAtEnd = settings.notes.placement === "end";
  const endNotes: string[] = [];
  const fileName = (i: number) => `p${String(i + 1).padStart(3, "0")}.xhtml`;

  /** 今の XHTML を閉じる（中身がなければ何もしない）。 */
  const flush = () => {
    if (notes.length > 0) {
      html += `<aside class="notes">${notes.join("")}</aside>`;
      notes = [];
    }
    if (!html.trim()) {
      html = "";
      bodyClass = "";
      return;
    }
    const id = fileName(chapters.length);
    const title = headings.findLast((h) => h.file === id)?.text ?? settings.bookInfo.title ?? "";
    chapters.push({ id, title, body: html, bodyClass, hasSvg });
    html = "";
    hasSvg = false;
    bodyClass = "";
  };
  const currentFile = () => fileName(chapters.length);

  const cellHtml = (c: Cell): string => {
    if (c.math) {
      hasSvg = true;
      return mathSvg(c.text, c.math.display);
    }
    // 字形の候補（［＃字形：番号］）は、OpenType の aalt で選ぶ（読む側の書体にその候補があれば）。
    const text = c.alt ? `<span style="font-feature-settings:'aalt' ${c.alt}">${esc(c.text)}</span>` : esc(c.text);
    if (c.tcy && vertical) return `<span class="tcy">${text}</span>`;
    return text;
  };

  /**
   * 字の並びを HTML にする。paraStyle は段落スタイルの名前（正規表現スタイルを当てるため）。
   * EPUB では、正規表現スタイルは Atom ごとに当てる（ルビの親文字の一部だけが合ったときは、合った字のスタイルを親文字全体に）。
   */
  const atomsHtml = (atoms: Atom[], paraStyle?: string): string => {
    let out = "";
    let style: string | undefined;
    const rules = paraStyle ? grepOf.get(paraStyle) : undefined;
    const grep = rules ? grepCellStyles(atoms, rules) : undefined;
    for (const [ai, a] of atoms.entries()) {
      // 文字スタイルの切り替え。原稿で当てた文字スタイルが優先、なければ正規表現スタイル。
      const want = a.style && cIndex.has(a.style) ? a.style : (grep?.[ai].find((s) => s !== undefined) ?? a.style);
      if (want !== style) {
        if (style !== undefined && cIndex.has(style)) out += "</span>";
        style = want;
        if (style !== undefined && cIndex.has(style)) out += `<span class="cs${cIndex.get(style)}">`;
      }
      if (a.label) {
        labels.set(a.label, currentFile());
        out += `<span id="lb-${labelId(a.label)}"></span>`;
      }
      if (a.leader) continue;
      if (a.note) {
        noteNo++;
        const n = noteNo;
        const body = `<p id="note-${n}"><a href="${notesAtEnd ? currentFile() : ""}#noteref-${n}">注${n}</a>　${atomsHtml(a.note, NOTE_STYLE)}</p>`;
        out += `<a epub:type="noteref" class="noteref" id="noteref-${n}" href="${notesAtEnd ? "notes.xhtml" : ""}#note-${n}">注${n}</a>`;
        if (notesAtEnd) endNotes.push(`<aside epub:type="endnote" id="note-${n}">${body.replace(` id="note-${n}"`, "")}</aside>`);
        else notes.push(`<aside epub:type="footnote" id="note-${n}">${body.replace(` id="note-${n}"`, "")}</aside>`);
        continue;
      }
      if (a.pageRef) {
        out += `<a class="ref" href="\u0001ref:${esc(a.pageRef)}\u0001">→</a>`;
        continue;
      }
      if (a.warichu !== undefined) {
        out += `<span class="warichu">（${esc(a.warichu)}）</span>`;
        continue;
      }
      let inner = a.cells.map(cellHtml).join("");
      if (a.ruby) inner = `<ruby>${inner}<rt>${esc(a.ruby)}</rt></ruby>`;
      if (a.kenten) inner = `<span class="em" style="text-emphasis-style:${EMPHASIS[a.kenten] ?? "filled sesame"};-webkit-text-emphasis-style:${EMPHASIS[a.kenten] ?? "filled sesame"}">${inner}</span>`;
      if (a.sideline) inner = `<span class="sl" style="text-decoration-style:${SIDELINE_STYLE[a.sideline]}">${inner}</span>`;
      out += inner;
    }
    if (style !== undefined && cIndex.has(style)) out += "</span>";
    return out;
  };

  /** 段落に当たる段落スタイルの名前（行頭の［＃名前］がなければ fallback）。 */
  const paraName = (b: { style?: string }, fallback: string) => (b.style && pIndex.has(b.style) ? b.style : fallback);
  const paraClass = (b: { style?: string }, fallback: string) => `ps${pIndex.get(paraName(b, fallback)) ?? 0}`;

  const emit = (list: Block[]) => {
    for (const b of list) {
      switch (b.kind) {
        case "heading": {
          // 大見出しは新しい XHTML から。
          if (b.level === 1) flush();
          const id = `h${++headingNo}`;
          const t = plainText(b.atoms);
          headings.push({ level: b.level, text: t, file: currentFile(), id });
          const fallback = b.level === 1 ? "大見出し" : "中見出し";
          html += `<h${b.level} id="${id}" class="${paraClass(b, fallback)}">${atomsHtml(b.atoms, paraName(b, fallback))}</h${b.level}>`;
          break;
        }
        case "para": {
          const name = paraName(b, "本文");
          // ドロップキャップの段落は、頭の空白（字下げ）を落とす（最初の字が大きくなるように）。
          let start = 0;
          if (dropCapStyles.has(name)) while (start < b.atoms.length && b.atoms[start].cells.every((c) => /^\s*$/u.test(c.text))) start++;
          const atoms = b.atoms.slice(start);
          html += `<p class="${paraClass(b, "本文")}">${atoms.length > 0 ? atomsHtml(atoms, name) : "<br/>"}</p>`;
          break;
        }
        case "blank":
          html += `<p class="blank"><br/></p>`;
          break;
        case "pagebreak":
          flush();
          break;
        case "blankpage":
        case "pad":
        case "master":
          break;
        case "anchor":
          labels.set(b.name, currentFile());
          html += `<span id="lb-${labelId(b.name)}"></span>`;
          break;
        case "indexpage":
          // 索引（ページ番号を引くもの）は、ページのない EPUB には入れない。
          break;
        case "toc":
          // 目次のページ：nav の XHTML を本文の流れのこの場所に置く。
          flush();
          navAt = chapters.length;
          break;
        case "pagegroup":
        case "section":
          flush();
          bodyClass = `role-${b.role}`;
          emit(b.blocks);
          flush();
          break;
        case "image":
          if (b.mode === "full") flush();
          html += imageHtml(b);
          if (b.mode === "full") {
            bodyClass = "role-image";
            flush();
          }
          break;
        case "table":
          html += tableHtml(b);
          break;
      }
    }
  };

  const imageHtml = (b: ImageBlock): string => {
    const file = imageFile.get(b.name);
    if (!file) return `<p class="missing">［画像：${esc(b.name)}］</p>`;
    const caption = b.caption ? `<figcaption>${atomsHtml(b.caption.atoms, paraName(b.caption, CAPTION_STYLE))}</figcaption>` : "";
    const size = b.scale ? ` style="width:${Math.round(b.scale * 100)}%"` : "";
    return `<figure class="img-${b.mode}"><img src="../images/${file}" alt="${esc(b.caption ? plainText(b.caption.atoms) : b.name)}"${size}/>${caption}</figure>`;
  };

  const tableHtml = (t: TableBlock): string => {
    const count = Math.max(0, ...t.rows.map((r) => r.cells.length));
    const text = (r: number, c: number) => plainText(t.rows[r]?.cells[c]?.atoms ?? []).trim();
    // 欄のまとまり（「<」は左とつなぐ）と、上とつなぐ（「^」）欄の rowspan。
    type Group = { from: number; to: number; rowspan: number; up: boolean; atoms: Atom[] };
    const rows: Group[][] = t.rows.map((row, r) => {
      const out: Group[] = [];
      for (let c = 0; c < count; c++) {
        const s = text(r, c);
        if ((s === "<" || s === "＜") && out.length > 0) {
          out[out.length - 1].to = c + 1;
          continue;
        }
        out.push({ from: c, to: c + 1, rowspan: 1, up: s === "^" || s === "＾", atoms: row.cells[c]?.atoms ?? [] });
      }
      return out;
    });
    rows.forEach((gs, r) => {
      for (const g of gs) {
        if (!g.up) continue;
        for (let k = r - 1; k >= 0; k--) {
          const above = rows[k].find((x) => x.from === g.from);
          if (above && !above.up) {
            above.rowspan++;
            break;
          }
        }
      }
    });
    const align = (c: number) => (t.align?.[c] === "center" ? ' style="text-align:center"' : t.align?.[c] === "end" ? ' style="text-align:end"' : "");
    const body = rows
      .map((gs, r) => {
        const tag = r < t.header ? "th" : "td";
        const cells = gs
          .filter((g) => !g.up)
          .map((g) => `<${tag}${g.to - g.from > 1 ? ` colspan="${g.to - g.from}"` : ""}${g.rowspan > 1 ? ` rowspan="${g.rowspan}"` : ""}${align(g.from)}>${atomsHtml(g.atoms, r < t.header ? TABLE_HEADER_STYLE : TABLE_STYLE)}</${tag}>`)
          .join("");
        return `<tr>${cells}</tr>`;
      })
      .join("");
    return `<table class="rules-${t.rules ?? "all"}${t.headerDouble ? " header-double" : ""}">${body}</table>`;
  };

  emit(blocks);
  flush();
  if (notesAtEnd && endNotes.length > 0) {
    chapters.push({ id: "notes.xhtml", title: "注", body: `<h2 class="${paraClass({}, "注")}">注</h2>${endNotes.join("")}`, bodyClass: "", hasSvg: false });
  }

  // ページ番号の参照を、ラベルのある XHTML へのリンクにする。
  const resolve = (s: string) => s.replace(/\u0001ref:([^\u0001]*)\u0001/g, (_, name: string) => {
    const raw = name.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
    const file = labels.get(raw);
    return file ? `${file}#lb-${labelId(raw)}` : "#";
  });

  const lang = "ja";
  const title = settings.bookInfo.title || "無題";
  const htmlClass = vertical ? "vrtl" : "hltr";
  const page = (t: string, body: string, cls: string) =>
    `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${lang}" lang="${lang}" class="${htmlClass}">\n<head>\n<meta charset="UTF-8"/>\n<title>${esc(t)}</title>\n<link rel="stylesheet" type="text/css" href="../style.css"/>\n</head>\n<body${cls ? ` class="${cls}"` : ""}>\n<section>${body}</section>\n</body>\n</html>\n`;

  // 目次（nav）。大見出しの下に中見出しを入れ子にする。
  const navItems = (() => {
    let out = "";
    let open = false;
    for (const h of headings) {
      const link = `<a href="${h.file}#${h.id}">${esc(h.text)}</a>`;
      if (h.level === 1 || settings.toc.levels === 1) {
        if (h.level === 2) continue;
        if (open) out += "</ol></li>";
        out += `<li>${link}<ol>`;
        open = true;
      } else if (open) out += `<li>${link}</li>`;
      else out += `<li>${link}</li>`;
    }
    if (open) out += "</ol></li>";
    // 空の <ol></ol> は EPUB の決まりに反するので消す。
    return out.replace(/<ol><\/ol>/g, "");
  })();
  const navTitle = settings.toc.title || "目次";
  const nav = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${lang}" lang="${lang}" class="${htmlClass}">\n<head>\n<meta charset="UTF-8"/>\n<title>${esc(navTitle)}</title>\n<link rel="stylesheet" type="text/css" href="style.css"/>\n</head>\n<body class="role-toc">\n<nav epub:type="toc" id="toc">\n<h1>${esc(navTitle)}</h1>\n<ol>${navItems || `<li><a href="text/${chapters[0]?.id ?? "p001.xhtml"}">${esc(title)}</a></li>`}</ol>\n</nav>\n</body>\n</html>\n`.replace(/href="(p\d{3}\.xhtml|notes\.xhtml)/g, 'href="text/$1');

  // 表紙（表1の画像を選んでいれば）。
  const coverImage = settings.cover.frontImage ? images.find((i) => i.name === settings.cover.frontImage) : undefined;
  const files: EpubFile[] = [];
  const add = (name: string, data: string | Uint8Array) => files.push({ name, data: typeof data === "string" ? enc.encode(data) : data });
  add("mimetype", "application/epub+zip");
  add("META-INF/container.xml", `<?xml version="1.0" encoding="UTF-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n<rootfiles>\n<rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>\n</rootfiles>\n</container>\n`);
  add("OEBPS/style.css", css(settings, vertical, fonts));
  // 書体のファイルは、同じものを1つにまとめる（スタイルで同じ書体を何度使っても）。
  const fontFiles = [...new Map(fonts.map((f) => [f.file, f])).values()];
  for (const f of fontFiles) add(`OEBPS/fonts/${f.file}`, f.data);
  add("OEBPS/nav.xhtml", nav);
  for (const ch of chapters) add(`OEBPS/text/${ch.id}`, page(ch.title, resolve(ch.body), ch.bodyClass));
  if (coverImage) add("OEBPS/text/cover.xhtml", page(title, `<figure class="cover"><img src="../images/${imageFile.get(coverImage.name)}" alt="${esc(title)}"/></figure>`, "role-cover"));
  for (const img of images) add(`OEBPS/images/${imageFile.get(img.name)}`, Buffer.from(img.data, "base64"));

  const id = `urn:uuid:${uuidFrom(`${title}\u0000${settings.bookInfo.author}`)}`;
  const modified = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const manifest = [
    `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`,
    `<item id="css" href="style.css" media-type="text/css"/>`,
    ...(coverImage ? [`<item id="cover" href="text/cover.xhtml" media-type="application/xhtml+xml"/>`] : []),
    ...chapters.map((c, i) => `<item id="c${i + 1}" href="text/${c.id}" media-type="application/xhtml+xml"${c.hasSvg ? ' properties="svg"' : ""}/>`),
    ...images.map((img, i) => `<item id="i${i + 1}" href="images/${imageFile.get(img.name)}" media-type="${img.mime}"${img === coverImage ? ' properties="cover-image"' : ""}/>`),
    ...fontFiles.map((f, i) => `<item id="f${i + 1}" href="fonts/${f.file}" media-type="${f.mime}"/>`),
  ];
  const spine = chapters.map((_, i) => `<itemref idref="c${i + 1}"/>`);
  if (navAt !== undefined) spine.splice(navAt, 0, `<itemref idref="nav"/>`);
  if (coverImage) spine.unshift(`<itemref idref="cover"/>`);
  const info = settings.bookInfo;
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="${lang}">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="bookid">${id}</dc:identifier>
<dc:title>${esc(title)}</dc:title>
${info.author ? `<dc:creator>${esc(info.author)}</dc:creator>\n` : ""}${info.publisher ? `<dc:publisher>${esc(info.publisher)}</dc:publisher>\n` : ""}<dc:language>${lang}</dc:language>
<meta property="dcterms:modified">${modified}</meta>
${vertical ? `<meta name="primary-writing-mode" content="vertical-rl"/>\n` : ""}${coverImage ? `<meta name="cover" content="i${images.indexOf(coverImage) + 1}"/>\n` : ""}</metadata>
<manifest>
${manifest.join("\n")}
</manifest>
<spine${vertical ? ' page-progression-direction="rtl"' : ""}>
${spine.join("\n")}
</spine>
</package>
`;
  add("OEBPS/content.opf", opf);
  return files;
}

/** ラベルの名前を、XHTML の id に使える字にする。 */
function labelId(name: string): string {
  return createHash("sha1").update(name).digest("hex").slice(0, 12);
}

/** 書名と著者名から、書き出すたびに同じになる識別子（UUID の形）を作る。 */
function uuidFrom(seed: string): string {
  const h = createHash("sha1").update(seed).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function plainText(atoms: Atom[]): string {
  return atoms
    .filter((a) => !a.note && !a.leader && !a.pageRef)
    .map((a) => (a.warichu !== undefined ? `（${a.warichu}）` : a.cells.map((c) => c.text).join("")))
    .join("");
}

/** 数式を SVG にする（輪郭。em 単位で、文字の大きさについてくる）。 */
function mathSvg(tex: string, display: boolean): string {
  const box = renderMath(tex, display);
  if (box.error || box.paths.length === 0) return `<span class="math-error">${esc(tex)}</span>`;
  const h = box.height + box.depth;
  const paths = box.paths.map((p) => `<path transform="matrix(${p.m.map((v) => +v.toFixed(5)).join(" ")})" d="${p.d}"/>`).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 ${(-box.height).toFixed(4)} ${box.width.toFixed(4)} ${h.toFixed(4)}" style="width:${box.width.toFixed(3)}em;height:${h.toFixed(3)}em;vertical-align:${(-box.depth).toFixed(3)}em" fill="currentColor" role="img" aria-label="${esc(tex)}">${paths}</svg>`;
  return display ? `<span class="math-display">${svg}</span>` : `<span class="math">${svg}</span>`;
}

/** スタイルシート：組み方向、段落・文字スタイル、ルビ・圏点・縦中横・表・画像。 */
function css(settings: Settings, vertical: boolean, fonts: EpubFont[] = []): string {
  // 埋め込んだ書体。合成フォント（range つき）は、同じ名前で先に書いて、その字の範囲だけに当てる。
  const faces = [...fonts]
    .sort((a, b) => Number(!!b.range) - Number(!!a.range))
    .map((f) => `@font-face{font-family:"${fontFamily(f)}";src:url("fonts/${f.file}");${f.range ? `unicode-range:${f.range};` : ""}}`)
    .join("\n");
  const family = (role: "body" | "ps" | "cs", index?: number) =>
    fonts.some((f) => f.role === role && (role === "body" || f.index === index)) ? `"${fontFamily({ role, index })}",` : "";
  const lineHeight = settings.layoutMode === "book" ? settings.book.lineGapPercent / 100 : 1.75;
  const p = (s: ParagraphStyle, i: number) => {
    const rules = [
      s.scale !== 1 ? `font-size:${s.scale}em` : "",
      s.align === "center" ? "text-align:center" : s.align === "end" ? "text-align:end" : "",
      s.indent ? `padding-inline-start:${s.indent / s.scale}em` : "",
      s.spaceBefore ? `margin-block-start:${(s.spaceBefore * lineHeight) / s.scale}em` : "",
      s.spaceAfter ? `margin-block-end:${(s.spaceAfter * lineHeight) / s.scale}em` : "",
      s.color ? `color:${s.color}` : "",
      s.bold ? "font-weight:bold" : "",
      s.linePitch && s.linePitch !== 1 ? `line-height:${lineHeight * s.linePitch}` : "",
      family("ps", i) ? `font-family:${family("ps", i)}${family("body")}serif` : "",
      ...decorationCss(s),
    ].filter(Boolean);
    return `.ps${i}{${rules.join(";")}}${dropCapCss(s, i, settings.styles.character)}`;
  };
  const c = (s: CharacterStyle, i: number) => {
    const rules = [
      s.scale !== 1 ? `font-size:${s.scale}em` : "",
      s.color ? `color:${s.color}` : "",
      s.bold ? "font-weight:bold" : "",
      family("cs", i) ? `font-family:${family("cs", i)}${family("body")}serif` : "",
    ].filter(Boolean);
    return `.cs${i}{${rules.join(";")}}`;
  };
  const mode = vertical ? "vertical-rl" : "horizontal-tb";
  return `@charset "UTF-8";
${faces}
html{writing-mode:${mode};-webkit-writing-mode:${mode};-epub-writing-mode:${mode};}
body{margin:0;font-family:${family("body")}serif;line-height:${lineHeight};color:${settings.textColor};}
p,h1,h2{margin:0;text-indent:0;}
h1,h2{font-weight:normal;margin-block-start:1em;margin-block-end:1em;}
h1{font-size:1.3em;}
h2{font-size:1.15em;}
p.blank{min-height:1em;}
ruby rt{font-size:${settings.advanced.rubyPercent / 100}em;}
.em{-epub-text-emphasis-position:${vertical ? "right" : "over right"};text-emphasis-position:${vertical ? "over right" : "over right"};}
.sl{text-decoration-line:underline;-webkit-text-decoration-line:underline;text-underline-position:${vertical ? "right" : "under"};-epub-text-underline-position:${vertical ? "right" : "under"};}
.tcy{text-combine-upright:all;-webkit-text-combine:horizontal;-epub-text-combine:horizontal;}
.warichu{font-size:0.6em;}
.noteref{font-size:0.6em;text-decoration:none;}
aside.notes{margin-block-start:2em;font-size:0.85em;}
aside p{margin:0;}
a.ref{text-decoration:none;}
figure{margin:1em 0;text-align:center;}
figure img{max-width:100%;max-height:95vh;}
figcaption{font-size:0.8em;}
.role-image figure,.role-cover figure{margin:0;}
.role-image img,.role-cover img{width:100%;height:auto;max-height:100vh;}
.role-title{text-align:center;}
.role-title section{padding-block-start:4em;}
.role-colophon{font-size:0.9em;}
table{border-collapse:collapse;margin:1em 0;}
th,td{border:1px solid currentColor;padding:0.2em 0.5em;vertical-align:top;}
th{font-weight:bold;}
table.rules-none th,table.rules-none td{border:none;}
table.rules-rows th,table.rules-rows td{border-inline-start:none;border-inline-end:none;}
table.header-double tr:first-child th{border-block-end:3px double currentColor;}
.math-display{display:block;text-align:center;margin:0.5em 0;}
.math-error{color:#c00;}
nav ol{list-style:none;padding-inline-start:1em;}
nav li{margin:0;}
${settings.styles.paragraph.map(p).join("\n")}
${settings.styles.character.map(c).join("\n")}
`;
}

/**
 * 段落の罫線・囲み罫・網掛けの CSS。前の罫・後の罫は、組みの向きに合わせた border-block-start・end
 * （縦組みでは右と左）。囲み罫があるときは、前後の罫は囲み罫に含める（CSS では同じ辺に2本引けないため）。
 * 長さが「字のある所だけ」なら、段落の幅を字に合わせる。em は段落の字の大きさが基準なので、倍率で割る。
 */
function decorationCss(s: ParagraphStyle): string[] {
  const d = s.decoration;
  if (!hasDecoration(d)) return [];
  const em = (v: number) => `${Math.round((v / s.scale) * 1000) / 1000}em`;
  const line = (r: ParagraphRule) => `${r.width}pt ${r.kind} ${r.color ?? "currentColor"}`;
  const out: string[] = [];
  if (d.shading) out.push(`background-color:${d.shading}`);
  // 囲みの空きを先に書く（あとの前後の罫の空きで、その辺だけ上書きする）。
  if (d.shading || d.border.on) out.push(`padding:${em(d.pad)}`);
  if (d.border.on) out.push(`border:${line(d.border)}`);
  else {
    if (d.ruleBefore.on) out.push(`border-block-start:${line(d.ruleBefore)}`, `padding-block-start:${em(d.ruleBefore.gap)}`);
    if (d.ruleAfter.on) out.push(`border-block-end:${line(d.ruleAfter)}`, `padding-block-end:${em(d.ruleAfter.gap)}`);
  }
  if (d.length === "text") out.push("inline-size:fit-content");
  return out;
}

/**
 * ドロップキャップの CSS：段落の最初の字を initial-letter で大きくする（読む側が対応していれば）。
 * CSS では最初の1字だけなので、2字以上の指定でも EPUB では1字になる。文字スタイルの色・太字も当てる。
 */
function dropCapCss(s: ParagraphStyle, i: number, characters: CharacterStyle[]): string {
  if (s.dropCap.lines < 2) return "";
  const cs = characters.find((c) => c.name === s.dropCap.style);
  const rules = [`initial-letter:${s.dropCap.lines}`, `-webkit-initial-letter:${s.dropCap.lines}`, cs?.color ? `color:${cs.color}` : "", cs?.bold ? "font-weight:bold" : ""].filter(Boolean);
  return `
.ps${i}::first-letter{${rules.join(";")}}`;
}

/** EPUB のファイルを ZIP に書く（mimetype を先頭に、無圧縮で。EPUB の決まり）。 */
export function writeEpub(files: EpubFile[], add: (name: string, data: Uint8Array) => void): void {
  for (const f of files) add(f.name, f.data);
}
