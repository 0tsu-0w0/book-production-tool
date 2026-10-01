import { isHangable, isLineEndProhibited, isLineStartProhibited } from "./kinsoku.js";
import { GRID_TYPOGRAPHY, punctClass } from "./spacing.js";
import { textBlocks, type TextBlock } from "./blocks.js";
import type { Atom, Block, Cell, ImageBlock, Kinsoku, LayoutSpec, PageLayout, PageRole, ParaFormat, PlacedGlyph, Rect, Shape, SideLine } from "./types.js";

export const MM = 72 / 25.4;
const EPS = 1e-6;

/** 参照元の「文字中」（36字×15行、行間1.67）に合わせた文庫の既定値。 */
export const DEFAULT_SPEC: LayoutSpec = {
  pageWidthMm: 105,
  pageHeightMm: 148,
  fontSizePt: 9.25,
  charsPerLine: 36,
  linesPerPage: 15,
  lineGap: 1.67,
  kinsoku: "strong",
  hanging: true,
  rubyScale: 0.5,
  headingBlankAfter: 0,
  columns: 1,
  columnGapPt: 0,
  margins: null,
  firstPageNumber: 1,
  chapterStartsOdd: false,
  typography: GRID_TYPOGRAPHY,
};

const HEADING_INDENT = { 1: 3, 2: 4 } as const;
/** ゴマ以外の圏点（丸・三角など）は、ルビの大きさの7割で置く（ゴマより字面が大きいため）。 */
const SMALL_MARK = 0.7;

export interface Line {
  atoms: Atom[];
  /** 行頭の空きマス数（見出しの字下げ）。 */
  indent: number;
  /** 見出しの1行目なら、その見出し（柱に使う）。 */
  heading?: { level: 1 | 2; text: string };
  /**
   * 行の長さを字数に合わせるための調整（em）。正なら字間を広げ（両端揃え）、
   * 負なら約物のアキを詰める（追い込み）。段落の最後の行は 0。
   */
  adjust?: number;
  /** 行頭の始め括弧を半角にした分（em）。 */
  headTrim?: number;
  /** 行取り（何行分の幅を取るか）。 */
  span?: number;
  /** 行の中での揃え。 */
  align?: "start" | "center" | "end";
  /** この行の字数（画像の回り込みで短くなった行）。 */
  limit?: number;
  /** 行頭をずらす字数（天に置いた画像の回り込み）。 */
  offset?: number;
  /** 段落の最初の行・最後の行。 */
  start?: boolean;
  end?: boolean;
  /** 原稿の行の番号（0始まり。原稿にない行は undefined）。 */
  srcLine?: number;
}

/** 行の文字列（ルビは除き、割注は含む）。 */
function lineText(line: Line): string {
  return line.atoms.map((a) => a.warichu ?? a.cells.map((c) => c.text).join("")).join("");
}

/** 見出しの文字列（ルビは除く）。 */
function plainText(atoms: Atom[]): string {
  return atoms.map((a) => a.cells.map((c) => c.text).join("")).join("");
}

interface BreakOptions {
  kinsoku: Kinsoku;
  hanging: boolean;
  /** 禁則で短くなった行を、字間を広げて字数に合わせる（両端揃え）。 */
  justify?: boolean;
  /** 行頭禁則の文字を、約物を詰めて前の行に入れる（追い込み）。 */
  oikomi?: boolean;
  /** 段落の途中の行頭に来た始め括弧を半角にする。 */
  lineHeadHalf?: boolean;
  /** 禁則に足す字。 */
  extraStart?: Set<string>;
  extraEnd?: Set<string>;
}

const startProhibited = (t: string, o: BreakOptions) => isLineStartProhibited(t, o.kinsoku) || (o.kinsoku !== "none" && !!o.extraStart?.has(t));
const endProhibited = (t: string, o: BreakOptions) => isLineEndProhibited(t, o.kinsoku) || (o.kinsoku !== "none" && !!o.extraEnd?.has(t));

function compressible(atoms: Atom[]): number {
  return atoms.reduce((s, a) => s + a.cells.reduce((t, c) => t + (c.compress ?? 0), 0), 0);
}

function advance(c: Cell): number {
  return c.advance ?? 1;
}

function atomWidth(a: Atom): number {
  return a.cells.reduce((sum, c) => sum + advance(c), 0);
}

function first(a: Atom): string {
  return a.cells[0].text;
}

function last(a: Atom): string {
  return a.cells[a.cells.length - 1].text;
}

/**
 * 1段落を行に分ける。入りきらないときは、禁則に触れない位置まで戻って改行する（追い出し）。
 * 行末の句読点は、はみ出させて同じ行に入れる（ぶら下げ）。長さは em 単位（全角1字 = 1）。
 */
/**
 * 1段落を行に分ける。長さは em 単位（全角1字 = 1）。
 * 入りきらないとき：
 * 1. 行末の句読点は、はみ出させて同じ行に入れる（ぶら下げ）。
 * 2. 行頭禁則の文字なら、行内の約物のアキを詰めて同じ行に入れる（追い込み。opts.oikomi のとき）。
 * 3. それもできなければ、禁則に触れない位置まで戻って改行する（追い出し）。
 * opts.justify のときは、追い出しで短くなった行を字数に合わせて広げる（両端揃え）。
 */
export function breakLines(atoms: Atom[], width: number | ((lineIndex: number) => number), indent: number, opts: BreakOptions): Line[] {
  const lines: Line[] = [];
  const queue = [...atoms];
  let cur: Atom[] = [];
  let used = indent;
  let headTrim = 0;
  // 行の字数。画像の回り込みでは、行ごとに短くなる。
  const widthAt = typeof width === "number" ? () => width : width;
  let perLine = widthAt(0);

  const push = (adjust: number) => {
    lines.push({ atoms: cur, indent, adjust, headTrim, limit: perLine });
    cur = [];
    used = indent;
    headTrim = 0;
    perLine = widthAt(lines.length);
  };
  const flush = (last = false) => {
    // 禁則で行を戻したあとは used が合わないので、行の中身から数え直す。
    const length = indent - headTrim + cur.reduce((s, a) => s + atomWidth(a), 0);
    push(!last && opts.justify && length < perLine - EPS ? perLine - length : 0);
  };

  while (queue.length > 0) {
    const a = queue[0];
    const w = atomWidth(a);

    // 段落の途中の行頭に来た始め括弧は、前のアキを取って半角にする（天付き）。
    if (cur.length === 0 && lines.length > 0 && opts.lineHeadHalf && headTrim === 0) {
      const c = a.cells[0];
      if (!c.tcy && punctClass(c.text) === "opening" && (c.compress ?? 0) >= 0.5) {
        headTrim = 0.5;
        used -= headTrim;
      }
    }

    if (used + w <= perLine + EPS) {
      cur.push(queue.shift()!);
      used += w;
      continue;
    }

    const lineFull = used >= perLine - EPS;
    if (opts.hanging && a.cells.length === 1 && w <= 1 + EPS && lineFull && cur.length > 0 && isHangable(first(a))) {
      cur.push(queue.shift()!);
      push(0);
      continue;
    }

    // 追い込み：行頭禁則の文字が次の行に出るなら、行内の約物のアキを詰めて、この行に入れる。
    if (opts.oikomi && cur.length > 0 && a.cells.length === 1 && startProhibited(first(a), opts)) {
      const need = used + w - perLine;
      if (need <= compressible([...cur, a]) + EPS) {
        cur.push(queue.shift()!);
        push(-need);
        continue;
      }
    }

    // 割注は行末で分けて、残りを次の行へ（それぞれの行で2行に組む）。
    if (a.warichu) {
      const unit = advance(a.cells[0]);
      const room = Math.floor((perLine - used) / unit + EPS);
      if (room >= 1 && room < a.cells.length) {
        queue.shift();
        const chars = [...a.warichu];
        queue.unshift({ ...a, warichu: chars.slice(0, room * 2).join(""), cells: a.cells.slice(0, room) }, { ...a, warichu: chars.slice(room * 2).join(""), cells: a.cells.slice(room, room + Math.ceil((chars.length - room * 2) / 2)) });
        continue;
      }
    }

    if (cur.length === 0) {
      // 1つの Atom が1行より長い（長いルビ、長い英単語など）。マスの境目で切るしかない。
      if (a.cells.length === 1) {
        cur.push(queue.shift()!);
        flush();
        continue;
      }
      const room = Math.min(Math.max(1, Math.floor(perLine - used + EPS)), a.cells.length - 1);
      queue.shift();
      queue.unshift({ ...a, cells: a.cells.slice(0, room) }, { cells: a.cells.slice(room) });
      continue;
    }

    // 追い出し：次の行頭が行頭禁則文字、またはこの行の行末が行末禁則文字なら、1つずつ次の行へ送る。
    let keep = cur.length;
    while (keep > 0) {
      const nextHead = keep < cur.length ? cur[keep] : a;
      // 注番号は、前の字から離して行頭に出さない。
      if (startProhibited(first(nextHead), opts) || (opts.kinsoku !== "none" && !!nextHead.note) || endProhibited(last(cur[keep - 1]), opts)) {
        keep--;
      } else {
        break;
      }
    }
    if (keep === 0) keep = cur.length; // どこで切っても禁則に触れる。禁則をあきらめて切る。
    queue.unshift(...cur.splice(keep));
    flush();
  }

  if (cur.length > 0 || lines.length === 0) flush(true);
  return lines;
}

/** ページの行：本文の行、空行（1行）、または数字（その行数分の空き。行送りを変えた段落の端数を埋める）。 */
type PageLine = Line | "blank" | number;

/** 行が使う行数（行取り・行送りを含む。端数もある）。空行は1行。 */
function slots(line: PageLine): number {
  return line === "blank" ? 1 : typeof line === "number" ? line : (line.span ?? 1);
}

/** 行数の足し算の誤差を丸める（行送りの端数を足していくと、整数からわずかにずれるため）。 */
const snap = (v: number) => Math.round(v * 1e6) / 1e6;

/** 原稿全体を行に分け、ページに割り付け、各文字の位置を決める。 */
export function layoutDocument(blocks: Block[], spec: LayoutSpec, lineOf?: number[]): PageLayout[] {
  // 横組みは、ページを転置した縦組みとして組み、最後に転置して戻す（toHorizontal）。
  // 画像の縦横も入れ替えておくと、戻したときに元の縦横比になる。
  if (spec.horizontal) {
    spec = {
      ...spec,
      pageWidthMm: spec.pageHeightMm,
      pageHeightMm: spec.pageWidthMm,
      images: Object.fromEntries(Object.entries(spec.images ?? {}).map(([k, v]) => [k, { width: v.height, height: v.width }])),
    };
  }
  // 今置いている段落の、原稿の行の番号。
  let srcLine: number | undefined;
  const jis = spec.typography.mode === "jis";
  const opts: BreakOptions = {
    kinsoku: spec.kinsoku,
    hanging: spec.hanging,
    // 横組みは、字の幅どおりの欧文が混ざっても行の終わりがそろうよう、両端揃えにする。
    justify: jis || !!spec.horizontal,
    oikomi: jis && spec.typography.oikomi,
    lineHeadHalf: jis && spec.typography.lineHeadBracket === "half",
    extraStart: new Set([...(spec.kinsokuExtra?.start ?? "")]),
    extraEnd: new Set([...(spec.kinsokuExtra?.end ?? "")]),
  };
  // 見出しは両端揃えにしない（字下げした短い行なので）。
  const headingOpts: BreakOptions = { ...opts, justify: false };
  // 1ページに入る行数は、1段の行数 × 段数。
  const capacity = spec.linesPerPage * spec.columns;
  const pages: PageLine[][] = [[]];
  const roles: PageRole[] = ["body"];
  let used = 0; // 今のページで使った行数（行取りを含む）
  // 流し込むページの種類（目次の中なら toc）。
  let flowRole: PageRole = "body";
  /** 扉・奥付・白ページなど、1ページで終わるページか（続きの行は次のページへ）。 */
  const fixed = (role: PageRole) => role !== "body" && role !== "toc";
  const current = () => pages[pages.length - 1];
  /** ページごとの画像（置く場所は placePage で決める）。 */
  const images: ImagePlacement[][] = [[]];
  // ページごとのマスターページの名前（空なら標準）と、いま使っているマスター。
  let currentMaster = "";
  const masters: string[] = [""];
  /** 本文を回り込ませている画像：このページの from〜to の行は chars 字だけ短くする。 */
  let wrap: { page: number; from: number; to: number; chars: number; top: boolean } | null = null;
  const newPage = (role: PageRole = flowRole) => {
    pages.push([]);
    roles.push(role);
    images.push([]);
    masters.push(currentMaster);
    used = 0;
  };
  /** 今のページに何か入っていれば、次のページへ進む。 */
  const breakPage = () => {
    if (current().length > 0 || fixed(roles[roles.length - 1])) newPage();
  };
  /** 今の段の残りを空ける（次の行は次の段の頭から）。 */
  const fillBand = () => {
    const inBand = snap(used % spec.linesPerPage);
    if (inBand === 0) return;
    const n = snap(Math.min(spec.linesPerPage - inBand, capacity - used));
    if (n <= 0) return;
    if (Number.isInteger(n)) for (let k = 0; k < n; k++) current().push("blank");
    else current().push(n);
    used = snap(used + n);
  };
  const pushLine = (line: PageLine) => {
    // 扉などのページのあとは、新しいページから続ける。
    if (fixed(roles[roles.length - 1])) newPage();
    const span = slots(line);
    // 行取り・行送りで幅の広い行が段の終わりをまたぐなら、次の段（またはページ）の頭へ送る。
    const inBand = snap(used % spec.linesPerPage);
    if (inBand > 0 && inBand + span > spec.linesPerPage + EPS) fillBand();
    if (used + span > capacity + EPS && used > 0) newPage();
    current().push(line);
    used = snap(used + span);
  };
  const isOdd = (pageIndex: number) => (spec.firstPageNumber + pageIndex) % 2 !== 0;
  /** 次の行を奇数ページから始める（偶数ページに当たるときは白ページを1枚入れる）。 */
  const startOdd = () => {
    breakPage();
    if (!isOdd(pages.length - 1)) {
      roles[roles.length - 1] = "blank";
      newPage();
    }
  };

  /** 段落を行に分ける（前後の空きを含む）。 */
  const paragraphLines = (
    block: TextBlock,
    breakOpts: BreakOptions,
    atPageTop: boolean,
    heading?: { level: 1 | 2; text: string },
    centerStart = false,
  ): PageLine[] => {
    const f: ParaFormat = block.format ?? {
      indent: block.kind === "heading" ? HEADING_INDENT[block.level] : 0,
      align: "start",
      lineSpan: 1,
      spaceBefore: 0,
      spaceAfter: 0,
    };
    const out: PageLine[] = [];
    // 前の空きは、ページの頭では取らない。
    if (!atPageTop) for (let i = 0; i < f.spaceBefore; i++) out.push("blank");
    // 回り込みの範囲に入る行は短くする（行が入る位置は、今の行数から数える）。
    const first = used + out.length;
    const page = pages.length - 1;
    const w = wrap;
    const span = f.lineSpan * (f.linePitch ?? 1);
    const inWrap = (i: number) => !!w && w.page === page && first + i * span >= w.from && first + i * span < w.to;
    const widthAt = (i: number) => (inWrap(i) ? spec.charsPerLine - w!.chars : spec.charsPerLine);
    // 扉では、天付きの段落を行の中央に置く。
    const align = centerStart && f.align === "start" ? "center" : f.align;
    // 中央・地付きの行は、両端揃えにしない。
    const lineOpts = align === "start" ? breakOpts : { ...breakOpts, justify: false };
    const broken = breakLines(block.atoms, w ? widthAt : spec.charsPerLine, align !== f.align ? 0 : f.indent, lineOpts);
    const count = broken.length;
    broken.forEach((line, i) => {
      if (w?.top && inWrap(i)) line.offset = w.chars;
      line.start = i === 0;
      line.end = i === count - 1;
      line.span = span;
      line.align = align;
      if (i === 0 && heading) line.heading = heading;
      line.srcLine = srcLine;
      out.push(line);
    });
    for (let i = 0; i < f.spaceAfter; i++) out.push("blank");
    return out;
  };
  const headingOf = (block: TextBlock) => (block.kind === "heading" ? { level: block.level, text: plainText(block.atoms) } : undefined);

  /** 扉・奥付など：1ページに収まれば、行の並びを中央か左端に寄せて置く。 */
  const placeGroup = (group: Extract<Block, { kind: "pagegroup" }>) => {
    if (spec.chapterStartsOdd && textBlocks(group.blocks).some((b) => b.kind === "heading" && b.level === 1)) startOdd();
    else breakPage();
    const lines: PageLine[] = [];
    for (const [k, b] of group.blocks.entries()) {
      srcLine = group.lines?.[k];
      if (b.kind === "blank") lines.push("blank");
      else if (b.kind === "para" || b.kind === "heading") {
        lines.push(...paragraphLines(b, b.kind === "heading" ? headingOpts : opts, lines.length === 0, headingOf(b), group.place === "center"));
      }
    }
    while (lines[0] === "blank") lines.shift();
    while (lines[lines.length - 1] === "blank") lines.pop();
    const total = lines.reduce<number>((s, l) => s + slots(l), 0);
    if (total > spec.linesPerPage) {
      // 1段に収まらなければ、ふつうの本文として流し込む。
      lines.forEach(pushLine);
      breakPage();
      return;
    }
    const free = spec.linesPerPage - total;
    const before = group.place === "center" ? Math.floor(free / 2) : free;
    const page = current();
    for (let i = 0; i < before; i++) page.push("blank");
    page.push(...lines);
    used = before + total;
    roles[roles.length - 1] = group.role;
  };

  const flow = (list: Block[], lines?: number[]) => {
  for (const [k, block] of list.entries()) {
    srcLine = lines?.[k];
    switch (block.kind) {
      case "pagebreak":
        if (block.odd) startOdd();
        else breakPage();
        break;
      case "blankpage":
        breakPage();
        roles[roles.length - 1] = "blank";
        break;
      case "master":
        // 今のページにまだ何もなければ、このページから。あれば次のページから。
        currentMaster = block.name;
        if (current().length === 0) masters[masters.length - 1] = currentMaster;
        break;
      case "pagegroup":
        placeGroup(block);
        break;
      case "pad": {
        breakPage();
        // 今の（空の）ページは数えない。
        const count = pages.length - 1;
        const extra = (block.multiple - ((count + block.reserve) % block.multiple)) % block.multiple;
        for (let i = 0; i < extra; i++) {
          roles[roles.length - 1] = "blank";
          newPage();
        }
        break;
      }
      case "blank":
        pushLine("blank");
        break;
      case "heading":
        // 改丁：大見出しは奇数ページから。
        if (block.level === 1 && spec.chapterStartsOdd) startOdd();
        pushParagraph(block, spec.headingBlankAfter);
        for (let i = 0; i < spec.headingBlankAfter; i++) pushLine("blank");
        break;
      case "para":
        pushParagraph(block);
        break;
      case "section": {
        // 目次など：新しいページから流し込み、そのページの種類を role にする。終わったら改ページ。
        breakPage();
        roles[roles.length - 1] = block.role;
        flowRole = block.role;
        flow(block.blocks);
        flowRole = "body";
        breakPage();
        break;
      }
      case "toc":
        // 目次を作る前の置き場所（組版の前に置き換える）。
        break;
      case "image":
        placeImage(block);
        break;
    }
  }
  };
  flow(blocks, lineOf);

  /** 画像を置く。全面・版面は1ページ。行の中なら、その行数を取る（回り込みなら本文を短くして続ける）。 */
  function placeImage(block: ImageBlock) {
    if (block.mode !== "lines") {
      breakPage();
      // 偶数・奇数ページの指定：合わなければ白ページを1枚入れる。
      if (block.parity && isOdd(pages.length - 1) !== (block.parity === "odd")) {
        roles[roles.length - 1] = "blank";
        newPage();
      }
      roles[roles.length - 1] = "image";
      // 全面の画像にはキャプションを付けない（置く余白がない）。
      const captionLines = block.mode === "block" ? captionOf(block, spec.charsPerLine) : undefined;
      images[images.length - 1].push({ block, slot: 0, captionLines });
      return;
    }
    const n = Math.min(block.lines, spec.linesPerPage);
    if (fixed(roles[roles.length - 1])) newPage();
    // 画像の行は段をまたがない。段の残りが足りなければ、次の段（またはページ）の頭へ。
    const inBand = snap(used % spec.linesPerPage);
    if (inBand > 0 && inBand + n > spec.linesPerPage + EPS) fillBand();
    if (used + n > capacity + EPS && used > 0) newPage();
    // キャプションは画像の高さに収め、取った行の最後の1〜2行に置く。
    let captionLines = block.caption && n >= 2 ? captionOf(block, Math.floor(imageGeometry(block, spec, 1).height / spec.fontSizePt)) : undefined;
    if (captionLines && captionLines.length > 1) {
      captionLines = captionOf(block, Math.floor(imageGeometry(block, spec, Math.min(2, n - 1)).height / spec.fontSizePt))?.slice(0, Math.min(2, n - 1));
    }
    const geo = imageGeometry(block, spec, captionLines?.length ?? 0);
    images[images.length - 1].push({ block, slot: used, captionLines });
    if (block.wrap && geo.wrapChars > 0) {
      wrap = { page: pages.length - 1, from: used, to: used + n, chars: geo.wrapChars, top: block.position === "top" };
    } else {
      for (let k = 0; k < n; k++) {
        current().push("blank");
        used++;
      }
    }
  }

  /** キャプションを行に分ける（長さは perLine 字分。行は3行まで）。 */
  function captionOf(block: ImageBlock, perLine: number): Line[] | undefined {
    if (!block.caption || block.caption.atoms.length === 0) return undefined;
    const lines = breakLines(block.caption.atoms, Math.max(4, perLine), 0, { ...opts, justify: false }).slice(0, 3);
    lines.forEach((l, i) => {
      l.start = i === 0;
      l.end = i === lines.length - 1;
      l.srcLine = srcLine;
    });
    return lines;
  }

  /** 今の段に残っている行数（次に新しいページや段になるなら、1段まるごと）。 */
  function roomInBand(): number {
    if (fixed(roles[roles.length - 1]) || used >= capacity - EPS) return spec.linesPerPage;
    return snap(spec.linesPerPage - (used % spec.linesPerPage));
  }

  /** 今の段の残りを空けて、次の段（またはページ）から続ける。 */
  function breakBand() {
    if (fixed(roles[roles.length - 1])) return;
    fillBand();
  }

  /**
   * 段落を置く。after は段落のあとに続けて入れる空行の数（見出しの後の空行）。
   * 次の行と離さない段落（見出し）は、あとに1行も入らないなら次の段へ送る。
   * 孤立行を避ける段落は、1行目だけが段の最後に残るなら段落ごと、最後の1行だけが次に行くなら2行を次へ送る。
   */
  function pushParagraph(block: TextBlock, after = 0) {
    const atTop = used === 0 || fixed(roles[roles.length - 1]);
    const all = paragraphLines(block, block.kind === "heading" ? headingOpts : opts, atTop, headingOf(block));
    const f = block.format;
    let lead = 0;
    while (all[lead] === "blank") lead++;
    let tail = all.length;
    while (tail > lead && all[tail - 1] === "blank") tail--;
    const text = all.slice(lead, tail);
    all.slice(0, lead).forEach(pushLine);
    const textSlots = text.reduce<number>((s, l) => s + slots(l), 0);
    if (f?.keepWithNext) {
      const room = roomInBand();
      if (room < spec.linesPerPage && room < textSlots + (all.length - tail) + after + 1) breakBand();
    }
    if (f?.keepLines && text.length >= 2) {
      // 段の残りに入る行数（行取り・行送りで1行の幅が違っても、段落の中では同じ）。
      const per = textSlots / text.length;
      const room = Math.floor(roomInBand() / per + EPS);
      if (room < text.length) {
        if (room <= 1) {
          breakBand();
        } else if (text.length - room === 1) {
          text.slice(0, room - 1).forEach(pushLine);
          breakBand();
          text.slice(room - 1).forEach(pushLine);
          all.slice(tail).forEach(pushLine);
          return;
        }
      }
    }
    text.forEach(pushLine);
    all.slice(tail).forEach(pushLine);
  }

  // 最後に残った空のページ（改ページのあとなど）は捨てる。
  if (pages.length > 1 && current().length === 0 && !fixed(roles[roles.length - 1])) {
    pages.pop();
    roles.pop();
    images.pop();
    masters.pop();
  }
  return pages.map((lines, i) => {
    const page = placePage(lines, i, spec, roles[i], images[i]);
    if (masters[i]) page.master = masters[i];
    return page;
  });
}

interface ImagePlacement {
  block: ImageBlock;
  /** 行の中に置くとき、最初の行の位置（ページの頭からの行数）。 */
  slot: number;
  /** キャプションの行。 */
  captionLines?: Line[];
}

/** 画像の縦横比が分からないとき（画像が見つからないとき）の比。 */
const FALLBACK_IMAGE = { width: 4, height: 3 };

/**
 * 行の中に置く画像の大きさ（pt）と、回り込ませる字数。幅は取った行の幅に合わせ、高さは縦横比から。
 * 段の高さを超えるなら、高さに合わせて小さくする。回り込みは画像の高さ＋1字分。
 */
export function imageGeometry(block: ImageBlock, spec: LayoutSpec, captionLines = 0): { width: number; height: number; wrapChars: number } {
  const size = spec.fontSizePt;
  const pitch = size * spec.lineGap;
  const info = croppedSize(spec.images?.[block.name] ?? FALLBACK_IMAGE, block.crop);
  const ratio = info.height / info.width;
  const columnHeight = spec.charsPerLine * size;
  // キャプションの行の分だけ、画像に使う行を減らす。
  const n = Math.max(1, Math.min(block.lines, spec.linesPerPage) - captionLines);
  let width = (n - 1) * pitch + size;
  let height = block.fill ? columnHeight : width * ratio;
  if (height > columnHeight) {
    height = columnHeight;
    width = height / ratio;
  }
  if (block.scale) {
    width *= block.scale;
    height *= block.scale;
  }
  const wrapChars = Math.ceil(height / size - EPS) + Math.round(spec.wrapGapChars ?? 1);
  // 回り込ませても数字しか残らないような短い行になるなら、回り込ませない。
  return { width, height, wrapChars: block.wrap && wrapChars <= spec.charsPerLine - 4 ? wrapChars : 0 };
}

function placePage(lines: PageLine[], index: number, spec: LayoutSpec, role: PageRole = "body", pageImages: ImagePlacement[] = []): PageLayout {
  const width = spec.pageWidthMm * MM;
  const height = spec.pageHeightMm * MM;
  const size = spec.fontSizePt;
  const pitch = size * spec.lineGap;
  const rubySize = size * spec.rubyScale;

  // 版面：横幅は1段の行数で、高さは段数と段間で決まる。
  const columnHeight = spec.charsPerLine * size;
  const blockWidth = (spec.linesPerPage - 1) * pitch + size;
  const blockHeight = spec.columns * columnHeight + (spec.columns - 1) * spec.columnGapPt;
  let left: number;
  let top: number;
  if (spec.horizontal) {
    // 横組み（左綴じ）：実際のページ（幅 height・高さ width）で版面を決めてから、転置した座標に直す。
    // 奇数ページは右ページで左側が、偶数ページは左ページで右側がノド。
    const realWidth = height;
    const realHeight = width;
    const realBlockWidth = blockHeight;
    const realBlockHeight = blockWidth;
    let realLeft: number;
    let realTop: number;
    if (spec.margins) {
      const gutter = spec.margins.gutterMm * MM;
      const oddPage = (spec.firstPageNumber + index) % 2 !== 0;
      realLeft = oddPage ? gutter : realWidth - gutter - realBlockWidth;
      realTop = spec.margins.topMm * MM;
    } else {
      realLeft = (realWidth - realBlockWidth) / 2;
      realTop = (realHeight - realBlockHeight) / 2;
    }
    left = width - (realTop + realBlockHeight);
    top = realLeft;
  } else if (spec.margins) {
    // 右綴じの本：奇数ページ（左ページ）は右側が、偶数ページ（右ページ）は左側がノド。
    const gutter = spec.margins.gutterMm * MM;
    const oddPage = (spec.firstPageNumber + index) % 2 !== 0;
    left = oddPage ? width - gutter - blockWidth : gutter;
    top = spec.margins.topMm * MM;
  } else {
    left = (width - blockWidth) / 2;
    top = (height - blockHeight) / 2;
  }
  const right = left + blockWidth;

  const glyphs: PlacedGlyph[] = [];
  const lineShapes: Shape[] = [];
  let slot = 0;
  for (const line of lines) {
    const span = slots(line);
    if (typeof line === "object") {
      // 行取りの行は、取った行の中央に置く。
      const band = Math.floor(slot / spec.linesPerPage);
      const col = (slot % spec.linesPerPage) + (span - 1) / 2;
      const x = right - size / 2 - col * pitch;
      const bandTop = top + band * (columnHeight + spec.columnGapPt);
      placeLine(glyphs, line, x, bandTop, size, rubySize, spec.charsPerLine, lineShapes, !!spec.horizontal);
    }
    slot = snap(slot + span);
  }

  // 画像と、そのキャプション。
  const imageShapes: Shape[] = [];
  for (const p of pageImages) {
    const placed = imageShape(p, spec, { left, top, width: blockWidth, height: blockHeight }, width, height);
    imageShapes.push(placed.shape);
    if (p.captionLines) placeCaption(glyphs, lineShapes, p.captionLines, placed.visible, spec);
  }

  let lineTexts: PageLayout["lines"] | undefined;
  const page: PageLayout = {
    index,
    width,
    height,
    block: { left, top, width: blockWidth, height: blockHeight },
    lineCount: slot,
    role: lines.length === 0 && role === "body" ? "blank" : role,
    headings: lines.flatMap((l) => (typeof l === "object" && l.heading ? [l.heading] : [])),
    // 行の文字（校正の補助で使う）は、頼まれたときに作る。
    get lines() {
      return (lineTexts ??= lines.flatMap((l) => (typeof l !== "object" ? [] : [{ text: lineText(l), start: !!l.start, end: !!l.end }])));
    },
    glyphs,
    shapes: [...imageShapes, ...lineShapes],
    paper: "#ffffff",
  };
  return spec.horizontal ? toHorizontal(page) : page;
}

/**
 * 転置した縦組みのページを、横組みのページに戻す。縦組みの行の方向（下へ）が横組みの字の方向（右へ）に、
 * 縦組みの行の進み（左へ）が横組みの行の進み（下へ）になる：(x, y) → (y, W − x)。W は転置したページの幅。
 * ルビ・圏点（縦組みでは字の右）は字の上に、割注の右の行は上の行になる。
 */
function toHorizontal(p: PageLayout): PageLayout {
  const W = p.width;
  const pt = (x: number, y: number) => ({ x: y, y: W - x });
  const rect = (r: { x: number; y: number; w: number; h: number }) => ({ x: r.y, y: W - (r.x + r.w), w: r.h, h: r.w });
  return {
    ...p,
    width: p.height,
    height: p.width,
    block: { left: p.block.top, top: W - (p.block.left + p.block.width), width: p.block.height, height: p.block.width },
    glyphs: p.glyphs.map((g): PlacedGlyph => {
      if (g.kind === "mark") return { ...g, kind: "hmark", ...pt(g.x, g.y) };
      if (g.kind === "math") return { ...g, kind: "hmath", ...pt(g.x, g.y) };
      // vert・tcy は x がマスの中心で y がマスの上端、rot は x が行の中心で y が上端。どれも「行の中心」と「マスの始まり」。
      return { ...g, kind: "hcell", ...(g.kind === "tcy" ? { fit: true } : {}), ...pt(g.x, g.y) };
    }),
    shapes: p.shapes.map((s): Shape => {
      switch (s.kind) {
        case "line":
          return { ...s, x1: s.y1, y1: W - s.x1, x2: s.y2, y2: W - s.x2 };
        case "image":
          return { ...s, ...rect(s), ...(s.clip ? { clip: rect(s.clip) } : {}) };
        case "rect":
          return { ...s, ...rect(s) };
        case "circle":
        case "diamond":
          return { ...s, cx: s.cy, cy: W - s.cx };
        case "path":
          return s;
      }
    }),
  };
}

/**
 * 1行の文字を置く。行の調整（adjust）が負なら約物のアキを詰め（追い込み）、
 * 正なら字間に均等に配る（両端揃え）。行頭の始め括弧を半角にした分（headTrim）は、書き出しを上げて表す。
 * 中央・地付きの行は、行の長さに合わせて書き出しを下げる。文字スタイルの大きさ・書体・太さ・色もここで渡す。
 */
function placeLine(
  glyphs: PlacedGlyph[],
  line: Line,
  x: number,
  bandTop: number,
  size: number,
  rubySize: number,
  perLine: number,
  shapes: Shape[] = [],
  horizontal = false,
): void {
  const sideRuns: SideRun[] = [];
  perLine = line.limit ?? perLine;
  line = fillLeader(line, perLine);
  const cells = line.atoms.flatMap((a) => a.cells);
  const adjust = line.adjust ?? 0;
  const totalCompress = compressible(line.atoms);
  const shrinkRatio = adjust < 0 && totalCompress > 0 ? Math.min(1, -adjust / totalCompress) : 0;
  // 両端揃えの空きは、まず語間（半角の空白）に1つ0.5emまで配り、残りを字間に均等に配る（欧文の行が字間で広がりすぎないように）。
  const spaces = adjust > 0 ? cells.filter((c) => c.text === " ").length : 0;
  const spaceExtra = spaces > 0 ? Math.min(adjust / spaces, 0.5) : 0;
  const rest = adjust - spaceExtra * spaces;
  const extraPerGap = rest > EPS && cells.length > 1 ? rest / (cells.length - 1) : 0;
  const gapAfter = (cell: Cell) => extraPerGap + (cell.text === " " ? spaceExtra : 0);

  let offset = line.indent - (line.headTrim ?? 0);
  if (line.align === "center" || line.align === "end") {
    const length = cells.reduce((s, c) => s + advance(c), 0);
    offset = line.align === "center" ? line.indent + (perLine - line.indent - length) / 2 : perLine - length;
  }
  offset += line.offset ?? 0;
  let index = 0;
  for (const atom of line.atoms) {
    const spanStart = offset;
    let spanEnd = offset;
    if (atom.warichu !== undefined) {
      // 割注：前半を右の行、後半を左の行に、半分の大きさで上から並べる。
      const chars = [...atom.warichu];
      const half = atom.cells.length;
      const cell = atom.cells[0];
      const scale = cell.scale ?? 1;
      const small = (size * scale) / 2;
      chars.forEach((ch, k) => {
        const col = k < half ? 1 : -1;
        const j = k < half ? k : k - half;
        glyphs.push({ text: ch, kind: "vert", x: x + (col * small) / 2, y: bandTop + offset * size + j * small, size: small, font: cell.font, bold: cell.bold, color: cell.color });
      });
      for (const c of atom.cells) {
        offset += advance(c);
        if (index < cells.length - 1) offset += gapAfter(c);
        index++;
      }
      continue;
    }
    for (const cell of atom.cells) {
      let adv = advance(cell);
      let shift = cell.shift ?? 0;
      if (shrinkRatio > 0 && cell.compress) {
        const s = cell.compress * shrinkRatio;
        adv -= s;
        if (cell.compressFromStart) shift -= s;
      }
      const scale = cell.scale ?? 1;
      const y = bandTop + (offset + shift) * size;
      const kind = cell.math ? "math" : cell.rotate ? "rot" : cell.tcy ? "tcy" : "vert";
      // 1字ごとに作るので、使わない項目のための一時的なオブジェクトを作らない（組み直しを速くするため）。
      const g: PlacedGlyph = { text: cell.text, kind, x, y, size: size * scale, font: cell.font, bold: cell.bold, color: cell.color };
      if (cell.features) g.features = cell.features;
      if (cell.math) {
        if (cell.math.display) g.display = true;
        if (cell.math.pad !== undefined) g.pad = cell.math.pad;
      }
      if (line.srcLine !== undefined && cell.src !== undefined) g.src = [line.srcLine, cell.src];
      glyphs.push(g);
      if (atom.kenten) {
        const rs = rubySize * scale;
        const ms = atom.kenten === "﹅" || atom.kenten === "﹆" ? rs : rs * SMALL_MARK;
        glyphs.push({ text: atom.kenten, kind: "mark", x: x + (size * scale) / 2 + rs / 2, y: y + (size * scale) / 2, size: ms, font: cell.font, color: cell.color });
      }
      if (atom.sideline) sideRuns.push({ kind: atom.sideline, x: x + (size * scale) / 2, from: y, to: y + adv * size, color: cell.color ?? "", size });
      offset += adv;
      spanEnd = offset;
      if (index < cells.length - 1) offset += gapAfter(cell);
      index++;
    }
    if (atom.ruby) {
      const first = atom.cells[0];
      const scale = first.scale ?? 1;
      const rs = rubySize * scale;
      const spanTop = bandTop + spanStart * size;
      placeRuby(glyphs, atom.ruby, x + (size * scale) / 2 + rs / 2, spanTop, (spanEnd - spanStart) * size, rs, (atom.rubyBefore ?? 0) * size, first);
    }
  }
  shapes.push(...sideLineShapes(sideRuns, horizontal));
}

/** 画像を置く場所。全面は塗り足し（3mm）まで覆って切り、版面は版面に収め、行の中は取った行に置く。 */
/** 切り抜いたあとの画像の大きさ。 */
function croppedSize(info: { width: number; height: number }, crop: ImageBlock["crop"]): { width: number; height: number } {
  if (!crop) return info;
  return { width: info.width * (1 - crop.left - crop.right), height: info.height * (1 - crop.top - crop.bottom) };
}

type Frame = { x: number; y: number; w: number; h: number };

/**
 * 枠に画像を置く。cover なら枠いっぱいに広げてはみ出た分を、切り抜きがあれば切った分を、枠（clip）で隠す。
 * 返すのは画像の図形と、見えている範囲。
 */
function frameImage(name: string, info: { width: number; height: number }, box: Frame, cover: boolean, block: ImageBlock): { shape: Shape; visible: Frame } {
  const crop = block.crop ?? { top: 0, right: 0, bottom: 0, left: 0 };
  const c = croppedSize(info, block.crop);
  const s = (cover ? Math.max(box.w / c.width, box.h / c.height) : Math.min(box.w / c.width, box.h / c.height)) * (cover ? 1 : (block.scale ?? 1));
  const vw = c.width * s;
  const vh = c.height * s;
  const vx = box.x + (box.w - vw) / 2;
  const vy = box.y + (box.h - vh) / 2;
  const visible = cover ? { ...box } : { x: vx, y: vy, w: vw, h: vh };
  const shape: Shape = {
    kind: "image",
    name,
    x: vx - crop.left * info.width * s,
    y: vy - crop.top * info.height * s,
    w: info.width * s,
    h: info.height * s,
    ...(cover || block.crop ? { clip: visible } : {}),
  };
  return { shape, visible };
}

/** 位置の微調整（仕上がりのページで右・下が正、mm）を、組むときの座標（横組みでは転置した座標）でずらす。 */
function shiftImage(placed: { shape: Shape; visible: Frame }, block: ImageBlock, horizontal: boolean) {
  if (!block.shift || placed.shape.kind !== "image") return;
  const dx = (horizontal ? -block.shift.y : block.shift.x) * MM;
  const dy = (horizontal ? block.shift.x : block.shift.y) * MM;
  const s = placed.shape;
  s.x += dx;
  s.y += dy;
  if (s.clip) s.clip = { ...s.clip, x: s.clip.x + dx, y: s.clip.y + dy };
  placed.visible = { ...placed.visible, x: placed.visible.x + dx, y: placed.visible.y + dy };
}

/** キャプションの行の間隔と、画像との間（本文の文字の大きさに対する割合）。 */
const CAPTION_PITCH = 1.3;
const CAPTION_GAP = 0.5;

function imageShape(p: ImagePlacement, spec: LayoutSpec, block: Rect, pageWidth: number, pageHeight: number): { shape: Shape; visible: Frame } {
  const info = spec.images?.[p.block.name] ?? FALLBACK_IMAGE;
  const name = p.block.name;
  const size = spec.fontSizePt;
  let placed: { shape: Shape; visible: Frame };
  if (p.block.mode === "full") {
    const bleed = (spec.bleedMm ?? 3) * MM;
    placed = frameImage(name, info, { x: -bleed, y: -bleed, w: pageWidth + bleed * 2, h: pageHeight + bleed * 2 }, true, p.block);
  } else if (p.block.mode === "block") {
    // キャプションの分だけ、版面の左（横組みでは下）を空ける。
    const reserve = p.captionLines?.length ? size * (CAPTION_GAP + CAPTION_PITCH * p.captionLines.length) : 0;
    const box = { x: block.left + reserve, y: block.top, w: block.width - reserve, h: block.height };
    if (p.block.fill && p.block.scale) {
      const k = p.block.scale;
      Object.assign(box, { x: box.x + (box.w * (1 - k)) / 2, y: box.y + (box.h * (1 - k)) / 2, w: box.w * k, h: box.h * k });
    }
    placed = frameImage(name, info, box, !!p.block.fill, p.block);
  } else {
    const pitch = size * spec.lineGap;
    const columnHeight = spec.charsPerLine * size;
    const k = p.captionLines?.length ?? 0;
    const n = Math.max(1, Math.min(p.block.lines, spec.linesPerPage) - k);
    const g = imageGeometry(p.block, spec, k);
    const band = Math.floor(p.slot / spec.linesPerPage);
    const col = p.slot % spec.linesPerPage;
    // 取った行の右端（最初の行の字の右端）から、n 行分の字の幅。その中央に置く。
    const regionRight = block.left + block.width - col * pitch;
    const regionWidth = (n - 1) * pitch + size;
    const bandTop = block.top + band * (columnHeight + spec.columnGapPt);
    const y = p.block.position === "top" ? bandTop : p.block.position === "bottom" ? bandTop + columnHeight - g.height : bandTop + (columnHeight - g.height) / 2;
    const box = { x: regionRight - regionWidth / 2 - g.width / 2, y, w: g.width, h: g.height };
    placed = frameImage(name, info, box, !!p.block.fill, { ...p.block, scale: 1 });
  }
  shiftImage(placed, p.block, !!spec.horizontal);
  return placed;
}

/** キャプションを画像の左（横組みでは下）に、画像の上端（横組みでは左端）から置く。 */
function placeCaption(glyphs: PlacedGlyph[], shapes: Shape[], lines: Line[], visible: Frame, spec: LayoutSpec) {
  const size = spec.fontSizePt;
  lines.forEach((line, i) => {
    const x = visible.x - size * CAPTION_GAP - size / 2 - i * size * CAPTION_PITCH;
    placeLine(glyphs, line, x, visible.y, size, size * spec.rubyScale, Math.floor(visible.h / size) || spec.charsPerLine, shapes, !!spec.horizontal);
  });
}

interface SideRun {
  kind: SideLine;
  /** 字の右端。 */
  x: number;
  from: number;
  to: number;
  color: string;
  size: number;
}

/** 傍線：続く字の同じ種類の線を1本にまとめ、字の右に引く。 */
function sideLineShapes(runs: SideRun[], horizontal = false): Shape[] {
  const merged: SideRun[] = [];
  for (const r of runs) {
    const prev = merged[merged.length - 1];
    if (prev && prev.kind === r.kind && prev.color === r.color && Math.abs(prev.x - r.x) < EPS && Math.abs(prev.to - r.from) < r.size * 0.6) {
      prev.to = r.to;
    } else {
      merged.push({ ...r });
    }
  }
  const out: Shape[] = [];
  for (const r of merged) {
    const w = r.size * 0.05;
    // 縦組みは字の右、横組みは字の下（転置する前の、字の左）に引く。
    const x = horizontal ? r.x - r.size - r.size * 0.12 : r.x + r.size * 0.12;
    const line = (dx: number, dash?: number[]): Shape => ({ kind: "line", x1: x + dx, y1: r.from, x2: x + dx, y2: r.to, width: w, color: r.color, ...(dash ? { dash } : {}) });
    switch (r.kind) {
      case "single":
        out.push(line(0));
        break;
      case "double":
        out.push(line(0), line(w * 3));
        break;
      case "dotted":
        out.push(line(0, [w, w * 3]));
        break;
      case "dashed":
        out.push(line(0, [r.size * 0.35, r.size * 0.2]));
        break;
      case "wave": {
        // 波線：半周期ごとに左右に振れる短い線の並び。
        const period = r.size * 0.5;
        const amp = r.size * 0.06;
        const steps = Math.max(2, Math.round(((r.to - r.from) / period) * 8));
        for (let i = 0; i < steps; i++) {
          const y1 = r.from + ((r.to - r.from) * i) / steps;
          const y2 = r.from + ((r.to - r.from) * (i + 1)) / steps;
          const dx = (y: number) => amp * Math.sin(((y - r.from) / period) * Math.PI * 2);
          out.push({ kind: "line", x1: x + amp + dx(y1), y1, x2: x + amp + dx(y2), y2, width: w, color: r.color });
        }
        break;
      }
    }
  }
  return out;
}

/**
 * リーダーの字を、行の残りが埋まるまで繰り返す（目次の点線。ページ番号が行末にそろう）。
 * 端数は、リーダーの前後に半分ずつ空ける。
 */
function fillLeader(line: Line, perLine: number): Line {
  const at = line.atoms.findIndex((a) => a.leader);
  if (at < 0) return line;
  const length = line.atoms.reduce((s, a) => s + atomWidth(a), 0);
  const unit = advance(line.atoms[at].cells[0]);
  const slack = perLine - line.indent - length;
  if (slack <= EPS) return line;
  const extra = Math.floor(slack / unit + EPS);
  const gap = (slack - extra * unit) / 2;
  const base = line.atoms[at].cells[0];
  const cells: Cell[] = Array.from({ length: extra + 1 }, () => ({ ...base, advance: unit }));
  // 端数：最初の点の前と、最後の点の後ろに半分ずつ。
  cells[0] = { ...cells[0], shift: (base.shift ?? 0) + gap, advance: unit + gap };
  cells[extra] = { ...cells[extra], advance: (cells[extra].advance ?? unit) + gap };
  const leader: Atom = { ...line.atoms[at], cells };
  return { ...line, adjust: 0, atoms: [...line.atoms.slice(0, at), leader, ...line.atoms.slice(at + 1)] };
}

/**
 * ルビを親文字の右に置く。ルビが短ければ親文字の長さに均等に配る（1:2:1）。
 * 長ければ、前の文字に掛ける長さ（before）の分だけ上から始める。掛けないなら中央そろえ。
 */
function placeRuby(glyphs: PlacedGlyph[], ruby: string, x: number, spanTop: number, spanLength: number, rubySize: number, before = 0, base?: Cell) {
  const chars = [...ruby];
  const natural = chars.length * rubySize;
  const step = natural < spanLength ? spanLength / chars.length : rubySize;
  const start = natural > spanLength && before > 0 ? spanTop - before : spanTop + spanLength / 2 - (step * chars.length) / 2;
  chars.forEach((ch, k) => {
    const center = start + step * (k + 0.5);
    glyphs.push({ text: ch, kind: "vert", x, y: center - rubySize / 2, size: rubySize, font: base?.font, color: base?.color });
  });
}

/** 表紙に置く文字（題・著者名）。scale は段落スタイルの文字の倍率（マスの大きさに掛かっている分）。 */
export interface CoverText {
  atoms: Atom[];
  scale: number;
}

/** 表紙の組み方。長さは pt。 */
export interface CoverInput {
  trimWidth: number;
  trimHeight: number;
  spine: number;
  bleed: number;
  /** 左綴じ（横組みの本）。表1（表）が右に来る。 */
  leftBound: boolean;
  /** 表1の題・著者名を横組みにする。 */
  horizontal: boolean;
  title: CoverText;
  author: CoverText;
  spineTitle: CoverText;
  spineAuthor: CoverText;
  /** 背に文字を入れる（背幅が狭すぎるときは入れない）。 */
  spineText: boolean;
  background: string;
  frontImage?: string;
  backImage?: string;
  images: Record<string, { width: number; height: number }>;
}

/** 表紙の横の並び：表1・背・表4 の左端（x）。 */
export function coverParts(c: Pick<CoverInput, "trimWidth" | "spine" | "leftBound">): { front: number; spine: number; back: number; width: number } {
  const width = c.trimWidth * 2 + c.spine;
  // 右綴じ（縦組み）の本は、開いて置くと表1が左、表4が右。左綴じはその逆。
  return c.leftBound ? { back: 0, spine: c.trimWidth, front: c.trimWidth + c.spine, width } : { front: 0, spine: c.trimWidth, back: c.trimWidth + c.spine, width };
}

/** 背の文字を入れられる最小の背幅（pt）。 */
const MIN_SPINE_TEXT = 4 * MM;

/**
 * 表紙（表1・背・表4 を1枚に並べたもの）を組む。地の色、表1・表4の画像（塗り足しまで）、
 * 表1の題と著者名、背の題と著者名。仕上がりの外の、背の折り目の印も付ける。
 */
export function layoutCover(c: CoverInput): PageLayout {
  const { front, spine, back, width } = coverParts(c);
  const H = c.trimHeight;
  const b = c.bleed;
  const shapes: Shape[] = [];
  const glyphs: PlacedGlyph[] = [];
  // 地の色（塗り足しまで）。
  if (c.background.toLowerCase() !== "#ffffff") shapes.push({ kind: "rect", x: -b, y: -b, w: width + b * 2, h: H + b * 2, fill: c.background });
  // 表1・表4の画像：外側の3辺は塗り足しまで、背の側は折り目まで。
  const panel = (x: number, name: string | undefined) => {
    if (!name) return;
    const outerLeft = x === 0;
    const box = { x: outerLeft ? -b : x, y: -b, w: c.trimWidth + b, h: H + b * 2 };
    const block: ImageBlock = { kind: "image", name, mode: "full", lines: 1, wrap: false, position: "center" };
    const shape = frameImage(name, c.images[name] ?? FALLBACK_IMAGE, box, true, block).shape;
    // 透明な部分には地の色が見えるので、入稿用 PDF でも地の色の上に重ねる。
    if (shape.kind === "image" && c.background.toLowerCase() !== "#ffffff") shape.matte = c.background;
    shapes.push(shape);
  };
  panel(front, c.frontImage);
  panel(back, c.backImage);

  // 縦に1行ずつ置く（x は行の中心、top は1字目の上端）。
  const column = (text: CoverText, size: number, right: number, top: number, length: number, align: "start" | "center" | "end", maxLines = 3) => {
    const base = size / text.scale;
    const perLine = Math.max(1, Math.floor(length / base + EPS));
    const lines = breakLines(text.atoms, perLine, 0, { kinsoku: "strong", hanging: false, justify: false }).slice(0, maxLines);
    lines.forEach((l, i) => {
      l.align = align;
      placeLine(glyphs, l, right - size / 2 - i * size * 1.4, top, base, base * 0.5, perLine, shapes);
    });
    return lines.length;
  };

  // 表1：縦組みなら右寄りに題、その左に著者名（地寄せ）。横組みなら上寄りに題、その下に著者名（中央）。
  const titleSize = c.trimWidth * 0.075;
  const authorSize = titleSize * 0.55;
  if (!c.horizontal) {
    const right = front + c.trimWidth * 0.8;
    const n = column(c.title, titleSize, right + titleSize / 2, H * 0.12, H * 0.62, "start");
    column(c.author, authorSize, right - n * titleSize * 1.4 - titleSize * 0.3 + authorSize / 2, H * 0.12, H * 0.74, "end", 2);
  } else {
    // 横組み：転置したページに縦に組み、横に戻す（本文の横組みと同じ）。
    const sub: Shape[] = [];
    const subGlyphs: PlacedGlyph[] = [];
    const saved = glyphs.length;
    const W = H; // 転置したページの幅 = 実際の高さ
    const place = (text: CoverText, size: number, y: number) => {
      const base = size / text.scale;
      const perLine = Math.max(1, Math.floor((c.trimWidth * 0.8) / base + EPS));
      const lines = breakLines(text.atoms, perLine, 0, { kinsoku: "strong", hanging: false, justify: false }).slice(0, 3);
      lines.forEach((l, i) => {
        l.align = "center";
        placeLine(subGlyphs, l, W - y - i * size * 1.4, c.trimWidth * 0.1, base, base * 0.5, perLine, sub, true);
      });
      return lines.length;
    };
    const n = place(c.title, titleSize, H * 0.25);
    place(c.author, authorSize, H * 0.25 + n * titleSize * 1.4 + titleSize * 0.4);
    const turned = toHorizontal({ index: 0, width: W, height: c.trimWidth, block: { left: 0, top: 0, width: W, height: c.trimWidth }, lineCount: 0, role: "free", headings: [], lines: [], glyphs: subGlyphs, shapes: sub, paper: "#ffffff" });
    glyphs.length = saved;
    for (const g of turned.glyphs) glyphs.push({ ...g, x: g.x + front });
    shapes.push(...turned.shapes);
  }

  // 背：題を上から、著者名を下に寄せて、どちらも縦に。背幅が狭ければ入れない。
  if (c.spineText && c.spine >= MIN_SPINE_TEXT) {
    const size = Math.min(c.spine * 0.6, titleSize * 0.7);
    const center = spine + c.spine / 2;
    column(c.spineTitle, size, center + size / 2, H * 0.07, H * 0.58, "start", 1);
    const aSize = Math.min(size * 0.8, c.spine * 0.5);
    column(c.spineAuthor, aSize, center + aSize / 2, H * 0.68, H * 0.25, "end", 1);
  }

  // 背の折り目の印（仕上がりの外。塗り足しのさらに外の、天と地に短い線）。
  for (const x of [spine, spine + c.spine]) {
    for (const [y1, y2] of [[-b - 1 * MM, -b - 6 * MM], [H + b + 1 * MM, H + b + 6 * MM]]) {
      shapes.push({ kind: "line", x1: x, y1, x2: x, y2, width: 0.25, color: "#000000" });
    }
  }
  return { index: 0, width, height: H, block: { left: 0, top: 0, width, height: H }, lineCount: 0, role: "free", headings: [], lines: [], glyphs, shapes, paper: "#ffffff" };
}
