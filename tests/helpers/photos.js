// Synthetic JPEG: structurally valid (markers and lengths), not decodable.
const segment = (marker, body) => {
  const head = Buffer.alloc(4);
  head.writeUInt16BE(0xff00 | marker, 0);
  head.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([head, body]);
};
const marker = (code) => Buffer.from([0xff, code]);
const u16 = (value) => {
  const out = Buffer.alloc(2);
  out.writeUInt16BE(value);
  return out;
};

export function jpeg({ exif = true, width = 2, height = 2, trailer = false, progressive = false } = {}) {
  const parts = [
    marker(0xd8),
    segment(0xe0, Buffer.from('JFIF', 'latin1')),
  ];
  if (exif) parts.push(segment(0xe1, Buffer.concat([Buffer.from('Exif', 'latin1'), Buffer.from([0, 0]), Buffer.from('GPSLatitude48.8566', 'latin1')])));
  parts.push(
    segment(0xfe, Buffer.from('secret', 'latin1')),
    segment(0xdb, Buffer.alloc(65, 0x10)),
    segment(progressive ? 0xc2 : 0xc0, Buffer.concat([
      Buffer.from([8]), u16(height), u16(width),
      Buffer.from([3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1]),
    ])),
    segment(0xc4, Buffer.alloc(20, 0x21)),
    segment(0xda, Buffer.from([3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0])),
    Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56]),
  );
  if (progressive) {
    parts.push(
      segment(0xc4, Buffer.alloc(20, 0x22)),
      segment(0xda, Buffer.from([3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0])),
      Buffer.from([0x78, 0x9a]),
    );
  }
  parts.push(marker(0xd9));
  if (trailer) parts.push(Buffer.from('SAMSUNG-GPS-TRAILER', 'latin1'));
  return Buffer.concat(parts);
}
