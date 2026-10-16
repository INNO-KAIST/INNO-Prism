// h5wasm 파일 열기 헬퍼 (검사 전용)
//
// h5wasm/node 는 emscripten FS 의 루트("/")에 실제 파일시스템을 NODEFS 로 마운트한다.
// 따라서 (a) 실제 경로를 그대로 열 수 있고, (b) "/t.h5" 같은 절대경로 쓰기는
// 실제 루트에 쓰려는 시도가 되어 EACCES(Permission denied)로 실패한다.
// 예전 검사들이 "/tmp.h5" 에 복사한 뒤 열던 방식은 이 때문에 깨졌다.
//
// 이 헬퍼는 실경로 직접 열기를 먼저 시도하고, 실패할 때만(다른 빌드/브라우저 FS 등)
// 쓰기 가능한 가상 경로로 복사해서 연다. 특정 환경에 맞춘 하드코딩을 두지 않는다.
import fs from "fs";
import os from "os";
import { join } from "path";

let memDir = null;
function writableDir(Module) {
  if (memDir) return memDir;
  const FS = Module.FS;
  for (const d of ["/prism-test-tmp"]) {
    try { FS.mkdir(d); } catch (e) { /* 이미 있거나 루트가 읽기전용 */ }
    try {
      FS.mount(FS.filesystems.MEMFS, {}, d);
    } catch (e) { /* 이미 마운트됨 */ }
    try {
      FS.writeFile(d + "/.probe", new Uint8Array([0]));
      memDir = d;
      return d;
    } catch (e) { /* 다음 후보 */ }
  }
  // 최후: 호스트 임시 디렉터리 (NODEFS 루트가 있을 때만 유효)
  const d = fs.mkdtempSync(join(os.tmpdir(), "prism-h5-"));
  memDir = d;
  return d;
}

export function openH5(h5wasm, Module, realPath) {
  try {
    return new h5wasm.File(realPath, "r");
  } catch (e) {
    const dir = writableDir(Module);
    const vpath = dir + "/" + String(realPath).split(/[\\/]/).pop();
    Module.FS.writeFile(vpath, new Uint8Array(fs.readFileSync(realPath)));
    return new h5wasm.File(vpath, "r");
  }
}
