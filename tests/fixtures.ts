// Bytes the tests feed lens.

/** The first 33 bytes of a PNG of the given size, base64. */
export function pngHead(width: number, height: number): string {
  const bytes = new Uint8Array(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes.toBase64()
}

/** A 2x2 24-bit bottom-up BMP: top row red, green; bottom row blue, white. */
export function bmp2x2(): Uint8Array {
  const b = new Uint8Array(54 + 16)
  const v = new DataView(b.buffer)
  v.setUint16(0, 0x4d42, true); v.setUint32(10, 54, true); v.setUint32(14, 40, true)
  v.setInt32(18, 2, true); v.setInt32(22, 2, true); v.setUint16(28, 24, true)
  b.set([255, 0, 0, 255, 255, 255, 0, 0], 54) // bottom row (BGR), padded to 8
  b.set([0, 0, 255, 0, 255, 0, 0, 0], 62) // top row
  return b
}
