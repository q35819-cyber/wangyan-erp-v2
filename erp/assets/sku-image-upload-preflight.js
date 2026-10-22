(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WYERP_SKU_IMAGE_UPLOAD_PREFLIGHT = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var MAX_BYTES = 6 * 1024 * 1024;

  function inspectGif(input) {
    var bytes = input instanceof Uint8Array ? input : new Uint8Array(input || 0);
    if (bytes.length < 6 || String.fromCharCode.apply(null, bytes.subarray(0, 6)) !== 'GIF87a' && String.fromCharCode.apply(null, bytes.subarray(0, 6)) !== 'GIF89a') return { gif: false, complete: true, frameCount: 0, animated: false };
    if (bytes.length < 13) return { gif: true, complete: false, frameCount: 0, animated: false };
    var offset = 13 + ((bytes[10] & 128) ? 3 * (1 << ((bytes[10] & 7) + 1)) : 0), frames = 0;
    function skipBlocks() {
      while (offset < bytes.length) {
        var size = bytes[offset++];
        if (size === 0) return true;
        if (offset + size > bytes.length) return false;
        offset += size;
      }
      return false;
    }
    while (offset < bytes.length) {
      var marker = bytes[offset++];
      if (marker === 0x3b) return { gif: true, complete: true, frameCount: frames, animated: frames > 1 };
      if (marker === 0x21) {
        if (offset >= bytes.length) break;
        offset += 1;
        if (!skipBlocks()) break;
        continue;
      }
      if (marker !== 0x2c || offset + 9 > bytes.length) break;
      var packed = bytes[offset + 8];
      offset += 9 + ((packed & 128) ? 3 * (1 << ((packed & 7) + 1)) : 0);
      if (offset >= bytes.length) break;
      offset += 1;
      if (!skipBlocks()) break;
      frames += 1;
      if (frames > 1) return { gif: true, complete: true, frameCount: frames, animated: true };
    }
    return { gif: true, complete: false, frameCount: frames, animated: false };
  }

  async function check(file) {
    if (!file) return { checked: false };
    if (file.size > MAX_BYTES) throw new Error('单张图片不得超过6 MiB');
    var bytes;
    try { bytes = await file.arrayBuffer(); } catch (_) { return { checked: false }; }
    var result = inspectGif(bytes);
    if (result.animated) throw new Error('暂不支持动态图，请上传静态图片');
    return Object.assign({ checked: result.complete }, result);
  }

  return { MAX_BYTES: MAX_BYTES, inspectGif: inspectGif, check: check };
});
