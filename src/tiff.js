/* =============================================================================
 * INNO Prism — 최소 TIFF 디코더 (v3.17)
 *
 * 왜 만드나: 브라우저 canvas 는 TIFF 를 디코드하지 못하고, 설령 된다 해도
 * `getImageData` 는 **채널당 8-bit** 다. 새 촬영 표준이 16-bit TIFF 인데
 * v3.16 까지는 파일 선택 대화상자에서 고를 수는 있고 **그 다음에 실패**했다.
 *
 * 8-bit 로 깎이는 실측 비용 (260921, 같은 파일, f=1):
 *     Gaussian A_peak   1.3700 → 1.1206 µm²   (+22.3 % 부풀림)
 *     d4sAreaRatio      2.600  → 4.052        (−35.8 %)
 *     fit R²            0.794  → 0.854
 * 원인: 12-bit 기준 양자화 계단 16 ADU 가 이 카메라 read noise(1.89 ADU, photon
 * transfer curve 실측)의 **8.4배**. 꼬리가 한두 계단으로 뭉개진다.
 *
 * 범위: 대상 파일 형식이 매우 단순하므로 거기에 맞춘다 —
 *   · II/MM 양쪽 바이트 순서
 *   · Compression 1 (무압축) 만. LZW·PackBits·JPEG 은 **거부하고 이유를 말한다**
 *     (조용히 틀린 값을 내느니 안 읽는 게 낫다)
 *   · BitsPerSample 8 / 16 / 32(float)
 *   · SamplesPerPixel 1(Gray) / 3(RGB) / 4(RGBA)
 *   · PlanarConfiguration 1 (chunky) · 다중 strip 허용
 *   · SampleFormat 1(uint) / 2(int) / 3(float)
 *
 * 반환값의 `data` 는 **0–255 로 환산된 Float64Array** 다. 원본 계조를 8-bit 로
 * 깎는 것이 아니라 **소수점을 살린 채** 스케일만 맞추는 것이다(12-bit 값 1 은
 * 0.0623 이 된다). 이렇게 해야 하류(감마 되돌리기·주석 검출·무결성 검사)가
 * 8-bit 전제로 쓴 상수들을 그대로 쓰면서도 계조는 잃지 않는다.
 * 양자화 계단이 달라지는 것만 `quantStep` 으로 함께 넘긴다.
 * ========================================================================== */
"use strict";
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PrismTiff = api;
})(typeof self !== "undefined" ? self : this, function () {

const TAG = {
  ImageWidth: 256, ImageLength: 257, BitsPerSample: 258, Compression: 259,
  Photometric: 262, StripOffsets: 273, SamplesPerPixel: 277, RowsPerStrip: 278,
  StripByteCounts: 279, PlanarConfig: 284, SampleFormat: 339, Predictor: 317,
};
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };
const COMPRESSION_NAME = {
  1: "없음", 2: "CCITT G3 1D", 5: "LZW", 6: "구형 JPEG", 7: "JPEG",
  8: "Deflate", 32773: "PackBits", 32946: "Deflate",
};

/** 이 버퍼가 TIFF 인가 (매직만 본다 — 확장자를 믿지 않는다) */
function isTiff(buf) {
  if (!buf || buf.byteLength < 8) return false;
  const v = new DataView(buf.buffer !== undefined && buf.byteLength !== undefined && !(buf instanceof ArrayBuffer)
    ? buf.buffer : buf, buf instanceof ArrayBuffer ? 0 : (buf.byteOffset || 0), 8);
  const b0 = v.getUint8(0), b1 = v.getUint8(1);
  if (b0 === 0x49 && b1 === 0x49) return v.getUint16(2, true) === 42;
  if (b0 === 0x4d && b1 === 0x4d) return v.getUint16(2, false) === 42;
  return false;
}

function readEntryValues(dv, le, off, type, count) {
  const sz = TYPE_SIZE[type] || 1;
  const total = sz * count;
  const base = total <= 4 ? off + 8 : dv.getUint32(off + 8, le);
  const out = [];
  for (let i = 0; i < count; i++) {
    const o = base + i * sz;
    switch (type) {
      case 1: case 7: out.push(dv.getUint8(o)); break;
      case 2: out.push(dv.getUint8(o)); break;
      case 3: out.push(dv.getUint16(o, le)); break;
      case 4: out.push(dv.getUint32(o, le)); break;
      case 5: out.push(dv.getUint32(o, le) / (dv.getUint32(o + 4, le) || 1)); break;
      case 6: out.push(dv.getInt8(o)); break;
      case 8: out.push(dv.getInt16(o, le)); break;
      case 9: out.push(dv.getInt32(o, le)); break;
      case 11: out.push(dv.getFloat32(o, le)); break;
      case 12: out.push(dv.getFloat64(o, le)); break;
      default: out.push(dv.getUint8(o));
    }
  }
  return out;
}

/** 값들의 최대공약수 → "8-bit 를 16-bit 컨테이너에 다시 저장한 파일" 검출용 */
function gcdOfSamples(read, n, stride) {
  const g2 = (a, b) => { while (b) { const t = a % b; a = b; b = t; } return a; };
  let g = 0, seen = 0;
  for (let i = 0; i < n && seen < 20000; i += stride) {
    const v = read(i);
    if (!isFinite(v) || v <= 0 || v !== Math.floor(v)) continue;
    g = g2(g, v); seen++;
    if (g === 1) return 1;
  }
  return g || 1;
}

/**
 * 디코드. 실패하면 **이유가 담긴 Error** 를 던진다 — 일반 예외 메시지만 나오면
 * 사용자는 무엇을 해야 할지 알 수 없다.
 * 반환: {w, h, data(Float64 0–255 gray), rgb?, samples, bitsPerSample, sampleFormat,
 *        photometric, compression, fullScaleNative, effectiveBits, quantStep,
 *        containerBits, maxNative, gcd}
 */
function decodeTiff(input) {
  const ab = input instanceof ArrayBuffer ? input : input.buffer;
  const byteOff = input instanceof ArrayBuffer ? 0 : (input.byteOffset || 0);
  const len = input instanceof ArrayBuffer ? input.byteLength : input.byteLength;
  if (len < 8) throw new Error("TIFF: 파일이 너무 작습니다");
  const dv = new DataView(ab, byteOff, len);
  const b0 = dv.getUint8(0), b1 = dv.getUint8(1);
  let le;
  if (b0 === 0x49 && b1 === 0x49) le = true;
  else if (b0 === 0x4d && b1 === 0x4d) le = false;
  else throw new Error("TIFF 가 아닙니다 (바이트 순서 표식 없음)");
  if (dv.getUint16(2, le) !== 42) throw new Error("TIFF: 버전 표식이 42 가 아닙니다 (BigTIFF 는 지원하지 않습니다)");

  const ifd = dv.getUint32(4, le);
  if (ifd + 2 > len) throw new Error("TIFF: IFD 오프셋이 파일 밖입니다");
  const nEnt = dv.getUint16(ifd, le);
  const tags = {};
  for (let i = 0; i < nEnt; i++) {
    const off = ifd + 2 + i * 12;
    if (off + 12 > len) break;
    const tag = dv.getUint16(off, le), type = dv.getUint16(off + 2, le), count = dv.getUint32(off + 4, le);
    try { tags[tag] = readEntryValues(dv, le, off, type, Math.min(count, 1 << 20)); } catch (e) { /* 손상 항목 무시 */ }
  }
  const one = (t, d) => (tags[t] && tags[t].length ? tags[t][0] : d);
  const w = one(TAG.ImageWidth), h = one(TAG.ImageLength);
  if (!(w > 0 && h > 0)) throw new Error("TIFF: 이미지 크기를 읽을 수 없습니다");

  const comp = one(TAG.Compression, 1);
  if (comp !== 1) {
    throw new Error(`TIFF 압축 방식 ${COMPRESSION_NAME[comp] || comp} 은 아직 지원하지 않습니다 — ` +
      `저장할 때 "압축 없음(uncompressed)" 으로 내보내 주세요. ` +
      `(잘못 읽느니 읽지 않습니다 — 압축을 무시하고 해석하면 조용히 틀린 값이 나옵니다.)`);
  }
  const planar = one(TAG.PlanarConfig, 1);
  if (planar !== 1) throw new Error("TIFF: PlanarConfiguration 2(분리 평면)는 아직 지원하지 않습니다");
  const spp = one(TAG.SamplesPerPixel, 1);
  const bpsArr = tags[TAG.BitsPerSample] || [8];
  const bps = bpsArr[0];
  if (!bpsArr.every((v) => v === bps)) throw new Error(`TIFF: 채널별 비트수가 다릅니다 (${bpsArr.join(",")})`);
  if (![8, 16, 32].includes(bps)) throw new Error(`TIFF: BitsPerSample ${bps} 는 지원하지 않습니다 (8 · 16 · 32)`);
  const sf = (tags[TAG.SampleFormat] && tags[TAG.SampleFormat][0]) || 1;
  if (bps === 32 && sf !== 3) throw new Error("TIFF: 32-bit 은 float(SampleFormat 3) 만 지원합니다");
  const photometric = one(TAG.Photometric, spp >= 3 ? 2 : 1);
  const pred = one(TAG.Predictor, 1);
  if (pred !== 1) throw new Error(`TIFF: Predictor ${pred} 는 아직 지원하지 않습니다`);

  const offsets = tags[TAG.StripOffsets] || [];
  const counts = tags[TAG.StripByteCounts] || [];
  if (!offsets.length) throw new Error("TIFF: StripOffsets 가 없습니다 (타일 TIFF 는 지원하지 않습니다)");
  const rowsPerStrip = one(TAG.RowsPerStrip, h);
  const bytesPerSample = bps / 8;
  const rowBytes = w * spp * bytesPerSample;

  // strip 들을 하나로 잇는다
  const need = rowBytes * h;
  const flat = new Uint8Array(need);
  let wrote = 0;
  for (let si = 0; si < offsets.length; si++) {
    const so = offsets[si];
    const rows = Math.min(rowsPerStrip, h - si * rowsPerStrip);
    if (rows <= 0) break;
    const want = rowBytes * rows;
    const have = counts.length > si ? counts[si] : want;
    const take = Math.min(want, have, len - so);
    if (so < 0 || so >= len || take <= 0) throw new Error(`TIFF: strip ${si} 오프셋이 파일 밖입니다`);
    flat.set(new Uint8Array(ab, byteOff + so, take), wrote);
    wrote += take;
  }
  if (wrote < need) throw new Error(`TIFF: 화소 자료가 부족합니다 (${wrote} / ${need} 바이트)`);

  const sdv = new DataView(flat.buffer, flat.byteOffset, flat.byteLength);
  const readSample = (i) => {
    const o = i * bytesPerSample;
    if (bps === 8) return sf === 2 ? sdv.getInt8(o) : sdv.getUint8(o);
    if (bps === 16) return sf === 2 ? sdv.getInt16(o, le) : sdv.getUint16(o, le);
    return sdv.getFloat32(o, le);
  };
  const nSamples = w * h * spp;

  // 원본 최대값 · 유효 비트깊이
  let maxNative = -Infinity, minNative = Infinity;
  for (let i = 0; i < nSamples; i++) { const v = readSample(i); if (v > maxNative) maxNative = v; if (v < minNative) minNative = v; }
  const containerFull = bps === 32 ? (maxNative > 0 ? maxNative : 1) : (Math.pow(2, bps) - 1);
  const stride = Math.max(1, Math.floor(nSamples / 20000));
  const gcd = bps === 32 ? 1 : gcdOfSamples(readSample, nSamples, stride);
  /* 유효 비트깊이: 모든 값이 g 의 배수면 실제 계조는 containerFull/g 단계뿐이다.
   * 예) 12-bit 값을 <<4 해서 16-bit 로 저장한 파일 → g=16 → 유효 12-bit.
   * "8-bit 를 16-bit 로 다시 저장한 파일"을 이걸로 가려낸다. */
  const fullScaleNative = bps === 32 ? containerFull : Math.floor(containerFull / gcd) * gcd;
  const effectiveBits = bps === 32 ? 32 : Math.round(Math.log2(containerFull / gcd + 1));

  // 0–255 로 환산 (계조는 소수점으로 유지)
  const scale = 255 / (fullScaleNative || 1);
  const data = new Float64Array(w * h);
  let rgb = null;
  if (spp === 1) {
    for (let i = 0; i < w * h; i++) data[i] = readSample(i) * scale;
  } else {
    rgb = { r: new Float64Array(w * h), g: new Float64Array(w * h), b: new Float64Array(w * h) };
    for (let i = 0; i < w * h; i++) {
      const o = i * spp;
      const r = readSample(o) * scale, g = readSample(o + 1) * scale, bb = readSample(o + 2) * scale;
      rgb.r[i] = r; rgb.g[i] = g; rgb.b[i] = bb;
      // canvas 경로와 **같은** 휘도 가중치를 쓴다 (두 경로의 값이 비교 가능해야 한다)
      data[i] = 0.2126 * r + 0.7152 * g + 0.0722 * bb;
    }
  }
  if (photometric === 0) {   // WhiteIsZero
    for (let i = 0; i < data.length; i++) data[i] = 255 - data[i];
    if (rgb) for (const k of ["r", "g", "b"]) for (let i = 0; i < rgb[k].length; i++) rgb[k][i] = 255 - rgb[k][i];
  }

  return {
    w, h, data, rgb, samples: spp, bitsPerSample: bps, sampleFormat: sf,
    photometric, compression: comp, littleEndian: le, nStrips: offsets.length,
    containerBits: bps, maxNative, minNative, gcd,
    fullScaleNative, effectiveBits,
    // 0–255 환산 후의 양자화 계단. 하류 잡음 모델이 1 LSB 를 가정하므로 함께 넘긴다.
    quantStep: bps === 32 ? 0 : (255 * gcd) / (fullScaleNative || 1),
    // 포화 문턱 — 8-bit 의 254 와 같은 보수성 (full scale 한 계단 아래)
    satLevel: 255 * (fullScaleNative - gcd) / (fullScaleNative || 1),
  };
}

return { isTiff, decodeTiff, TAG, COMPRESSION_NAME };
});
