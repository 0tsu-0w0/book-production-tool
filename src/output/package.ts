import fs from "node:fs";
import path from "node:path";
import { serializeDocument, type DocImage } from "../document/document.js";
import { leftBound, toLayoutSpec, type FontChoice, type Settings } from "../document/settings.js";
import { faceOffsets, readFaceInfo } from "../fonts/sfnt.js";

// パッケージ（InDesign のパッケージにあたる）：入稿に要るものを1つのフォルダにまとめる。
//   文書（.kolo）・Links（画像）・Fonts（書体のファイル）・入稿用 PDF・指示書.txt
// 書体は、ファイルの中の埋め込みの許可（OS/2 の fsType）が「埋め込み禁止」なら入れず、指示書にそう書く。

export interface PackageInput {
  /** 書き出すフォルダ（なければ作る）。 */
  dir: string;
  /** 文書の名前（拡張子なし）。 */
  name: string;
  text: string;
  settings: Settings;
  images: DocImage[];
  /** 使う書体（本文・スタイル・合成フォント。同じファイルは1つに）。 */
  fonts: FontChoice[];
  /** 書き出す前の検査の結果。 */
  findings: { level: "error" | "warning" | "info"; message: string }[];
  /** 入稿用 PDF を書き出す（path は書き出す先）。結果を返す。 */
  pdf?: (file: string) => Promise<{ pages?: number; standard?: string; problems?: string[]; error?: string } | undefined>;
  appVersion: string;
  now?: Date;
}

export interface PackageResult {
  dir: string;
  files: string[];
  /** 入れなかった書体（名前と理由）。 */
  skippedFonts: { name: string; reason: string }[];
  pdf?: { pages?: number; error?: string };
}

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg" };

/** ファイル名に使えない字を置き換える。 */
const safe = (s: string) => s.replace(/[\\/:*?"<>|]/g, "_").trim() || "名前なし";

/** 書体のファイルが、ほかの文書への埋め込みを許しているか（.ttc なら index 番目）。読めなければ undefined。 */
function embeddable(file: string, index: number): boolean | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const read = (offset: number, length: number) => {
      const b = Buffer.alloc(length);
      fs.readSync(fd!, b, 0, length, offset);
      return new Uint8Array(b.buffer, b.byteOffset, length);
    };
    const offsets = faceOffsets(read);
    return readFaceInfo(read, offsets[index] ?? offsets[0], index).embeddable;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export async function writePackage(p: PackageInput): Promise<PackageResult> {
  const files: string[] = [];
  const skippedFonts: PackageResult["skippedFonts"] = [];
  fs.mkdirSync(p.dir, { recursive: true });
  const name = safe(p.name);

  // 1. 文書。
  const docFile = `${name}.kolo`;
  fs.writeFileSync(path.join(p.dir, docFile), serializeDocument({ text: p.text, settings: p.settings, images: p.images }), "utf8");
  files.push(docFile);

  // 2. 画像（文書の中の画像を、元の形式のファイルにする）。
  const imageRows: string[] = [];
  if (p.images.length > 0) fs.mkdirSync(path.join(p.dir, "Links"), { recursive: true });
  for (const img of p.images) {
    const file = path.join("Links", `${safe(img.name)}.${EXT[img.mime] ?? "bin"}`);
    fs.writeFileSync(path.join(p.dir, file), Buffer.from(img.data, "base64"));
    files.push(file);
    imageRows.push(`  ${img.name}　→ ${file}（${img.width}×${img.height} 画素）`);
  }

  // 3. 書体（同じファイルは1つ）。
  const fontRows: string[] = [];
  const seen = new Set<string>();
  for (const f of p.fonts) {
    if (seen.has(f.path)) continue;
    seen.add(f.path);
    if (!fs.existsSync(f.path)) {
      skippedFonts.push({ name: f.name, reason: "ファイルが見つかりません" });
      fontRows.push(`  ${f.name}　→ 入れていません（ファイルが見つかりません：${f.path}）`);
      continue;
    }
    const ok = embeddable(f.path, f.index ?? 0);
    if (ok === false) {
      skippedFonts.push({ name: f.name, reason: "書体の埋め込みの許可が「禁止」" });
      fontRows.push(`  ${f.name}　→ 入れていません（書体のファイルが埋め込みを禁止しています。入稿用 PDF には埋め込んでいません）`);
      continue;
    }
    fs.mkdirSync(path.join(p.dir, "Fonts"), { recursive: true });
    const file = path.join("Fonts", path.basename(f.path));
    fs.copyFileSync(f.path, path.join(p.dir, file));
    files.push(file);
    fontRows.push(`  ${f.name}　→ ${file}`);
  }

  // 4. 入稿用 PDF。
  let pdf: PackageResult["pdf"];
  if (p.pdf) {
    const pdfFile = `${name}.pdf`;
    const r = await p.pdf(path.join(p.dir, pdfFile));
    if (r && !r.error) files.push(pdfFile);
    pdf = { pages: r?.pages, error: r?.error ?? (r ? undefined : "書き出しを取り消しました") };
  }

  // 5. 指示書。
  const s = p.settings;
  const spec = toLayoutSpec(s);
  const now = p.now ?? new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const kind = s.pdfKind === "screen" ? "閲覧用" : s.pdfKind === "print-nomarks" ? "入稿用（トンボなし）" : "入稿用（トンボ付き）";
  const standard = s.output.pdfStandard === "x4" ? "PDF/X-4" : "PDF/X-1a:2003";
  const spots = s.output.spotColors;
  const level = { error: "問題", warning: "注意", info: "参考" } as const;
  const lines = [
    "Kolophon パッケージ　指示書",
    "",
    `作った日時：${date}（Kolophon ${p.appVersion}）`,
    `文書：${docFile}`,
    ...(s.bookInfo.title ? [`書名：${s.bookInfo.title}`] : []),
    ...(s.bookInfo.author ? [`著者：${s.bookInfo.author}`] : []),
    "",
    "■ 判型と組み方",
    `  仕上がり：${Math.round(spec.pageWidthMm * 10) / 10}×${Math.round(spec.pageHeightMm * 10) / 10} mm`,
    `  組み方向：${leftBound(s) ? "横組み（左綴じ）" : "縦組み（右綴じ）"}`,
    `  本文：${spec.charsPerLine}字×${spec.linesPerPage}行${spec.columns > 1 ? `×${spec.columns}段` : ""}`,
    "",
    "■ 入稿用 PDF",
    p.pdf
      ? pdf?.error
        ? `  書き出せませんでした：${pdf.error}`
        : `  ${name}.pdf（${pdf?.pages ?? "?"}ページ・${kind}・${standard}・塗り足し ${s.advanced.bleedMm} mm・${s.output.color === "gray" ? "グレースケール" : "CMYK"}）`
      : "  入れていません",
    "",
    "■ 色",
    `  ${s.output.color === "gray" ? "グレースケール（K の版だけ）" : "CMYK"}。スミ（K100%）のオーバープリント：${s.output.overprintBlack ? "する" : "しない"}`,
    ...(spots.length > 0
      ? ["  特色：", ...spots.map((sp) => `    ${sp.name}（画面の色 ${sp.color}、代わりの CMYK ${sp.cmyk.join("/")}、オーバープリント${sp.overprint ? "する" : "しない"}）`)]
      : ["  特色：なし"]),
    "",
    "■ 書体",
    ...(fontRows.length > 0 ? fontRows : ["  なし"]),
    "  ※書体のファイルは、書体の使用許諾の範囲で使ってください（印刷所に渡せるかは、書体ごとの許諾を確かめてください）。",
    "",
    "■ 画像",
    ...(imageRows.length > 0 ? imageRows : ["  なし"]),
    "",
    "■ 書き出す前の検査",
    ...(p.findings.length > 0 ? p.findings.map((f) => `  [${level[f.level]}] ${f.message}`) : ["  問題は見つかりませんでした。"]),
    "",
  ];
  const report = "指示書.txt";
  // Windows のメモ帳でも読めるよう、BOM 付きの UTF-8・改行は CRLF。
  fs.writeFileSync(path.join(p.dir, report), `﻿${lines.join("\r\n")}`, "utf8");
  files.push(report);
  return { dir: p.dir, files, skippedFonts, pdf };
}
