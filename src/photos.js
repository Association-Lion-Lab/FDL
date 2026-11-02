const MAX_SIDE = 8000;

// Drop APPn, COM and anything after EOI. Returns null unless the input is a well-formed JPEG.
export function stripJpeg(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  const kept = [buffer.subarray(0, 2)];
  let pos = 2;
  let sawFrame = false;
  let sawScan = false;
  while (pos < buffer.length) {
    if (buffer[pos] !== 0xff) return null;
    while (buffer[pos] === 0xff) pos += 1; // fill bytes
    const code = buffer[pos];
    pos += 1;
    if (code === undefined || code === 0x00 || code === 0xd8) return null;
    if (code === 0xd9) {
      if (!sawFrame || !sawScan) return null;
      kept.push(Buffer.from([0xff, 0xd9]));
      return Buffer.concat(kept);
    }
    if (code === 0x01 || (code >= 0xd0 && code <= 0xd7)) {
      kept.push(Buffer.from([0xff, code]));
      continue;
    }
    if (pos + 2 > buffer.length) return null;
    const length = buffer.readUInt16BE(pos);
    if (length < 2 || pos + length > buffer.length) return null;
    const end = pos + length;
    const isFrame = code >= 0xc0 && code <= 0xcf && code !== 0xc4 && code !== 0xc8 && code !== 0xcc;
    if (isFrame) {
      if (length < 8) return null;
      const height = buffer.readUInt16BE(pos + 3);
      const width = buffer.readUInt16BE(pos + 5);
      if (!height || !width || height > MAX_SIDE || width > MAX_SIDE) return null;
      sawFrame = true;
    }
    if (!(code >= 0xe0 && code <= 0xef) && code !== 0xfe) kept.push(Buffer.concat([Buffer.from([0xff, code]), buffer.subarray(pos, end)]));
    pos = end;
    if (code === 0xda) {
      sawScan = true;
      // Entropy-coded data runs to the next marker that is not a stuffed FF00 or an RSTn.
      let next = pos;
      while (next < buffer.length) {
        if (buffer[next] === 0xff) {
          const after = buffer[next + 1];
          if (after === undefined) return null;
          if (after !== 0x00 && !(after >= 0xd0 && after <= 0xd7)) break;
          next += 2;
        } else next += 1;
      }
      kept.push(buffer.subarray(pos, next));
      pos = next;
    }
  }
  return null;
}
