'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const { sequelize, AuditLog } = require('../src/models');
const repository = require('../src/repositories/siteLogoRepository');
const service = require('../src/services/siteLogoService');
const { handleLogoUpload } = require('../src/middlewares/upload');

const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const GIF89 = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(32)]);
const GIF87 = Buffer.concat([Buffer.from('GIF87a'), Buffer.alloc(32)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
const EXE = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64)]);

// Never write audit rows to a real DB from tests.
AuditLog.create = async (v) => v;

const f = (originalname, mimetype, buffer) => ({ originalname, mimetype, buffer });
const code = (fn) => {
  try { fn(); } catch (e) { return e.statusCode; }
  return null;
};

test('validateLogoFile accepts real JPG / PNG / GIF headers', () => {
  assert.equal(service.validateLogoFile(f('a.jpg', 'image/jpeg', JPG)).mime, 'image/jpeg');
  assert.equal(service.validateLogoFile(f('a.JPEG', 'image/jpeg', JPG)).mime, 'image/jpeg');
  assert.equal(service.validateLogoFile(f('a.png', 'image/png', PNG)).mime, 'image/png');
  assert.equal(service.validateLogoFile(f('a.gif', 'image/gif', GIF89)).mime, 'image/gif');
  assert.equal(service.validateLogoFile(f('a.gif', 'image/gif', GIF87)).mime, 'image/gif');
});

test('validateLogoFile rejects SVG, executables, renamed files and mismatches with 422', () => {
  assert.equal(code(() => service.validateLogoFile(f('a.svg', 'image/svg+xml', SVG))), 422);
  assert.equal(code(() => service.validateLogoFile(f('a.png', 'image/png', SVG))), 422); // SVG renamed
  assert.equal(code(() => service.validateLogoFile(f('a.png', 'image/png', EXE))), 422); // exe renamed
  assert.equal(code(() => service.validateLogoFile(f('a.exe', 'application/octet-stream', EXE))), 422);
  assert.equal(code(() => service.validateLogoFile(f('a.png', 'image/png', JPG))), 422); // wrong signature
  assert.equal(code(() => service.validateLogoFile(f('a.png', 'image/jpeg', PNG))), 422); // wrong declared mime
  assert.equal(code(() => service.validateLogoFile(null)), 422);
  assert.equal(code(() => service.validateLogoFile(f('a.png', 'image/png', Buffer.alloc(0)))), 422);
});

test('validateLogoFile enforces the 5 MB limit', () => {
  const ok = Buffer.concat([PNG, Buffer.alloc(service.MAX_LOGO_BYTES - PNG.length)]);
  assert.equal(ok.length, service.MAX_LOGO_BYTES);
  assert.equal(service.validateLogoFile(f('a.png', 'image/png', ok)).mime, 'image/png');
  const big = Buffer.concat([ok, Buffer.alloc(1)]);
  assert.equal(code(() => service.validateLogoFile(f('a.png', 'image/png', big))), 413);
});

test('upload middleware: oversize file becomes a clean 413 JSON error', async () => {
  const app = express();
  app.post('/logos', handleLogoUpload, (req, res) => res.json({ got: !!req.file }));
  const server = http.createServer(app).listen(0);
  try {
    const { port } = server.address();
    const send = async (size) => {
      const fd = new FormData();
      fd.append('file', new Blob([Buffer.alloc(size, 1)], { type: 'image/png' }), 'big.png');
      return fetch(`http://127.0.0.1:${port}/logos`, { method: 'POST', body: fd });
    };
    const big = await send(service.MAX_LOGO_BYTES + 10);
    assert.equal(big.status, 413);
    const body = await big.json();
    assert.equal(body.success, false);
    assert.match(body.message, /5 MB/);
    const small = await send(100);
    assert.equal(small.status, 200);
  } finally {
    server.close();
  }
});

test('listLogos never exposes bytes and shapes the contract', async () => {
  const orig = repository.findAll;
  repository.findAll = async () => [{
    toJSON: () => ({
      id: 3, file_name: 'x.png', mime_type: 'image/png', file_size: 10, is_active: true,
      created_at: 'now', uploaded_by: 1, image_data: Buffer.from('secret'), uploader: { full_name: 'Admin' },
    }),
  }];
  try {
    const [item] = await service.listLogos();
    assert.deepEqual(Object.keys(item).sort(), [
      'created_at', 'file_name', 'file_size', 'id', 'image_path', 'is_active', 'mime_type', 'uploaded_by_name',
    ]);
    assert.equal(item.image_path, '/system-settings/logos/3/image');
    assert.equal(item.uploaded_by_name, 'Admin');
    assert.ok(!JSON.stringify(item).includes('secret'));
  } finally { repository.findAll = orig; }
});

test('getActiveLogo returns null when none is active, else the public shape', async () => {
  const orig = repository.findActive;
  try {
    repository.findActive = async () => null;
    assert.equal(await service.getActiveLogo(), null);
    repository.findActive = async () => ({ id: 7, file_name: 'l.gif', updated_at: 'u' });
    assert.deepEqual(await service.getActiveLogo(), {
      id: 7, image_path: '/system-settings/logos/7/image', file_name: 'l.gif', updated_at: 'u',
    });
  } finally { repository.findActive = orig; }
});

test('activateLogo deactivates all then activates exactly the chosen row in one transaction', async () => {
  const calls = [];
  const saved = {
    tx: sequelize.transaction, exists: repository.exists, dea: repository.deactivateAll,
    act: repository.activateById, findActive: repository.findActive, findById: repository.findById,
  };
  const TX = { id: 'tx' };
  sequelize.transaction = async (cb) => { calls.push('begin'); const r = await cb(TX); calls.push('commit'); return r; };
  repository.exists = async (id, t) => { calls.push(['exists', id, t === TX]); return id === 5; };
  repository.deactivateAll = async (t) => { calls.push(['deactivateAll', t === TX]); };
  repository.activateById = async (id, t) => { calls.push(['activate', id, t === TX]); };
  repository.findActive = async () => null;
  repository.findById = async (id) => ({
    toJSON: () => ({ id, file_name: 'a', mime_type: 'image/png', file_size: 1, is_active: true, created_at: 'c' }),
  });
  try {
    const item = await service.activateLogo('5', 1, '::1');
    assert.equal(item.id, 5);
    assert.deepEqual(calls, ['begin', ['exists', 5, true], ['deactivateAll', true], ['activate', 5, true], 'commit']);

    calls.length = 0;
    await assert.rejects(() => service.activateLogo('99', 1, '::1'), (e) => e.statusCode === 404);
    assert.ok(!calls.some((c) => Array.isArray(c) && c[0] === 'deactivateAll'), 'missing id must not deactivate anything');
    await assert.rejects(() => service.activateLogo('abc', 1, '::1'), (e) => e.statusCode === 404);
  } finally {
    sequelize.transaction = saved.tx; repository.exists = saved.exists; repository.deactivateAll = saved.dea;
    repository.activateById = saved.act; repository.findActive = saved.findActive; repository.findById = saved.findById;
  }
});

test('getLogoImage returns null for unknown / invalid ids', async () => {
  const orig = repository.findImageById;
  repository.findImageById = async () => null;
  try {
    assert.equal(await service.getLogoImage('1'), null);
    assert.equal(await service.getLogoImage('x'), null);
  } finally { repository.findImageById = orig; }
});
