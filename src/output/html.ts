import type { EpubFile } from "./epub.js";

// HTML の書き出し（#10）。EPUB の書き出し（buildEpub）で作った章ごとの XHTML・CSS・画像・書体を、ウェブで開ける形に組み直す。
// 中身（ルビ・圏点・傍線・縦中横・表・数式・注・相互参照のリンク・段落スタイル）は EPUB と同じ処理で作るので、ずれない。
// 形は2つ：
//   single   … 1つのファイル。CSS・画像・書体を中に入れる（ファイル1つで開ける・渡せる）。
//   chapters … フォルダ。目次（index.html）・章ごとの HTML・style.css・images・fonts。章の終わりに「前へ・目次・次へ」。

export type HtmlMode = "single" | "chapters";

export interface HtmlFile {
  /** フォルダの中の場所（single なら1つだけ）。 */
  name: string;
  data: Uint8Array;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** ウェブで読むための CSS（EPUB の CSS のあとに足す）。縦書きは、行の長さを窓の高さに合わせる。 */
const WEB_CSS = `
/* ウェブで読むとき */
body{box-sizing:border-box;margin:0 auto;padding:2em 1.5em;max-inline-size:42em;}
html.vrtl body{max-inline-size:none;block-size:100vh;inline-size:auto;padding:2em;}
img,svg{max-inline-size:100%;}
html.vrtl img{max-block-size:100%;}
section+section{margin-block-start:3em;}
nav.pager{display:flex;gap:1.5em;justify-content:center;margin-block-start:3em;font-size:0.9em;}
nav.pager a{text-decoration:none;}
`;

interface Doc {
  /** EPUB の中の場所（OEBPS/text/p001.xhtml など）。 */
  path: string;
  title: string;
  bodyClass: string;
  body: string;
}

/** XHTML を読む：題・body の class・body の中身。 */
function readXhtml(path: string, src: string): Doc {
  const title = /<title>([\s\S]*?)<\/title>/.exec(src)?.[1] ?? "";
  const m = /<body([^>]*)>([\s\S]*)<\/body>/.exec(src);
  const bodyClass = m ? (/class="([^"]*)"/.exec(m[1])?.[1] ?? "") : "";
  return { path, title, bodyClass, body: (m?.[2] ?? "").trim() };
}

/** EPUB だけの書き方を、HTML の書き方にする（注の印は ARIA の役割に）。 */
function toHtml(body: string): string {
  return body
    .replace(/ epub:type="(footnote|endnote|noteref|toc)"/g, (_, t: string) => ` role="doc-${t}"`)
    .replace(/ epub:type="[^"]*"/g, "");
}

/** 「../images/x.png」などの EPUB の中の場所を、OEBPS からの場所にする。 */
function resolvePath(from: string, href: string): string {
  const base = from.split("/").slice(0, -1);
  for (const part of href.split("/")) {
    if (part === "..") base.pop();
    else if (part !== ".") base.push(part);
  }
  return base.join("/");
}

const base64 = (data: Uint8Array) => Buffer.from(data).toString("base64");
const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", otf: "font/otf", ttf: "font/ttf", woff: "font/woff", woff2: "font/woff2" };
const mimeOf = (name: string) => MIME[name.split(".").pop()!.toLowerCase()] ?? "application/octet-stream";

export function buildHtml(epub: EpubFile[], mode: HtmlMode, name = "本"): HtmlFile[] {
  const files = new Map(epub.map((f) => [f.name, f.data]));
  const text = (p: string) => dec.decode(files.get(p) ?? new Uint8Array());
  // 読む順（spine）。
  const opf = text("OEBPS/content.opf");
  const hrefOf = new Map([...opf.matchAll(/<item id="([^"]+)" href="([^"]+)"/g)].map((m) => [m[1], `OEBPS/${m[2]}`]));
  const order = [...opf.matchAll(/<itemref idref="([^"]+)"/g)].map((m) => hrefOf.get(m[1])!).filter(Boolean);
  const docs = order.map((p) => readXhtml(p, text(p)));
  const navPath = "OEBPS/nav.xhtml";
  const nav = readXhtml(navPath, text(navPath));
  const htmlTag = /<html[^>]*class="([^"]*)"/.exec(text(order[0] ?? navPath))?.[1] ?? "";
  const lang = /<html[^>]*\blang="([^"]*)"/.exec(text(navPath))?.[1] ?? "ja";
  const bookTitle = /<dc:title>([\s\S]*?)<\/dc:title>/.exec(opf)?.[1] ?? esc(name);
  const css = text("OEBPS/style.css") + WEB_CSS;
  const page = (title: string, head: string, body: string, bodyClass: string) =>
    `<!DOCTYPE html>\n<html lang="${lang}" class="${htmlTag}">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${title}</title>\n${head}\n</head>\n<body${bodyClass ? ` class="${bodyClass}"` : ""}>\n${body}\n</body>\n</html>\n`;

  if (mode === "single") {
    // 1つのファイル：章は section に、章をまたぐリンク（p002.xhtml#x）はページの中のリンク（#x）にする。
    const anchorOf = (p: string) => `doc-${p.split("/").pop()!.replace(/\.xhtml$/, "")}`;
    const inline = (from: string, html: string) =>
      toHtml(html)
        .replace(/(src|href)="([^"#:]+\.(?:png|jpe?g))"/g, (_, attr: string, href: string) => {
          const data = files.get(resolvePath(from, href));
          return data ? `${attr}="data:${mimeOf(href)};base64,${base64(data)}"` : `${attr}="${href}"`;
        })
        .replace(/href="([^"#:]*\.xhtml)(#[^"]*)?"/g, (_, file: string, frag: string | undefined) => `href="${frag ?? `#${anchorOf(resolvePath(from, file))}`}"`);
    const sections = docs.map((d) => `<section id="${anchorOf(d.path)}"${d.bodyClass ? ` class="${d.bodyClass}"` : ""}>\n${inline(d.path, d.body)}\n</section>`);
    // 書体は、CSS の中に入れる。
    const styled = css.replace(/url\("fonts\/([^"]+)"\)/g, (m, f: string) => {
      const data = files.get(`OEBPS/fonts/${f}`);
      return data ? `url("data:${mimeOf(f)};base64,${base64(data)}")` : m;
    });
    return [{ name: `${name}.html`, data: enc.encode(page(bookTitle, `<style>\n${styled}\n</style>`, sections.join("\n"), "")) }];
  }

  // 章ごと：p001.xhtml → p001.html、目次は index.html。画像・書体・CSS はフォルダの頭に。
  const outName = (p: string) => (p === navPath ? "index.html" : `${p.split("/").pop()!.replace(/\.xhtml$/, "")}.html`);
  const rewrite = (from: string, html: string) =>
    toHtml(html)
      .replace(/(src|href)="([^"#:]+\.(?:png|jpe?g))"/g, (_, attr: string, href: string) => `${attr}="${resolvePath(from, href).replace(/^OEBPS\//, "")}"`)
      .replace(/href="([^"#:]*\.xhtml)(#[^"]*)?"/g, (_, file: string, frag: string | undefined) => `href="${outName(resolvePath(from, file))}${frag ?? ""}"`);
  const head = `<link rel="stylesheet" href="style.css">`;
  const out: HtmlFile[] = [{ name: "style.css", data: enc.encode(css) }];
  // 目次のページ：読む順の最初に表紙があれば、その下に目次。
  const cover = docs.find((d) => d.bodyClass.includes("role-cover"));
  const reading = docs.filter((d) => d !== cover && d.path !== navPath);
  const indexBody = `${cover ? `<section class="role-cover">${rewrite(cover.path, cover.body)}</section>\n` : ""}<h1 class="book-title">${bookTitle}</h1>\n${rewrite(navPath, nav.body)}${reading[0] ? `\n<nav class="pager"><a href="${outName(reading[0].path)}">読みはじめる</a></nav>` : ""}`;
  out.push({ name: "index.html", data: enc.encode(page(bookTitle, head, indexBody, "role-toc")) });
  reading.forEach((d, i) => {
    const prev = reading[i - 1];
    const next = reading[i + 1];
    const pager = `<nav class="pager">${prev ? `<a href="${outName(prev.path)}" rel="prev">前へ</a>` : ""}<a href="index.html">目次</a>${next ? `<a href="${outName(next.path)}" rel="next">次へ</a>` : ""}</nav>`;
    const title = d.title && d.title !== bookTitle ? `${d.title}｜${bookTitle}` : bookTitle;
    out.push({ name: outName(d.path), data: enc.encode(page(title, head, `<section>\n${rewrite(d.path, d.body)}\n</section>\n${pager}`, d.bodyClass)) });
  });
  for (const [p, data] of files) {
    if (p.startsWith("OEBPS/images/") || p.startsWith("OEBPS/fonts/")) out.push({ name: p.replace(/^OEBPS\//, ""), data });
  }
  return out;
}
