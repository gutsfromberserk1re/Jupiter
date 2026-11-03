import test from 'node:test';
import assert from 'node:assert/strict';
import { detectMediaKind, mediaMime, nativeAssetBase64, setAssetTransfer, hasAssetTransferType, readAssetTransfer } from '../src/modules/media-io.js';

test('detects media by MIME type', () => {
  assert.equal(detectMediaKind('anything.bin', 'image/png'), 'image');
  assert.equal(detectMediaKind('anything.bin', 'audio/mpeg'), 'audio');
});

test('detects common Windows media extensions when MIME is empty', () => {
  assert.equal(detectMediaKind('character.PNG', ''), 'image');
  assert.equal(detectMediaKind('score.M4A', ''), 'audio');
  assert.equal(detectMediaKind('voice.flac', 'application/octet-stream'), 'audio');
  assert.equal(detectMediaKind('project.exe', ''), null);
});

test('provides stable fallback MIME types', () => {
  assert.equal(mediaMime('frame.webp', '', 'image'), 'image/webp');
  assert.equal(mediaMime('voice.mp3', '', 'audio'), 'audio/mpeg');
});

test('writes portable timeline drag payloads', () => {
  const values = new Map();
  const transfer = { setData: (key, value) => values.set(key, value) };
  setAssetTransfer(transfer, { id: 'asset_123', type: 'image' });
  assert.equal(values.get('application/x-jupiter-asset'), 'asset_123');
  assert.equal(values.get('application/x-jupiter-kind'), 'video');
  assert.equal(values.get('text/plain'), 'jupiter-asset:asset_123');
});

test('reads both custom and plain-text drag payloads', () => {
  assert.equal(readAssetTransfer({ getData: type => type === 'application/x-jupiter-asset' ? 'asset_custom' : '' }), 'asset_custom');
  assert.equal(readAssetTransfer({ getData: type => type === 'text/plain' ? 'jupiter-asset:asset_plain' : '' }), 'asset_plain');
});

test('accepts portable drag types', () => {
  assert.equal(hasAssetTransferType(['text/plain']), true);
  assert.equal(hasAssetTransferType(['application/x-jupiter-asset']), true);
  assert.equal(hasAssetTransferType(['Files']), false);
});


test('keeps a plain-text drag payload when WebView2 rejects custom MIME types', () => {
  const values = new Map();
  const transfer = { setData: (key, value) => { if (key !== 'text/plain') throw new Error('unsupported drag type'); values.set(key, value); } };
  setAssetTransfer(transfer, { id: 'asset_safe', type: 'audio' });
  assert.equal(values.get('text/plain'), 'jupiter-asset:asset_safe');
});


test('reads native Tauri media payloads serialized in camelCase', () => {
  assert.equal(nativeAssetBase64({ dataBase64: 'YWJj' }), 'YWJj');
  assert.equal(nativeAssetBase64({ data_base64: 'ZGVm' }), 'ZGVm');
  assert.throws(() => nativeAssetBase64({}), /base64 media data/);
});
