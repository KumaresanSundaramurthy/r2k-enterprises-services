export interface ImageInfo {
  extension: "png" | "jpeg" | "gif";
  width: number;
  height: number;
}

// MIME type read from the file's content (like PHP mime_content_type) for the image formats; null otherwise
export function imageMimeType(buf: Buffer): string | null {
  const info = imageInfo(buf);
  return info ? `image/${info.extension}` : null;
}

// Type and pixel size of a PNG, JPEG or GIF from its header bytes; null for any other format.
export function imageInfo(buf: Buffer): ImageInfo | null {
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { extension: "png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length >= 10 && buf.toString("ascii", 0, 3) === "GIF") {
    return { extension: "gif", width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    // Walk the JPEG segments to the first SOF marker, which holds the size
    let offset = 2;
    while (offset + 9 < buf.length) {
      if (buf[offset] !== 0xff) return null;
      const marker = buf[offset + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { extension: "jpeg", height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
      }
      offset += 2 + buf.readUInt16BE(offset + 2);
    }
  }
  return null;
}
