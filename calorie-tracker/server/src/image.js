import path from 'node:path';

export const ACCEPTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];

const ALIASES = { 'image/jpg': 'image/jpeg', 'image/pjpeg': 'image/jpeg' };

const BY_EXTENSION = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
};

/**
 * The accepted mime type for an upload, or null. Some mobile browsers send
 * HEIC photos as application/octet-stream (or with no type), so in that case
 * the file extension decides.
 */
export function uploadMimeType({ mimetype, originalname }) {
  const type = (mimetype ?? '').toLowerCase();
  const normalized = ALIASES[type] ?? type;
  if (ACCEPTED_IMAGE_TYPES.includes(normalized)) return normalized;
  if (normalized === '' || normalized === 'application/octet-stream') {
    return BY_EXTENSION[path.extname(originalname ?? '').toLowerCase()] ?? null;
  }
  return null;
}

const HEIC_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs']);
const HEIF_BRANDS = new Set(['mif1', 'msf1']);

/** Detects the real image type from the file's magic bytes, or returns null. */
export function sniffImageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  if (buffer.toString('latin1', 4, 8) === 'ftyp') {
    const brand = buffer.toString('latin1', 8, 12);
    if (HEIC_BRANDS.has(brand)) return 'image/heic';
    if (HEIF_BRANDS.has(brand)) return 'image/heif';
  }
  return null;
}
