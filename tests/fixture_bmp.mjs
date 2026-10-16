/* 픽스처 BMP 생성 — 8-bit gray 평면(gz)에서 24bpp 무손실 BMP 를 복원한다.
 *
 * 왜 BMP 를 저장소에 그대로 두지 않는가:
 *   무압축 24bpp BMP 는 1360×1024 에서 4.18 MB 다. 픽셀값은 gray 라 3채널이 모두
 *   같고, 8-bit 평면만 gz 로 두면 0.21–0.46 MB 다(합 8.4 MB → 0.66 MB).
 *   복원된 파일은 원본과 **바이트 단위로 동일**하므로 어떤 단정도 바뀌지 않는다.
 *   (`tests/prism_repro/beam_full_gray16.bin.gz` 가 이미 쓰던 방식과 같다.)
 *
 * 주의: BMP 헤더의 해상도 필드(xppm/yppm)는 원본 그대로 2835(72 dpi)를 쓴다.
 * 0 으로 두어도 canvas 디코드 결과는 같지만, 그러면 파일 md5 가 원본과 달라져
 * "원본과 같은 파일인가" 를 확인할 수단이 사라진다.
 */
import fs from "fs";
import zlib from "zlib";
import os from "os";
import { join } from "path";

export function writeBmp(path, gray8, w, h, opts) {
  const ppm = (opts && opts.ppm) != null ? opts.ppm : 2835;
  const rowBytes = w * 3, pad = (4 - (rowBytes % 4)) % 4, stride = rowBytes + pad;
  const dataSize = stride * h, off = 54;
  const buf = Buffer.alloc(off + dataSize);
  buf.write("BM", 0); buf.writeUInt32LE(off + dataSize, 2); buf.writeUInt32LE(off, 10);
  buf.writeUInt32LE(40, 14); buf.writeInt32LE(w, 18); buf.writeInt32LE(h, 22);
  buf.writeUInt16LE(1, 26); buf.writeUInt16LE(24, 28); buf.writeUInt32LE(0, 30);
  buf.writeUInt32LE(dataSize, 34);
  buf.writeInt32LE(ppm, 38); buf.writeInt32LE(ppm, 42);
  for (let y = 0; y < h; y++) {                 // BMP 는 bottom-up
    const sy = h - 1 - y, ro = off + y * stride;
    for (let x = 0; x < w; x++) {
      const v = gray8[sy * w + x], o = ro + x * 3;
      buf[o] = v; buf[o + 1] = v; buf[o + 2] = v;
    }
  }
  fs.writeFileSync(path, buf);
  return path;
}

/** gz 로 저장된 8-bit gray 평면을 읽는다. 길이가 w×h 와 다르면 즉시 실패시킨다
 *  (치수를 테스트가 하드코딩하므로, 불일치를 조용히 넘기면 안 된다). */
export function grayFromGz(gzPath, w, h) {
  const raw = zlib.gunzipSync(fs.readFileSync(gzPath));
  if (raw.length !== w * h) {
    throw new Error(`${gzPath}: ${raw.length} B — ${w}×${h}=${w * h} 와 다릅니다`);
  }
  return new Uint8Array(raw.buffer, raw.byteOffset, w * h);
}

/** 픽스처 하나를 임시 폴더에 BMP 로 펼친다. 반환: 경로 (없으면 null) */
export function materialize(dir, gzPath, name, w, h) {
  if (!fs.existsSync(gzPath)) return null;
  return writeBmp(join(dir, name), grayFromGz(gzPath, w, h), w, h);
}

export function tmpDir(tag) {
  return fs.mkdtempSync(join(os.tmpdir(), `prism-${tag}-`));
}
