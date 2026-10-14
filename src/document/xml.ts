// 小さな XML の読み取り（IDML の読み込みに使う）。要素・属性・文字・処理命令（<?ACE 7?> など）だけを扱う。
// 名前空間は名前の一部として残す（idPkg:Story など）。DTD・実体の宣言は読まない（IDML では使わない）。

export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
}

/** 処理命令（InDesign は特別な字を <?ACE n?> で書く）。 */
export interface XmlInstruction {
  pi: string;
  body: string;
}

export type XmlNode = XmlElement | string | XmlInstruction;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** 文字の参照（&amp; &#x3042; など）を字にする。 */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

/** 文字を XML に書けるようにする（属性にも使える）。XML に書けない制御文字は除く。 */
export function escapeXml(s: string): string {
  return s
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** XML を読む。根の要素を返す。 */
export function parseXml(text: string): XmlElement {
  const root: XmlElement = { name: "#root", attrs: {}, children: [] };
  const stack: XmlElement[] = [root];
  let i = 0;
  const top = () => stack[stack.length - 1];
  while (i < text.length) {
    const lt = text.indexOf("<", i);
    if (lt < 0) {
      if (text.slice(i).trim()) top().children.push(decodeEntities(text.slice(i)));
      break;
    }
    if (lt > i) top().children.push(decodeEntities(text.slice(i, lt)));
    if (text.startsWith("<!--", lt)) {
      const e = text.indexOf("-->", lt);
      i = e < 0 ? text.length : e + 3;
      continue;
    }
    if (text.startsWith("<![CDATA[", lt)) {
      const e = text.indexOf("]]>", lt);
      top().children.push(text.slice(lt + 9, e < 0 ? text.length : e));
      i = e < 0 ? text.length : e + 3;
      continue;
    }
    if (text.startsWith("<?", lt)) {
      const e = text.indexOf("?>", lt);
      const body = text.slice(lt + 2, e < 0 ? text.length : e).trim();
      const sp = body.search(/\s/);
      const pi = sp < 0 ? body : body.slice(0, sp);
      if (pi !== "xml") top().children.push({ pi, body: sp < 0 ? "" : body.slice(sp + 1).trim() });
      i = e < 0 ? text.length : e + 2;
      continue;
    }
    if (text.startsWith("<!", lt)) {
      const e = text.indexOf(">", lt);
      i = e < 0 ? text.length : e + 1;
      continue;
    }
    if (text[lt + 1] === "/") {
      const e = text.indexOf(">", lt);
      if (stack.length > 1) stack.pop();
      i = e < 0 ? text.length : e + 1;
      continue;
    }
    // 開きタグ：名前と属性（属性の値の中の > に気を付けて、引用符を飛ばしながら終わりを探す）。
    let j = lt + 1;
    let quote = "";
    for (; j < text.length; j++) {
      const c = text[j];
      if (quote) {
        if (c === quote) quote = "";
      } else if (c === '"' || c === "'") quote = c;
      else if (c === ">") break;
    }
    const raw = text.slice(lt + 1, j);
    const selfClosing = raw.endsWith("/");
    const inner = selfClosing ? raw.slice(0, -1) : raw;
    const nameEnd = inner.search(/[\s/]|$/);
    const el: XmlElement = { name: inner.slice(0, nameEnd), attrs: {}, children: [] };
    for (const m of inner.slice(nameEnd).matchAll(/([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) el.attrs[m[1]] = decodeEntities(m[3] ?? m[4] ?? "");
    top().children.push(el);
    if (!selfClosing) stack.push(el);
    i = j + 1;
  }
  const first = root.children.find((c): c is XmlElement => typeof c === "object" && "name" in c);
  if (!first) throw new Error("XML の中身がありません。");
  return first;
}

/** 子の要素（名前が合うもの）。 */
export function childElements(el: XmlElement, name?: string): XmlElement[] {
  return el.children.filter((c): c is XmlElement => typeof c === "object" && "name" in c && (name === undefined || c.name === name));
}

/** 子孫の要素（名前が合うもの）を、出てくる順に。 */
export function findAll(el: XmlElement, name: string, out: XmlElement[] = []): XmlElement[] {
  for (const c of childElements(el)) {
    if (c.name === name) out.push(c);
    findAll(c, name, out);
  }
  return out;
}

/** 要素の中の文字（子孫も含む）。 */
export function textOf(el: XmlElement): string {
  return el.children.map((c) => (typeof c === "string" ? c : "name" in c ? textOf(c) : "")).join("");
}
