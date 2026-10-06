import type { Settings } from "../document/settings.js";
import { inkPreview, PROCESS_PLATES, readInks, type InkPreview } from "./ink-preview.js";

// 分版プレビュー（InDesign の分版プレビューにあたる）。入稿用 PDF で刷られる版（C・M・Y・K と特色）を並べ、
// 選んだ版だけを重ねた紙面を見せる。カーソルの所のインキの量（目安）も出す。

const PLATE_NAMES: Record<string, string> = { C: "シアン", M: "マゼンタ", Y: "イエロー", K: "ブラック" };
const PLATE_SWATCH: Record<string, string> = { C: "#00a0e9", M: "#e4007f", Y: "#fff100", K: "#231815" };

export interface SeparationsHost {
  settings(): Settings;
  /** 版の見え方を紙面に当てる（null で元に戻す）。 */
  apply(ink: InkPreview | null): void;
  /** 紙面のキャンバスが並ぶ所（カーソルの所のインキを読む）。 */
  stage: HTMLElement;
}

export class SeparationsPanel {
  private readonly root = document.createElement("section");
  private readonly list = document.createElement("div");
  private readonly readout = document.createElement("p");
  private readonly overprint = document.createElement("input");
  /** 見せない版（はじめは全部見せる）。 */
  private readonly hidden = new Set<string>();
  private open = false;

  constructor(private readonly host: SeparationsHost) {
    this.root.className = "glyph-panel separations-panel";
    this.root.hidden = true;
    this.root.setAttribute("aria-label", "分版プレビュー");
    const head = document.createElement("header");
    const h = document.createElement("h2");
    h.textContent = "分版プレビュー";
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "×";
    close.title = close.ariaLabel = "閉じる";
    close.addEventListener("click", () => this.close());
    head.append(h, close);
    this.list.className = "plate-list";
    this.overprint.type = "checkbox";
    this.overprint.checked = true;
    this.overprint.addEventListener("change", () => this.update());
    const op = document.createElement("label");
    op.className = "field check";
    op.append(this.overprint, document.createTextNode("オーバープリントを見る（ノセの色は下の色に重ねる）"));
    this.readout.className = "glyph-target";
    this.readout.textContent = "紙面にカーソルを置くと、その所のインキの量（目安）が出ます。";
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent =
      "入稿用 PDF で刷る版です（色の変換は書き出しと同じ式）。版を外すと、その版を刷らないときの見え方になります。紙の色は刷らないので白です。インキの量は画面の色から読んだ目安です。";
    this.root.append(head, this.list, op, this.readout, hint);
    document.body.append(this.root);
    host.stage.addEventListener("mousemove", (e) => this.read(e));
  }

  toggle() {
    if (this.open) this.close();
    else this.show();
  }

  show() {
    this.open = true;
    this.root.hidden = false;
    this.render();
    this.update();
  }

  close() {
    this.open = false;
    this.root.hidden = true;
    this.host.apply(null);
  }

  /** 設定（特色・書き出しの色）が変わったとき。開いていれば、版の一覧と見え方を作り直す。 */
  refresh() {
    if (!this.open) return;
    this.render();
    this.update();
  }

  /** 書き出しの色に合わせた版の一覧（グレースケールなら K だけ）。 */
  private plates(): { id: string; label: string; swatch: string }[] {
    const s = this.host.settings();
    if (s.output.color === "gray") return [{ id: "K", label: "ブラック（グレースケール）", swatch: PLATE_SWATCH.K }];
    return [
      ...PROCESS_PLATES.map((p) => ({ id: p, label: `${p}　${PLATE_NAMES[p]}`, swatch: PLATE_SWATCH[p] })),
      ...s.output.spotColors.map((sp) => ({ id: sp.name, label: `特色　${sp.name}`, swatch: sp.color })),
    ];
  }

  private render() {
    const plates = this.plates();
    const all = document.createElement("label");
    all.className = "field check plate";
    const allBox = document.createElement("input");
    allBox.type = "checkbox";
    allBox.checked = plates.every((p) => !this.hidden.has(p.id));
    allBox.addEventListener("change", () => {
      for (const p of plates) {
        if (allBox.checked) this.hidden.delete(p.id);
        else this.hidden.add(p.id);
      }
      this.render();
      this.update();
    });
    all.append(allBox, document.createTextNode("すべての版"));
    this.list.replaceChildren(
      all,
      ...plates.map((p) => {
        const row = document.createElement("label");
        row.className = "field check plate";
        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = !this.hidden.has(p.id);
        box.addEventListener("change", () => {
          if (box.checked) this.hidden.delete(p.id);
          else this.hidden.add(p.id);
          allBox.checked = plates.every((x) => !this.hidden.has(x.id));
          this.update();
        });
        const sw = document.createElement("span");
        sw.className = "plate-swatch";
        sw.style.background = p.swatch;
        row.append(box, sw, document.createTextNode(p.label));
        return row;
      }),
    );
  }

  private options() {
    const s = this.host.settings();
    const plates = new Set(this.plates().map((p) => p.id).filter((id) => !this.hidden.has(id)));
    return { plates, gray: s.output.color === "gray", spots: s.output.spotColors, overprintBlack: s.output.overprintBlack, showOverprint: this.overprint.checked };
  }

  private update() {
    if (this.open) this.host.apply(inkPreview(this.options()));
  }

  /** カーソルの所の画素から、インキの量を読む（目安）。 */
  private read(e: MouseEvent) {
    if (!this.open || !(e.target instanceof HTMLCanvasElement)) return;
    const canvas = e.target;
    const box = canvas.getBoundingClientRect();
    const x = Math.floor(((e.clientX - box.left) / box.width) * canvas.width);
    const y = Math.floor(((e.clientY - box.top) / box.height) * canvas.height);
    const p = canvas.getContext("2d")?.getImageData(x, y, 1, 1).data;
    if (!p) return;
    const inks = readInks(p[0], p[1], p[2], this.options());
    const total = inks.reduce((s, i) => s + i.percent, 0);
    this.readout.textContent = `カーソルの所：${inks.map((i) => `${i.name} ${i.percent}%`).join("　")}${inks.length > 1 ? `（合計 ${total}%）` : ""}`;
  }
}
