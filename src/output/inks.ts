import { PDFDict, PDFName, PDFNumber, PDFOperator, PDFOperatorNames, setGraphicsState, type PDFDocument, type PDFPage, type PDFRef } from "pdf-lib";
import type { SpotColor } from "../document/settings.js";
import { fillColor, hexToCmyk, strokeColor, type ColorMode } from "./color.js";

// 入稿用 PDF のインキ：特色とオーバープリント（ノセ）。
// 特色は「画面でこの色を使った所を、この特色の版で刷る」という登録。色の指定はふつうの色（#rrggbb）のままなので、
// 文字の色・スタイルの色・飾りの色のどこでも使える。PDF では Separation の色空間（代わりの色は CMYK）で書く。
// オーバープリント：スミ（K100%）の文字・罫と、ノセにした特色を、下の色を抜かずに重ねて刷る。

export interface InkOptions {
  spots?: SpotColor[];
  /** スミ（K100%）をノセにする。 */
  overprintBlack?: boolean;
}

/** ページの Resources の辞書（ColorSpace・ExtGState）に1つ登録する。前からある登録は残す。 */
export function addResource(page: PDFPage, kind: "ColorSpace" | "ExtGState", name: string, ref: PDFRef): void {
  const resources = page.node.Resources()!;
  let dict = resources.lookupMaybe(PDFName.of(kind), PDFDict);
  if (!dict) {
    dict = page.doc.context.obj({});
    resources.set(PDFName.of(kind), dict);
  }
  dict.set(PDFName.of(name), ref);
}

const isK100 = (hex: string) => hexToCmyk(hex).join(",") === "0,0,0,1";

/** 文書全体のインキ（色空間とノセの状態は1度だけ作り、ページごとに Resources へ登録する）。 */
export class Inks {
  private readonly spots = new Map<string, { index: number; spot: SpotColor; ref?: PDFRef }>();
  private gs?: { on: PDFRef; off: PDFRef };
  /** ノセを切り替えるか（CMYK で、スミのノセか、ノセの特色があるとき）。 */
  private readonly overprinting: boolean;

  constructor(
    private readonly doc: PDFDocument,
    readonly mode: ColorMode,
    private readonly options: InkOptions = {},
  ) {
    // 特色は CMYK（入稿用）のときだけ。グレースケール・RGB では、画面の色のまま。
    if (mode === "cmyk") (options.spots ?? []).forEach((spot, index) => this.spots.set(spot.color.toLowerCase(), { index, spot }));
    this.overprinting = mode === "cmyk" && (!!options.overprintBlack || [...this.spots.values()].some((s) => s.spot.overprint));
  }

  /** そのページで色を指定するための部品。 */
  forPage(page: PDFPage): Paint {
    return new Paint(this, page);
  }

  /** 使った特色の名前（重ならない）。 */
  usedSpots(): string[] {
    return [...this.spots.values()].filter((s) => s.ref).map((s) => s.spot.name);
  }

  /** 色を指定する命令と、そのときのノセの状態（特色ならその名前の色空間も）。 */
  ops(hex: string, stroking: boolean, page: PDFPage, registered: Set<string>): PDFOperator[] {
    const out: PDFOperator[] = [];
    // 特色に登録した色か（色は小文字の #rrggbb で見分ける）。
    const spot = this.spots.get(hex.toLowerCase());
    // ノセを使う文書では、色を変えるたびに重ね方も指定し直す（前の色の重ね方が残らないように）。
    if (this.overprinting) {
      const on = spot ? spot.spot.overprint : !!this.options.overprintBlack && isK100(hex);
      const gs = (this.gs ??= {
        on: this.doc.context.register(this.doc.context.obj({ Type: "ExtGState", OP: true, op: true, OPM: 1 })),
        off: this.doc.context.register(this.doc.context.obj({ Type: "ExtGState", OP: false, op: false, OPM: 0 })),
      });
      const name = on ? "GSop" : "GSko";
      if (!registered.has(name)) {
        addResource(page, "ExtGState", name, on ? gs.on : gs.off);
        registered.add(name);
      }
      out.push(setGraphicsState(name));
    }
    if (!spot) {
      out.push(stroking ? strokeColor(hex, this.mode) : fillColor(hex, this.mode));
      return out;
    }
    spot.ref ??= this.separation(spot.spot);
    const name = `SP${spot.index}`;
    if (!registered.has(name)) {
      addResource(page, "ColorSpace", name, spot.ref);
      registered.add(name);
    }
    out.push(
      PDFOperator.of(stroking ? PDFOperatorNames.StrokingColorspace : PDFOperatorNames.NonStrokingColorspace, [PDFName.of(name)]),
      PDFOperator.of(stroking ? PDFOperatorNames.StrokingColorN : PDFOperatorNames.NonStrokingColorN, [PDFNumber.of(1)]),
    );
    return out;
  }

  /** 特色の色空間：[/Separation /名前 /DeviceCMYK 濃度0〜1を代わりの CMYK にする関数]。 */
  private separation(spot: SpotColor): PDFRef {
    // 代わりの CMYK（0〜100%）を 0〜1 にする。濃度 0 で C0（色なし）、濃度 1 で C1 になる。
    const c1 = spot.cmyk.map((v) => Math.round(v * 10) / 1000);
    const tint = this.doc.context.register(this.doc.context.obj({ FunctionType: 2, Domain: [0, 1], C0: [0, 0, 0, 0], C1: c1, N: 1 }));
    return this.doc.context.register(this.doc.context.obj([PDFName.of("Separation"), PDFName.of(spot.name), PDFName.of("DeviceCMYK"), tint]));
  }
}

/** 1ページの中で色を指定する。 */
export class Paint {
  private readonly registered = new Set<string>();

  constructor(
    private readonly inks: Inks,
    private readonly page: PDFPage,
  ) {}

  get mode(): ColorMode {
    return this.inks.mode;
  }

  fill(hex: string): PDFOperator[] {
    return this.inks.ops(hex, false, this.page, this.registered);
  }

  stroke(hex: string): PDFOperator[] {
    return this.inks.ops(hex, true, this.page, this.registered);
  }
}
