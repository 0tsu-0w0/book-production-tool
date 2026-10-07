import { tintHex, type SpotColor } from "../document/settings.js";

// 設定欄の「特色」。画面で使う色と、印刷所に伝えるインキの名前（DIC 156 など）・代わりの CMYK・ノセを登録する。
// 入稿用 PDF では、その色で描いた文字・罫・飾りを特色の版で刷る。

/** 色の入力欄に出す候補（登録した特色）。どの色の欄でも使えるように、ページに1つだけ置く。 */
export const SPOT_LIST_ID = "kolophon-spot-colors";

export function updateSpotList(spots: SpotColor[]): void {
  let list = document.getElementById(SPOT_LIST_ID) as HTMLDataListElement | null;
  if (!list) {
    list = document.createElement("datalist");
    list.id = SPOT_LIST_ID;
    document.body.append(list);
  }
  list.replaceChildren(
    ...spots.flatMap((s) => [
      { value: s.color, label: `特色：${s.name}` },
      ...(s.tints ?? []).map((t) => ({ value: tintHex(s.color, t), label: `特色：${s.name} ${t}%` })),
    ]).map(({ value, label }) => {
      const o = document.createElement("option");
      o.value = value;
      o.label = label;
      return o;
    }),
  );
}

export class SpotEditor {
  readonly element = document.createElement("div");

  constructor(
    private readonly spots: SpotColor[],
    private readonly onChange: () => void,
  ) {
    this.element.className = "spot-editor";
    this.render();
  }

  private changed() {
    updateSpotList(this.spots);
    this.onChange();
  }

  private render() {
    const rows = this.spots.map((spot, i) => this.row(spot, i));
    const add = document.createElement("button");
    add.type = "button";
    add.textContent = "特色を追加";
    add.addEventListener("click", () => {
      // 画面の色は、まだ使っていない色にする（色で特色を見分けるため）。
      const used = new Set(this.spots.map((s) => s.color));
      const color = ["#e4007f", "#00a0e9", "#f39800", "#009944", "#920783", "#c9a63c"].find((c) => !used.has(c)) ?? "#808080";
      let n = this.spots.length + 1;
      while (this.spots.some((s) => s.name === `特色${n}`)) n++;
      this.spots.push({ name: `特色${n}`, color, cmyk: [0, 100, 0, 0], overprint: false });
      this.render();
      this.changed();
    });
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent =
      "登録した色で描いた文字・罫・飾りを、入稿用 PDF では特色の版で刷ります。色を選ぶ欄の候補に出ます。インキの名前は印刷所の指定どおりに（例：DIC 156）。CMYK は特色を使えないときの代わりの色です。濃さ（%）を並べると（例：50, 30）、その濃さの色（平網）も候補に出て、入稿用 PDF では同じ特色の版をその濃さで刷ります。";
    this.element.replaceChildren(...rows, add, hint);
  }

  private row(spot: SpotColor, index: number): HTMLElement {
    const box = document.createElement("div");
    box.className = "spot-item";
    const color = document.createElement("input");
    color.type = "color";
    color.value = spot.color;
    color.title = "画面での色（この色で描いた所が特色になる）";
    color.addEventListener("change", () => {
      if (this.spots.some((s, i) => i !== index && s.color === color.value.toLowerCase())) {
        alert("ほかの特色と同じ色です。特色ごとに違う色にしてください。");
        color.value = spot.color;
        return;
      }
      spot.color = color.value.toLowerCase();
      this.changed();
    });
    const name = document.createElement("input");
    name.type = "text";
    name.value = spot.name;
    name.placeholder = "インキの名前（例：DIC 156）";
    name.setAttribute("aria-label", "インキの名前");
    name.addEventListener("change", () => {
      const v = name.value.trim();
      if (!v || this.spots.some((s, i) => i !== index && s.name === v)) {
        name.value = spot.name;
        return;
      }
      spot.name = v;
      this.changed();
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "danger";
    remove.textContent = "×";
    remove.title = "この特色を消す（その色はふつうの CMYK で刷る）";
    remove.addEventListener("click", () => {
      this.spots.splice(index, 1);
      this.render();
      this.changed();
    });
    const head = document.createElement("div");
    head.className = "row";
    head.append(color, name, remove);

    const cmyk = document.createElement("div");
    cmyk.className = "row spot-cmyk";
    "CMYK".split("").forEach((label, k) => {
      const input = document.createElement("input");
      input.type = "number";
      input.min = "0";
      input.max = "100";
      input.step = "1";
      input.value = String(spot.cmyk[k]);
      input.setAttribute("aria-label", `代わりの ${label}（%）`);
      input.addEventListener("change", () => {
        const v = Math.min(100, Math.max(0, Number(input.value) || 0));
        input.value = String(v);
        spot.cmyk[k] = v;
        this.changed();
      });
      const l = document.createElement("label");
      l.append(document.createTextNode(label), input);
      cmyk.append(l);
    });

    // 濃さ（平網）：「50, 30」のように % を並べる。それぞれの色が、色を選ぶ欄の候補に出る。
    const tints = document.createElement("input");
    tints.type = "text";
    tints.className = "spot-tints";
    tints.value = (spot.tints ?? []).join(", ");
    tints.placeholder = "例：50, 30";
    tints.setAttribute("aria-label", "濃さ（%）");
    tints.addEventListener("change", () => {
      const values = tints.value
        .replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0))
        .split(/[,、，\s]+/u)
        .map((v) => Math.round(Number(v.replace(/[%％]/g, ""))))
        .filter((n) => n >= 1 && n <= 99);
      spot.tints = [...new Set(values)].sort((a, b) => b - a).slice(0, 8);
      tints.value = spot.tints.join(", ");
      this.render();
      this.changed();
    });
    const tintRow = document.createElement("label");
    tintRow.className = "row spot-tint-row";
    const chips = (spot.tints ?? []).map((t) => {
      const chip = document.createElement("span");
      chip.className = "plate-swatch";
      chip.style.background = tintHex(spot.color, t);
      chip.title = `${t}%`;
      return chip;
    });
    tintRow.append(document.createTextNode("濃さ（%）"), tints, ...chips);

    const over = document.createElement("label");
    over.className = "field check";
    const box2 = document.createElement("input");
    box2.type = "checkbox";
    box2.checked = spot.overprint;
    box2.addEventListener("change", () => {
      spot.overprint = box2.checked;
      this.changed();
    });
    over.append(box2, document.createTextNode("ノセ（下の色を抜かずに重ねて刷る）"));
    box.append(head, cmyk, tintRow, over);
    return box;
  }
}
