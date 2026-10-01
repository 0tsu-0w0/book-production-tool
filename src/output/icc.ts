import fs from "node:fs";
import path from "node:path";

// ICC プロファイル（PDF/X-4 の出力インテントに埋め込む印刷条件）。
// ヘッダーと説明（desc）だけを読み、CMYK の出力用プロファイルかどうかを確かめる。

export interface IccInfo {
  /** プロファイルの説明（例：Japan Color 2001 Coated）。 */
  name: string;
  /** 色空間（CMYK・RGB・GRAY など）。 */
  colorSpace: string;
  /** プロファイルの種類（prtr は出力用）。 */
  deviceClass: string;
  /** 版（2 か 4）。 */
  version: number;
}

export class IccError extends Error {}

const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));

/** ICC プロファイルのヘッダーと説明を読む。ICC でなければ IccError。 */
export function readIcc(bytes: Uint8Array): IccInfo {
  if (bytes.length < 132 || ascii(bytes, 36, 4) !== "acsp") throw new IccError("ICC プロファイルではありません。");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size = view.getUint32(0);
  if (size > bytes.length) throw new IccError("ICC プロファイルが途中で切れています。");
  const info: IccInfo = {
    name: "",
    colorSpace: ascii(bytes, 16, 4).trim(),
    deviceClass: ascii(bytes, 12, 4),
    version: bytes[8],
  };
  const count = view.getUint32(128);
  for (let i = 0; i < count && 132 + i * 12 + 12 <= bytes.length; i++) {
    const at = 132 + i * 12;
    if (ascii(bytes, at, 4) !== "desc") continue;
    info.name = description(bytes, view, view.getUint32(at + 4), view.getUint32(at + 8));
    break;
  }
  return info;
}

/** 説明のタグ：v2 は desc 型（ASCII）、v4 は mluc 型（UTF-16BE の多言語の文字列。英語か最初のものを使う）。 */
function description(bytes: Uint8Array, view: DataView, offset: number, size: number): string {
  if (offset + size > bytes.length || size < 12) return "";
  const type = ascii(bytes, offset, 4);
  if (type === "desc") {
    const n = view.getUint32(offset + 8);
    return ascii(bytes, offset + 12, Math.max(0, Math.min(n, size - 12)))
      .replace(/\0.*$/s, "")
      .trim();
  }
  if (type === "mluc") {
    const records = view.getUint32(offset + 8);
    const recordSize = view.getUint32(offset + 12);
    let pick = -1;
    for (let r = 0; r < records; r++) {
      const at = offset + 16 + r * recordSize;
      if (pick < 0 || ascii(bytes, at, 2) === "en") pick = at;
      if (ascii(bytes, at, 2) === "en") break;
    }
    if (pick < 0) return "";
    const len = view.getUint32(pick + 4);
    const start = offset + view.getUint32(pick + 8);
    let s = "";
    for (let k = 0; k + 1 < len && start + k + 1 < bytes.length; k += 2) s += String.fromCharCode(view.getUint16(start + k));
    return s.replace(/\0+$/, "").trim();
  }
  return "";
}

/** PDF/X-4 の印刷条件に使えるか（CMYK の出力用プロファイル）。使えなければ理由を返す。 */
export function iccProblem(info: IccInfo): string | undefined {
  if (info.colorSpace !== "CMYK") return `CMYK のプロファイルではありません（${info.colorSpace}）。印刷用の CMYK のプロファイルを選んでください。`;
  if (info.deviceClass !== "prtr") return "出力用（プリンター・印刷機）のプロファイルではありません。";
  return undefined;
}

/** よく知られた印刷条件は、ICC の登録済みの識別子で書く（それ以外は説明をそのまま使う）。 */
export function outputConditionId(name: string): string {
  if (/Japan\s*Color\s*2001\s*Coated/i.test(name)) return "JC200103";
  if (/Japan\s*Color\s*2011\s*Coated/i.test(name)) return "JC11";
  if (/Coated\s*FOGRA\s*39/i.test(name)) return "FOGRA39";
  if (/U\.?S\.?\s*Web\s*Coated\s*\(SWOP\)/i.test(name)) return "CGATS TR 001";
  return name || "Custom";
}

/** ICC プロファイルが置かれていることの多いフォルダ（OS とアプリのもの）。 */
export function profileDirs(platform = process.platform, env = process.env): string[] {
  if (platform === "win32") {
    const win = env.WINDIR ?? "C:\\Windows";
    const pf = [env["ProgramFiles(x86)"], env.ProgramFiles, env.CommonProgramFiles, env["CommonProgramFiles(x86)"]].filter((d): d is string => !!d);
    return [
      path.join(win, "System32", "spool", "drivers", "color"),
      ...pf.flatMap((d) => [path.join(d, "Common Files", "Adobe", "Color", "Profiles"), path.join(d, "Adobe", "Color", "Profiles")]),
    ];
  }
  const home = env.HOME ?? "";
  return [
    "/Library/ColorSync/Profiles",
    "/System/Library/ColorSync/Profiles",
    "/Library/Application Support/Adobe/Color/Profiles",
    ...(home ? [path.join(home, "Library", "ColorSync", "Profiles")] : []),
    "/usr/share/color/icc",
  ];
}

/** フォルダ（1段下まで）から、PDF/X-4 に使える ICC プロファイルを探す。 */
export function findCmykProfiles(dirs = profileDirs()): { path: string; name: string }[] {
  const out: { path: string; name: string }[] = [];
  const seen = new Set<string>();
  const visit = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const file = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < 1) visit(file, depth + 1);
        continue;
      }
      if (!/\.(icc|icm)$/i.test(e.name)) continue;
      try {
        // ヘッダーと説明だけ読めばよいが、説明はファイルの後ろにあることもあるので全体を読む（数百KB程度）。
        const info = readIcc(fs.readFileSync(file));
        if (iccProblem(info)) continue;
        const name = info.name || path.basename(file);
        if (seen.has(name)) continue;
        seen.add(name);
        out.push({ path: file, name });
      } catch {
        // ICC でないファイルは飛ばす。
      }
    }
  };
  for (const d of dirs) visit(d, 0);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
