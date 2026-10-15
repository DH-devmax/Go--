// Wire layout: OBS Studio 32.0.4 plugins/win-dshow/shared-memory-queue.c.
// This producer supports the Windows x64 ABI and NV12 frames only.
const { WIDTH, HEIGHT, FPS } = require('./video-profile.cjs');
const { CAMERA_MAPPING } = require('./camera-device.cjs');
const FRAME_BYTES = WIDTH * HEIGHT * 3 / 2;
const RGBA_BYTES = WIDTH * HEIGHT * 4;
const align = size => Math.ceil(size / 32) * 32;
const OFFSETS = [0, 1, 2].map(i => 96 + i * align(FRAME_BYTES + 32));
const MAPPING_BYTES = OFFSETS[2] + align(FRAME_BYTES + 32);

function header() {
  const value = Buffer.alloc(96);
  value.writeUInt32LE(1, 8); // STARTING; READY is published after a complete frame.
  OFFSETS.forEach((offset, i) => value.writeUInt32LE(offset, 12 + i * 4));
  value.writeUInt32LE(WIDTH, 28);
  value.writeUInt32LE(HEIGHT, 32);
  value.writeBigUInt64LE(BigInt(Math.round(10000000 / FPS)), 40);
  return value;
}

class VideoQueue {
  constructor(memory) {
    this.memory = memory;
    this.index = 0;
    try { memory.write(0, header()); }
    catch (error) { memory.close(); this.memory = null; throw error; }
  }
  publish(frame, timestamp = process.hrtime.bigint() / 100n) {
    if (!this.memory) throw new Error('虚拟摄像头已停止。');
    if (frame.length !== FRAME_BYTES) throw new Error('虚拟摄像头帧长度不正确。');
    this.index = (this.index + 1) >>> 0;
    const offset = OFFSETS[this.index % 3];
    const stamp = Buffer.alloc(8);
    stamp.writeBigUInt64LE(timestamp);
    this.memory.writeU32(0, this.index);
    this.memory.write(offset, stamp);
    this.memory.write(offset + 32, frame);
    // Publish only after the frame copy; the aligned 32-bit index is atomic on x64.
    this.memory.writeU32(4, this.index);
    this.memory.writeU32(8, 2);
  }
  close() {
    if (!this.memory) return;
    const memory = this.memory;
    this.memory = null;
    try { memory.writeU32(8, 3); } finally { memory.close(); }
  }
}

function openWindowsMemory() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('虚拟摄像头目前仅支持 Windows x64。');
  const koffi = require('koffi');
  const kernel = koffi.load('kernel32.dll');
  const create = kernel.func('void * __stdcall CreateFileMappingW(void *, void *, uint32_t, uint32_t, uint32_t, str16)');
  const open = kernel.func('void * __stdcall OpenFileMappingW(uint32_t, int, str16)');
  const map = kernel.func('void * __stdcall MapViewOfFile(void *, uint32_t, uint32_t, uint32_t, size_t)');
  const unmap = kernel.func('int __stdcall UnmapViewOfFile(void *)');
  const close = kernel.func('int __stdcall CloseHandle(void *)');
  const lastError = kernel.func('uint32_t __stdcall GetLastError()');
  const clearError = kernel.func('void __stdcall SetLastError(uint32_t)');
  const copy = koffi.load('msvcrt.dll').func('void * __cdecl memcpy(void *, const void *, size_t)');
  const occupied = '虚拟摄像头正被其他输出占用，或会议端尚未释放上次会话。请停止其他虚拟摄像头输出，稍后重试。';
  const existing = open(4, 0, CAMERA_MAPPING);
  if (existing) { close(existing); throw new Error(occupied); }
  clearError(0);
  const handle = create(0xffffffffffffffffn, null, 4, 0, MAPPING_BYTES, CAMERA_MAPPING);
  const error = lastError();
  if (!handle) throw new Error(`无法创建虚拟摄像头共享内存，Windows 错误 ${error}。`);
  if (error === 183) {
    close(handle);
    throw new Error(occupied);
  }
  const pointer = map(handle, 0xF001F, 0, 0, MAPPING_BYTES);
  if (!pointer) { const code = lastError(); close(handle); throw new Error(`无法映射虚拟摄像头内存，Windows 错误 ${code}。`); }
  return mappedMemory(pointer, koffi, copy, () => {
    try { unmap(pointer); } finally { close(handle); }
  });
}

function mappedMemory(pointer, koffi, copy, release) {
  const base = koffi.address(pointer);
  let closed = false;
  const scalar = Buffer.alloc(4);
  return {
    write(offset, data) {
      if (closed || offset < 0 || offset + data.length > MAPPING_BYTES) throw new Error('虚拟摄像头内存写入无效。');
      copy(base + BigInt(offset), data, data.length);
    },
    writeU32(offset, value) {
      if (closed || ![0, 4, 8].includes(offset)) throw new Error('虚拟摄像头状态写入无效。');
      // encode() requires a reference, not address arithmetic expressed as a BigInt.
      scalar.writeUInt32LE(value);
      copy(base + BigInt(offset), scalar, scalar.length);
    },
    close() { if (closed) return; closed = true; release(); },
  };
}

module.exports = { WIDTH, HEIGHT, FPS, FRAME_BYTES, RGBA_BYTES, OFFSETS, MAPPING_BYTES, header, VideoQueue, mappedMemory, openWindowsMemory };
