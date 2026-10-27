import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { loadConfig } from '../src/config.js';

const pg = { PGHOST: 'db', PGDATABASE: 'fdl', PGUSER: 'fdl' };
let tmp;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fdl-config-'));
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('loadConfig', () => {
  it('returns defaults for a minimal valid environment', () => {
    assert.deepEqual(loadConfig({ ...pg, FDL_DATA_DIR: tmp }), {
      host: '127.0.0.1', port: 3000, dataDir: tmp, pgBinDir: '',
    });
  });

  it('returns a frozen result', () => {
    assert.ok(Object.isFrozen(loadConfig({ ...pg, FDL_DATA_DIR: tmp })));
  });

  it('reads optional values', () => {
    const config = loadConfig({ ...pg, FDL_DATA_DIR: tmp, FDL_PG_BIN_DIR: '/usr/bin', PORT: '8080', HOST: '0.0.0.0' });
    assert.equal(config.pgBinDir, '/usr/bin');
    assert.equal(config.port, 8080);
    assert.equal(config.host, '0.0.0.0');
  });

  it('treats an empty HOST as the default', () => {
    assert.equal(loadConfig({ ...pg, FDL_DATA_DIR: tmp, HOST: '' }).host, '127.0.0.1');
  });

  it('rejects a missing FDL_DATA_DIR', () => {
    assert.throws(() => loadConfig({ ...pg }), /FDL_DATA_DIR/);
  });

  it('rejects a relative FDL_DATA_DIR', () => {
    assert.throws(() => loadConfig({ ...pg, FDL_DATA_DIR: 'relative/dir' }), /FDL_DATA_DIR.*absolu/);
  });

  it('rejects a missing directory without creating it', () => {
    const missing = path.join(tmp, 'missing');
    assert.throws(() => loadConfig({ ...pg, FDL_DATA_DIR: missing }), /FDL_DATA_DIR.*existe/);
    assert.equal(fs.existsSync(missing), false);
  });

  it('rejects a file used as FDL_DATA_DIR', () => {
    const file = path.join(tmp, 'file.txt');
    fs.writeFileSync(file, '');
    assert.throws(() => loadConfig({ ...pg, FDL_DATA_DIR: file }), /FDL_DATA_DIR/);
  });

  it('rejects an invalid PORT', () => {
    assert.throws(() => loadConfig({ ...pg, FDL_DATA_DIR: tmp, PORT: '3000.5' }), /PORT/);
  });

  it('requires PGHOST, then PGDATABASE, then PGUSER', () => {
    const base = { FDL_DATA_DIR: tmp };
    assert.throws(() => loadConfig(base), /PGHOST/);
    assert.throws(() => loadConfig({ ...base, PGHOST: 'db' }), /PGDATABASE/);
    assert.throws(() => loadConfig({ ...base, PGHOST: 'db', PGDATABASE: 'fdl' }), /PGUSER/);
  });
});
