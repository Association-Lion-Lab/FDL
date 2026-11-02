import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { stripJpeg } from '../src/photos.js';
import { jpeg } from './helpers/photos.js';

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
  it('refuse une longueur de segment qui dépasse le fichier', () => {
    const b = Buffer.from(jpeg());
    b.writeUInt16BE(0xffff, 4); // longueur de APP0
    assert.equal(stripJpeg(b), null);
  });
});
