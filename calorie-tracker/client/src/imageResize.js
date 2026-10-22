// Downscale a photo in the browser before upload: phone photos are often
// 4-12 MB, and Gemini doesn't need more than ~1600 px to read a plate.
// Any failure (e.g. HEIC on a browser that can't decode it) returns the
// original file so the server can still try.

const MAX_SIDE = 1600;
const QUALITY = 0.85;

export async function resizeImage(file, { maxSide = MAX_SIDE, quality = QUALITY } = {}) {
  let source;
  try {
    source = await decode(file);
    const scale = Math.min(1, maxSide / Math.max(source.width, source.height));
    const width = Math.round(source.width * scale);
    const height = Math.round(source.height * scale);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    // JPEG has no alpha; paint white so transparent PNGs don't turn black.
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source.image, 0, 0, width, height);

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (!blob) return file;
    const name = (file.name || 'photo').replace(/\.[^.]*$/, '') + '.jpg';
    return new File([blob], name, { type: 'image/jpeg', lastModified: Date.now() });
  } catch {
    return file;
  } finally {
    source?.close();
  }
}

async function decode(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      // 'from-image' applies the EXIF orientation, so portrait shots stay upright.
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { image: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
    } catch {
      // Older engines reject the option or the format; try an <img> instead.
    }
  }
  return decodeWithImg(file);
}

// Modern browsers apply EXIF orientation to <img> (image-orientation: from-image
// is the default), and naturalWidth/Height report the rotated size.
function decodeWithImg(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      resolve({
        image: img,
        width: img.naturalWidth,
        height: img.naturalHeight,
        close: () => URL.revokeObjectURL(url),
      });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not decode image'));
    };
    img.src = url;
  });
}
