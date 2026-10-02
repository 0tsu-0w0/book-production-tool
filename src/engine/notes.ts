import type { Atom, Block } from "./types.js";

// 注（後注）。本文の［＃注：…］に小さな注番号（注1）を入れ、注の中身は章の終わり（次の大見出しの前）か本の終わりにまとめる。
// 縦組みの本では、ページの下に置く脚注より、章末・巻末の後注が多い。

export const NOTE_STYLE = "注";
/** 本文の注番号の大きさ（本文の字に対する割合）。 */
export const NOTE_MARK_SCALE = 0.6;

/** 注を置く場所：章の終わり・本の終わり・そのページの終わり（横組みではページの下、縦組みではページの左端）。 */
export type NotePlacement = "chapter" | "end" | "page";

/** 注の段落：「注1　中身」。seq は本全体での注の通し番号（本文の注番号と行き来するリンクに使う）。 */
function noteParagraph(n: number, atoms: Atom[], seq: number): { kind: "para"; style: string; atoms: Atom[] } {
  const back = `l:${NOTE_REF_LABEL}${seq}`;
  return {
    kind: "para",
    style: NOTE_STYLE,
    atoms: [{ cells: [{ text: "注" }], label: `${NOTE_LABEL}${seq}`, link: back }, { cells: [numberCell(n)], link: back }, { cells: [{ text: "　" }] }, ...atoms],
  };
}

/** 注の中身と本文の注番号に付けるラベル（閲覧用 PDF で行き来するリンクの飛び先）。 */
const NOTE_LABEL = "kolophon-note-";
const NOTE_REF_LABEL = "kolophon-noteref-";

/** 注番号の数字のマス（3桁までは縦中横）。 */
const numberCell = (n: number) => ({ text: String(n), tcy: n < 1000 });

/**
 * 注を番号順に並べ、置く場所に段落として入れる。lines は段落ごとの原稿の行（入れた段落は undefined）。
 * 章ごとなら番号も章ごとに1から。本文の注番号のマスは、組むたびにここで書き直す（記法の読み取り結果は使い回すため）。
 */
export function placeNotes(blocks: Block[], lines: (number | undefined)[], placement: NotePlacement): { blocks: Block[]; lines: (number | undefined)[] } {
  if (!blocks.some((b) => (b.kind === "para" || b.kind === "heading") && b.atoms.some((a) => a.note))) return { blocks, lines };
  const out: Block[] = [];
  const outLines: (number | undefined)[] = [];
  let pending: { n: number; atoms: Atom[]; seq: number }[] = [];
  let n = 0;
  let seq = 0;
  const flush = () => {
    if (pending.length === 0) return;
    const push = (b: Block) => {
      out.push(b);
      outLines.push(undefined);
    };
    push({ kind: "blank" });
    push({ kind: "para", style: NOTE_STYLE, atoms: [{ cells: [{ text: "注" }] }] });
    for (const note of pending) push(noteParagraph(note.n, note.atoms, note.seq));
    pending = [];
  };
  blocks.forEach((block, i) => {
    if (block.kind === "heading" && block.level === 1 && placement !== "end") {
      flush();
      n = 0;
    }
    if (block.kind === "para" || block.kind === "heading") {
      for (const atom of block.atoms) {
        if (!atom.note) continue;
        n++;
        seq++;
        atom.cells[0].text = "注";
        Object.assign(atom.cells[1], numberCell(n));
        // 本文の注番号から注の中身へ、注の中身から本文の注番号へ飛べるようにする。
        atom.label = `${NOTE_REF_LABEL}${seq}`;
        atom.link = `l:${NOTE_LABEL}${seq}`;
        if (placement === "page") {
          // ページごと：注の段落は組むときにそのページの終わりへ置く。番号は章ごと。
          atom.noteBlock = noteParagraph(n, atom.note, seq);
          continue;
        }
        atom.noteBlock = undefined;
        pending.push({ n, atoms: atom.note, seq });
      }
    }
    out.push(block);
    outLines.push(lines[i]);
  });
  flush();
  return { blocks: out, lines: outLines };
}
