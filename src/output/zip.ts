import fs from "node:fs";

// 画像を1つの ZIP にまとめる（OUT-05）。PNG・JPEG はもう圧縮されているので、無圧縮（格納）で書く。
// 1枚ずつファイルに書き足し、最後に目次（セントラルディレクトリ）を書く。ファイル名は UTF-8。

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** DOS 形式の日時（ZIP のヘッダーに入れる）。 */
function dosTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export class ZipWriter {
  private readonly fd: number;
  private offset = 0;
  private readonly entries: { name: Buffer; crc: number; size: number; offset: number }[] = [];
  private readonly stamp = dosTime(new Date());

  constructor(readonly path: string) {
    this.fd = fs.openSync(path, "w");
  }

  private write(buf: Uint8Array) {
    fs.writeSync(this.fd, buf);
    this.offset += buf.length;
  }

  add(fileName: string, data: Uint8Array) {
    const name = Buffer.from(fileName, "utf8");
    const crc = crc32(data);
    // ZIP64 は使わないので、1つのファイルと ZIP 全体は 4GB 未満に限る。
    if (this.offset + data.length > 0xfffffff0) throw new Error("ZIP が大きすぎます（4GB まで）。");
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4); // 展開に必要な版
    h.writeUInt16LE(0x0800, 6); // ファイル名は UTF-8
    h.writeUInt16LE(0, 8); // 格納（無圧縮）
    h.writeUInt16LE(this.stamp.time, 10);
    h.writeUInt16LE(this.stamp.date, 12);
    h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(data.length, 18);
    h.writeUInt32LE(data.length, 22);
    h.writeUInt16LE(name.length, 26);
    h.writeUInt16LE(0, 28);
    this.entries.push({ name, crc, size: data.length, offset: this.offset });
    this.write(h);
    this.write(name);
    this.write(data);
  }

  close() {
    const start = this.offset;
    for (const e of this.entries) {
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0);
      c.writeUInt16LE(20, 4);
      c.writeUInt16LE(20, 6);
      c.writeUInt16LE(0x0800, 8);
      c.writeUInt16LE(0, 10);
      c.writeUInt16LE(this.stamp.time, 12);
      c.writeUInt16LE(this.stamp.date, 14);
      c.writeUInt32LE(e.crc, 16);
      c.writeUInt32LE(e.size, 20);
      c.writeUInt32LE(e.size, 24);
      c.writeUInt16LE(e.name.length, 28);
      c.writeUInt32LE(e.offset, 42);
      this.write(c);
      this.write(e.name);
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(this.offset - start, 12);
    end.writeUInt32LE(start, 16);
    this.write(end);
    fs.closeSync(this.fd);
  }

  /** 途中でやめたとき：書きかけのファイルを消す。 */
  abort() {
    fs.closeSync(this.fd);
    fs.rmSync(this.path, { force: true });
  }
}
