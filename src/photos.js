import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Cyclic with recipes.js (which needs PHOTO_FILE); fine, VISIBLE is only read at call time.
import { VISIBLE } from './recipes.js';

export const PHOTO_FILE = /^[0-9a-f]{64}$/;
const MAX_SIDE = 8000;

export const photoPath = (dataDir, file) => join(dataDir, 'photos', `${file}.jpg`);

// Stores an already stripped JPEG under its sha256; tmp + rename so a reader never sees a partial file.
export async function savePhoto(dataDir, jpegBuffer) {
  const hash = createHash('sha256').update(jpegBuffer).digest('hex');
  await mkdir(join(dataDir, 'photos'), { recursive: true });
  await mkdir(join(dataDir, 'tmp'), { recursive: true });
  const tmp = join(dataDir, 'tmp', randomUUID());
  await writeFile(tmp, jpegBuffer);
  await rename(tmp, photoPath(dataDir, hash));
  return hash;
}

// Deletes photo files no live recipe cites (version or draft) once older than graceMs, which covers an upload
// whose file is written before its draft. Returns the number deleted.
export async function sweepPhotos(db, dataDir, { graceMs = 600000, now = Date.now() } = {}) {
  let names;
  try {
    names = await readdir(join(dataDir, 'photos'));
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
  const files = names.filter((n) => n.endsWith('.jpg') && PHOTO_FILE.test(n.slice(0, -4))).map((n) => n.slice(0, -4));
  if (!files.length) return 0;
  const { rows } = await db.query(
    `SELECT v.photo AS file FROM recipe_versions v JOIN recipes r ON r.id = v.recipe_id
      WHERE r.removed_at IS NULL AND v.photo = ANY($1)
     UNION
     SELECT r.draft->'photo'->>'file' FROM recipes r
      WHERE r.removed_at IS NULL AND r.draft->'photo'->>'file' = ANY($1)`,
    [files]
  );
  const cited = new Set(rows.map((row) => row.file));
  let deleted = 0;
  for (const file of files) {
    if (cited.has(file)) continue;
    const path = photoPath(dataDir, file);
    try {
      if (now - (await stat(path)).mtimeMs <= graceMs) continue;
      await unlink(path);
      deleted += 1;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return deleted;
}

// Who may fetch a photo: anyone for a visible published version; the author for any of their own
// (draft or version, recipe not removed); staff for any version.
export async function canSeePhoto(db, file, { accountId, staff }) {
  if (typeof file !== 'string' || !PHOTO_FILE.test(file)) return false;
  const pub = await db.query(`SELECT 1 ${VISIBLE} AND v.photo = $1 LIMIT 1`, [file]);
  if (pub.rowCount) return true;
  const own = await db.query(
    `SELECT 1 FROM recipes r WHERE
       (r.removed_at IS NULL AND r.author_id = $2 AND (r.draft->'photo'->>'file' = $1
          OR EXISTS (SELECT 1 FROM recipe_versions w WHERE w.recipe_id = r.id AND w.photo = $1)))
       OR ($3 AND EXISTS (SELECT 1 FROM recipe_versions w WHERE w.recipe_id = r.id AND w.photo = $1))
     LIMIT 1`,
    [file, accountId, staff]
  );
  return own.rowCount > 0;
}
// SOF0-2, DHT, DQT, DRI, SOS.
const KEEP = new Set([0xc0, 0xc1, 0xc2, 0xc4, 0xdb, 0xdd, 0xda]);

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
    if (code >= 0xd0 && code <= 0xd7) {
      kept.push(Buffer.from([0xff, code]));
      continue;
    }
    // Allowlist: anything else (JPGn, reserved, lossless/arithmetic frames) could hide data or not render.
    const drop = (code >= 0xe0 && code <= 0xef) || code === 0xfe;
    if (!drop && !KEEP.has(code)) return null;
    if (code === 0xda && !sawFrame) return null;
    if (pos + 2 > buffer.length) return null;
    const length = buffer.readUInt16BE(pos);
    if (length < 2 || pos + length > buffer.length) return null;
    const end = pos + length;
    if (code <= 0xc2 && code >= 0xc0) {
      if (length < 8) return null;
      const height = buffer.readUInt16BE(pos + 3);
      const width = buffer.readUInt16BE(pos + 5);
      if (!height || !width || height > MAX_SIDE || width > MAX_SIDE) return null;
      sawFrame = true;
    }
    if (!drop) kept.push(Buffer.concat([Buffer.from([0xff, code]), buffer.subarray(pos, end)]));
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
