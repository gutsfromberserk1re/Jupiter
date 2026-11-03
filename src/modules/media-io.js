const IMAGE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'avif', 'svg', 'ico'
]);
const AUDIO_EXTENSIONS = new Set([
  'mp3', 'wav', 'flac', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'aif', 'aiff', 'wma', 'mid', 'midi'
]);

export function detectMediaKind(name = '', mime = '') {
  const normalizedMime = String(mime || '').toLowerCase().split(';', 1)[0].trim();
  if (normalizedMime.startsWith('image/')) return 'image';
  if (normalizedMime.startsWith('audio/')) return 'audio';
  const extension = String(name).split('.').pop()?.toLowerCase() || '';
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (AUDIO_EXTENSIONS.has(extension)) return 'audio';
  return null;
}

export function mediaMime(name = '', mime = '', kind = detectMediaKind(name, mime)) {
  const normalizedMime = String(mime || '').toLowerCase();
  if (normalizedMime && normalizedMime !== 'application/octet-stream') return normalizedMime;
  const extension = String(name).split('.').pop()?.toLowerCase() || '';
  const known = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
    bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff', avif: 'image/avif', svg: 'image/svg+xml',
    mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg', oga: 'audio/ogg',
    opus: 'audio/opus', m4a: 'audio/mp4', aac: 'audio/aac', aif: 'audio/aiff', aiff: 'audio/aiff',
    wma: 'audio/x-ms-wma', mid: 'audio/midi', midi: 'audio/midi'
  };
  return known[extension] || (kind === 'image' ? 'image/png' : kind === 'audio' ? 'audio/mpeg' : 'application/octet-stream');
}

export function nativeAssetBase64(assetData) {
  const encoded = assetData?.dataBase64 ?? assetData?.data_base64;
  if (typeof encoded !== 'string' || !encoded.length) {
    throw new Error('The native file reader returned no base64 media data.');
  }
  return encoded;
}

export function setAssetTransfer(dataTransfer, asset) {
  if (!dataTransfer || !asset?.id) return;
  const kind = asset.type === 'audio' ? 'audio' : 'video';
  try { dataTransfer.effectAllowed = 'copyMove'; } catch {}
  // Set the portable payload first. Some WebView2 builds reject custom MIME types.
  try { dataTransfer.setData('text/plain', `jupiter-asset:${asset.id}`); } catch {}
  for (const [type, value] of [
    ['application/x-jupiter-asset', asset.id],
    ['application/x-jupiter-kind', kind],
    [kind === 'audio' ? 'application/x-jupiter-audio' : 'application/x-jupiter-video', asset.id],
  ]) {
    try { dataTransfer.setData(type, value); } catch { /* keep text/plain fallback */ }
  }
}

export function hasAssetTransferType(types) {
  const values = Array.from(types || []);
  return values.includes('application/x-jupiter-asset') || values.includes('text/plain');
}

export function readAssetTransfer(dataTransfer, fallbackId = null) {
  if (!dataTransfer) return fallbackId;
  let custom = '';
  let plain = '';
  try { custom = dataTransfer.getData?.('application/x-jupiter-asset') || ''; } catch {}
  if (custom) return custom;
  try { plain = dataTransfer.getData?.('text/plain') || ''; } catch {}
  if (plain.startsWith('jupiter-asset:')) return plain.slice('jupiter-asset:'.length);
  return fallbackId;
}
