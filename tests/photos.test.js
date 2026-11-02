import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { migrate } from '../src/db.js';
import { publishVersion } from '../src/recipes.js';
import { savePhoto, stripJpeg, sweepPhotos } from '../src/photos.js';
import { createTestDatabase } from './helpers/db.js';
import { jpeg } from './helpers/photos.js';
import { recipe } from './helpers/recipes.js';

describe('stripJpeg', () => {
  it('retire APPn et COM, garde le reste', () => {
    const out = stripJpeg(jpeg());
    assert.ok(out);
    assert.equal(out.indexOf('Exif'), -1);
    assert.equal(out.indexOf('GPSLatitude'), -1);
    assert.equal(out.indexOf('JFIF'), -1);
    assert.equal(out.indexOf('secret'), -1);
    assert.deepEqual([...out.subarray(0, 2)], [0xff, 0xd8]);
    assert.deepEqual([...out.subarray(-2)], [0xff, 0xd9]);
    assert.notEqual(out.indexOf(Buffer.from([0xff, 0xc0])), -1);
    assert.notEqual(out.indexOf(Buffer.from([0xff, 0xda])), -1);
  });
  it('garde les données compressées intactes (FF00, FFD0)', () => {
    assert.notEqual(stripJpeg(jpeg()).indexOf(Buffer.from([0xff, 0x00])), -1);
    assert.notEqual(stripJpeg(jpeg()).indexOf(Buffer.from([0xff, 0xd0])), -1);
  });
  it('JPEG progressif : garde les deux balayages', () => {
    const out = stripJpeg(jpeg({ progressive: true }));
    assert.equal(out.toString('latin1').split('\xff\xda').length - 1, 2);
  });
  it('coupe tout ce qui suit EOI', () => {
    assert.equal(stripJpeg(jpeg({ trailer: true })).indexOf('SAMSUNG'), -1);
  });
  it('sans EXIF, le résultat est identique à la sortie avec EXIF', () => {
    assert.deepEqual(stripJpeg(jpeg({ exif: false })), stripJpeg(jpeg()));
  });
  it('refuse ce qui n est pas un JPEG accepté', () => {
    const good = jpeg();
    for (const bad of [
      Buffer.from('<html>'), Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(0),
      good.subarray(0, good.indexOf(Buffer.from([0xff, 0xda]))), // tronqué avant SOS
      good.subarray(0, good.length - 2), // pas d'EOI
      jpeg({ width: 8001 }), jpeg({ height: 0 }),
    ]) assert.equal(stripJpeg(bad), null);
  });
  it('refuse un segment hors liste blanche (JPGn caché, frame sans perte)', () => {
    const good = jpeg();
    const sos = good.indexOf(Buffer.from([0xff, 0xda]));
    const body = Buffer.from('GPSLatitude', 'latin1');
    const hidden = Buffer.concat([
      good.subarray(0, 2), Buffer.from([0xff, 0xf0, 0, body.length + 2]), body, good.subarray(2),
    ]);
    assert.ok(hidden.indexOf('GPSLatitude') !== -1);
    assert.equal(stripJpeg(hidden), null);
    const lossless = Buffer.from(good);
    lossless[lossless.indexOf(Buffer.from([0xff, 0xc0])) + 1] = 0xc3;
    assert.equal(stripJpeg(lossless), null);
    assert.ok(sos > 0);
  });
  it('refuse un SOS avant tout SOF', () => {
    const good = jpeg({ exif: false });
    const sof = good.indexOf(Buffer.from([0xff, 0xc0]));
    const sos = good.indexOf(Buffer.from([0xff, 0xda]));
    const eoi = good.length - 2;
    const swapped = Buffer.concat([
      good.subarray(0, sof), good.subarray(sos, eoi), good.subarray(sof, sos), good.subarray(eoi),
    ]);
    assert.equal(stripJpeg(swapped), null);
  });
  it('accepte exactement 8000 x 8000', () => {
    assert.ok(stripJpeg(jpeg({ width: 8000, height: 8000 })));
  });
  it('refuse une longueur de segment qui dépasse le fichier', () => {
    const b = Buffer.from(jpeg());
    b.writeUInt16BE(0xffff, 4); // longueur de APP0
    assert.equal(stripJpeg(b), null);
  });
});

describe('savePhoto et sweepPhotos', () => {
  let testDb;
  let pool;
  let dir;
  const hex = (c) => c.repeat(64);

  beforeEach(async () => {
    testDb = await createTestDatabase();
    pool = testDb.pool;
    await migrate(pool);
    dir = await mkdtemp(join(tmpdir(), 'fdl-photos-'));
  });
  afterEach(async () => {
    await testDb.drop();
    await rm(dir, { recursive: true, force: true });
  });

  const put = async (name) => {
    await mkdir(join(dir, 'photos'), { recursive: true });
    await writeFile(join(dir, 'photos', `${name}.jpg`), 'x');
  };
  const files = () => readdir(join(dir, 'photos')).then((l) => l.sort());
  // a is cited by a visible version, b only by a draft, c by nobody.
  async function setup() {
    const { id } = await publishVersion(pool, { fields: recipe({ photo: { file: hex('a'), credit: 'Léa' } }) });
    await pool.query("INSERT INTO recipes (draft) VALUES ($1)", [JSON.stringify({ photo: { file: hex('b'), credit: 'Zoé' } })]);
    for (const c of ['a', 'b', 'c']) await put(hex(c));
    return id;
  }

  it('savePhoto stocke sous le sha256 et vide tmp', async () => {
    const buf = stripJpeg(jpeg());
    const hash = await savePhoto(dir, buf);
    assert.equal(hash, createHash('sha256').update(buf).digest('hex'));
    assert.deepEqual(await readFile(join(dir, 'photos', `${hash}.jpg`)), buf);
    assert.deepEqual(await readdir(join(dir, 'tmp')), []);
  });
  it('efface seulement le fichier non cité, après le délai', async () => {
    await setup();
    assert.equal(await sweepPhotos(pool, dir, { now: Date.now() }), 0);
    assert.equal((await files()).length, 3);
    assert.equal(await sweepPhotos(pool, dir, { now: Date.now() + 3600000 }), 1);
    assert.deepEqual(await files(), [`${hex('a')}.jpg`, `${hex('b')}.jpg`]);
  });
  it('une recette retirée ne cite plus rien', async () => {
    const id = await setup();
    await pool.query('UPDATE recipes SET removed_at = now() WHERE id = $1', [id]);
    assert.equal(await sweepPhotos(pool, dir, { now: Date.now() + 3600000 }), 2);
    assert.deepEqual(await files(), [`${hex('b')}.jpg`]);
  });
  it('ignore les autres noms et un dossier absent', async () => {
    assert.equal(await sweepPhotos(pool, dir), 0);
    await put(hex('c'));
    await writeFile(join(dir, 'photos', 'notes.txt'), 'x');
    const old = new Date(Date.now() - 3600000);
    await utimes(join(dir, 'photos', 'notes.txt'), old, old);
    assert.equal(await sweepPhotos(pool, dir, { now: Date.now() + 3600000 }), 1);
    assert.deepEqual(await files(), ['notes.txt']);
  });
});
