// Pure helpers: no `$` here (the engine follows `$` only within register.tsx).

export type Kind = 'image' | 'svg' | 'pdf'
export type Where = 'above' | 'inline' | 'pane' | 'off'
export type Painter = 'auto' | 'kitty' | 'blocks' | 'text'
export type Source = 'pasted' | 'read' | 'written' | 'links' | 'toolImages'

export type Config = {
  kinds: Record<Kind, boolean>
  where: Record<Source, Where>
  painter: Painter
  maxRows: number
  pdfPages: number
}

const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback
const clamp = (value: unknown, lo: number, hi: number, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(hi, Math.max(lo, Math.round(value))) : fallback

/** The plugin's options (userConfig) as a typed config, out-of-range values clamped. */
export function configOf(o: Record<string, unknown>): Config {
  const tool = ['inline', 'pane', 'off'] as const
  return {
    kinds: { image: o.images !== false, svg: o.svg !== false, pdf: o.pdf !== false },
    where: {
      pasted: pick(o.pasted, ['above', 'inline', 'pane', 'off'], 'above'),
      read: pick(o.read, tool, 'inline'),
      written: pick(o.written, tool, 'inline'),
      links: pick(o.links, tool, 'inline'),
      toolImages: pick(o.toolImages, tool, 'inline'),
    },
    painter: pick(o.painter, ['auto', 'kitty', 'blocks', 'text'], 'auto'),
    maxRows: clamp(o.maxRows, 2, 40, 10),
    pdfPages: clamp(o.pdfPages, 1, 8, 1),
  }
}

const EXT: Record<string, Kind> = {
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image', tif: 'image', tiff: 'image', heic: 'image',
  svg: 'svg', pdf: 'pdf',
}

/** The kind of file a path names, by its extension; undefined when lens does not preview it. */
export function kindOf(path: string): Kind | undefined {
  const m = /\.([A-Za-z0-9]+)$/.exec(path)
  return m ? EXT[m[1]!.toLowerCase()] : undefined
}

export const MEDIA_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }

const base = (path: string) => path.slice(path.lastIndexOf('/') + 1)
export { base as baseName }

/** Absolute path for `path` under `cwd`; `file://` URLs unwrapped; undefined for a web URL. */
export function resolvePath(path: string, cwd: string): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path) && !path.startsWith('file://')) return undefined
  let p = path.startsWith('file://') ? decodeURIComponent(path.slice(7)) : path
  if (p.startsWith('<') && p.endsWith('>')) p = p.slice(1, -1)
  if (p.startsWith('/')) return p
  const parts = `${cwd}/${p}`.split('/')
  const out: string[] = []
  for (const part of parts) {
    if (part === '..') out.pop()
    else if (part !== '.' && part !== '') out.push(part)
  }
  return '/' + out.join('/')
}

/** The markdown images (`![alt](path)`) in a reply with a local, previewable path: resolved, deduplicated, in order. */
export function imageLinks(text: string, cwd: string): { path: string; alt: string }[] {
  const seen = new Map<string, string>()
  for (const m of text.matchAll(/!\[([^\]]*)\]\((<[^>]+>|[^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const p = resolvePath(m[2]!, cwd)
    if (p !== undefined && kindOf(p) !== undefined && !seen.has(p)) seen.set(p, m[1]!.trim())
  }
  return [...seen].map(([path, alt]) => ({ path, alt }))
}

/** What a link's preview is labelled with: the link's own text and the file, as Claude Code draws the link (`alt (file)`). */
export const linkLabel = (link: { path: string; alt: string }) =>
  link.alt === '' ? base(link.path) : `${link.alt} (${base(link.path)})`

/** Paths in a shell command that name a previewable file, quoted or bare (a heuristic: the caller checks they were just written). */
export function commandPaths(command: string, cwd: string): string[] {
  const ext = '\\.(?:png|jpe?g|gif|webp|bmp|tiff?|heic|svg|pdf)'
  const re = new RegExp(`"([^"]+${ext})"|'([^']+${ext})'|(?:^|[\\s=(])([^\\s'"\`;|&<>()=]+${ext})(?=$|[\\s;|&)])`, 'gi')
  const seen = new Set<string>()
  for (const m of command.matchAll(re)) {
    const p = resolvePath(m[1] ?? m[2] ?? m[3]!, cwd)
    if (p !== undefined) seen.add(p)
  }
  return [...seen]
}

/** The transcript row a pasted prompt is drawn under: its append uuid with the last group zeroed. */
export const rowKey = (uuid: string) => uuid.split('-').slice(0, 4).join('-')

/** FNV-1a, hex: a cache file name from a path and what makes its content new. */
export function hash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193)
  return (h >>> 0).toString(16).padStart(8, '0')
}

export type Size = { width: number; height: number }

/** Width and height from a PNG's IHDR (base64 of at least its first 24 bytes), or null. */
export function pngSize(base64: string): Size | null {
  const head = Uint8Array.fromBase64(base64.slice(0, 32))
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (head.length < 24 || sig.some((b, i) => head[i] !== b)) return null
  const v = new DataView(head.buffer, head.byteOffset, head.byteLength)
  const width = v.getUint32(16), height = v.getUint32(20)
  return width > 0 && height > 0 ? { width, height } : null
}

export type Cells = { columns: number; rows: number }

/** A box of cells that keeps the picture's shape (a cell is about twice as tall as wide), within the limits. */
export function fitCells(size: Size, maxRows: number, maxColumns: number): Cells {
  let rows = maxRows
  let columns = Math.round((rows * 2 * size.width) / size.height)
  if (columns > maxColumns) {
    columns = maxColumns
    rows = Math.max(1, Math.round((columns * size.height) / (2 * size.width)))
  }
  return { columns: Math.max(2, Math.min(columns, 255)), rows: Math.max(1, Math.min(rows, 255)) }
}

export type Pixels = { width: number; height: number; rgba: Uint8Array }

/** An uncompressed BMP (24 or 32 bit, BI_RGB or BITFIELDS, either row order), what `sips -s format bmp` writes. */
export function parseBmp(bytes: Uint8Array): Pixels {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (v.getUint16(0, true) !== 0x4d42) throw new Error('not a BMP')
  const off = v.getUint32(10, true), hdr = v.getUint32(14, true)
  const width = v.getInt32(18, true), rawH = v.getInt32(22, true), bpp = v.getUint16(28, true), comp = v.getUint32(30, true)
  const height = Math.abs(rawH), topDown = rawH < 0
  const masks = comp === 3 && hdr >= 52
    ? [v.getUint32(54, true), v.getUint32(58, true), v.getUint32(62, true), hdr >= 56 ? v.getUint32(66, true) : 0]
    : [0xff0000, 0xff00, 0xff, 0]
  const shift = (m: number) => { let s = 0; while (m && !(m & 1)) { m >>>= 1; s++ } return s }
  const sh = masks.map(shift)
  const stride = Math.ceil((width * bpp) / 32) * 4
  const rgba = new Uint8Array(width * height * 4)
  if (bpp !== 32 && bpp !== 24) throw new Error(`BMP of ${bpp} bits`)
  for (let y = 0; y < height; y++) {
    const row = off + (topDown ? y : height - 1 - y) * stride
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4
      if (bpp === 32) {
        const p = v.getUint32(row + x * 4, true)
        rgba[o] = (p & masks[0]!) >>> sh[0]!
        rgba[o + 1] = (p & masks[1]!) >>> sh[1]!
        rgba[o + 2] = (p & masks[2]!) >>> sh[2]!
        rgba[o + 3] = masks[3] ? (p & masks[3]) >>> sh[3]! : 255
      } else {
        const q = row + x * 3
        rgba[o] = bytes[q + 2]!; rgba[o + 1] = bytes[q + 1]!; rgba[o + 2] = bytes[q]!; rgba[o + 3] = 255
      }
    }
  }
  return { width, height, rgba }
}

/** A binary PPM (P6, maxval 255), what ImageMagick writes for `ppm:` and pdftoppm by default. */
export function parsePpm(bytes: Uint8Array): Pixels {
  let i = 0
  const token = () => {
    while (true) {
      while (i < bytes.length && /\s/.test(String.fromCharCode(bytes[i]!))) i++
      if (bytes[i] !== 0x23) break
      while (i < bytes.length && bytes[i] !== 0x0a) i++
    }
    const start = i
    while (i < bytes.length && !/\s/.test(String.fromCharCode(bytes[i]!))) i++
    return String.fromCharCode(...bytes.subarray(start, i))
  }
  if (token() !== 'P6') throw new Error('not a binary PPM')
  const width = Number(token()), height = Number(token()), max = Number(token())
  if (max !== 255) throw new Error(`PPM maxval ${max}`)
  i++
  const rgba = new Uint8Array(width * height * 4)
  for (let p = 0; p < width * height; p++) {
    rgba[p * 4] = bytes[i + p * 3]!; rgba[p * 4 + 1] = bytes[i + p * 3 + 1]!; rgba[p * 4 + 2] = bytes[i + p * 3 + 2]!; rgba[p * 4 + 3] = 255
  }
  return { width, height, rgba }
}

const DEFAULT_COLOR = 0x01000000

/**
 * Raster cells for pixels: one column per pixel and one row per two pixel rows, each cell an upper half
 * block whose foreground is the top pixel and background the bottom one. A mostly transparent pixel takes
 * the terminal's own background.
 */
export function rasterCells(p: Pixels): { cells: string; columns: number; rows: number } {
  const columns = p.width, rows = Math.ceil(p.height / 2)
  const color = (x: number, y: number) => {
    if (y >= p.height) return DEFAULT_COLOR
    const o = (y * p.width + x) * 4
    return p.rgba[o + 3]! < 128 ? DEFAULT_COLOR : (p.rgba[o]! << 16) | (p.rgba[o + 1]! << 8) | p.rgba[o + 2]!
  }
  const words = new Uint32Array(columns * rows * 3)
  for (let r = 0; r < rows; r++) {
    for (let x = 0; x < columns; x++) {
      const i = (r * columns + x) * 3
      words[i] = 0x2580
      words[i + 1] = color(x, r * 2)
      words[i + 2] = color(x, r * 2 + 1)
    }
  }
  return { cells: new Uint8Array(words.buffer).toBase64(), columns, rows }
}

/** The tools found on this machine, by the name `command -v` knows them. */
export type Tools = ReadonlySet<string>

export const TOOL_NAMES = ['sips', 'osascript', 'pdftoppm', 'mutool', 'rsvg-convert', 'magick', 'convert']

/**
 * RENDERERS: how each kind becomes a PNG of at most `px` on its longest side, as argv steps run in order.
 * A new kind is one entry here, one extension in EXT and one userConfig key. Undefined: no tool for it here.
 */
export const RENDERERS: Record<Kind, (input: string, out: string, px: number, page: number, tools: Tools, root: string) => string[][] | undefined> = {
  image: (input, out, px, _page, tools) => {
    if (tools.has('sips')) return [['sips', '-s', 'format', 'png', '-Z', String(px), input, '--out', out]]
    const im = tools.has('magick') ? 'magick' : tools.has('convert') ? 'convert' : undefined
    return im ? [[im, `${input}[0]`, '-thumbnail', `${px}x${px}`, `png:${out}`]] : undefined
  },
  svg: (input, out, px, _page, tools) => {
    if (tools.has('sips')) return [['sips', '-s', 'format', 'png', '-Z', String(px), input, '--out', out]]
    if (tools.has('rsvg-convert')) return [['rsvg-convert', '--width', String(px), '--keep-aspect-ratio', '-o', out, input]]
    const im = tools.has('magick') ? 'magick' : tools.has('convert') ? 'convert' : undefined
    return im ? [[im, input, '-thumbnail', `${px}x${px}`, `png:${out}`]] : undefined
  },
  pdf: (input, out, px, page, tools, root) => {
    // sips draws page 1 in about 60 ms; PDFKit through JXA draws any page in 200-900 ms.
    if (page === 1 && tools.has('sips')) return [['sips', '-s', 'format', 'png', '-Z', String(px), input, '--out', out]]
    if (tools.has('osascript')) return [['osascript', '-l', 'JavaScript', `${root}/bin/pdfpage.js`, input, String(page), String(px), out]]
    if (tools.has('pdftoppm')) {
      return [['pdftoppm', '-png', '-f', String(page), '-l', String(page), '-scale-to', String(px), '-singlefile', input, out.replace(/\.png$/, '')]]
    }
    if (tools.has('mutool')) return [['mutool', 'draw', '-q', '-o', out, '-w', String(px), input, String(page)]]
    const im = tools.has('magick') ? 'magick' : tools.has('convert') ? 'convert' : undefined
    return im ? [[im, '-density', '96', `${input}[${page - 1}]`, '-thumbnail', `${px}x${px}`, `png:${out}`]] : undefined
  },
}

/** How a PNG thumbnail becomes `width` x `height` raw pixels for the colored-block painter. */
export function pixelsPlan(png: string, out: string, width: number, height: number, tools: Tools):
  { steps: string[][]; format: 'bmp' | 'ppm' } | undefined {
  if (tools.has('sips')) return { steps: [['sips', '-s', 'format', 'bmp', '-z', String(height), String(width), png, '--out', `${out}.bmp`]], format: 'bmp' }
  const im = tools.has('magick') ? 'magick' : tools.has('convert') ? 'convert' : undefined
  return im ? { steps: [[im, png, '-resize', `${width}x${height}!`, `ppm:${out}.ppm`]], format: 'ppm' } : undefined
}

/** Whether this terminal paints the engine's Image (kitty graphics with Unicode placeholders), from its environment. */
export function paintsImages(env: Record<string, string | undefined>): boolean {
  if (env.CLAUDE_CODE_FORCE_TERMINAL_IMAGES === '1') return true
  if (env.TMUX || env.STY) return false
  return env.TERM === 'xterm-kitty' || env.TERM === 'xterm-ghostty' || env.TERM_PROGRAM === 'ghostty' ||
    env.TERM_PROGRAM === 'kitty' || env.KITTY_WINDOW_ID !== undefined || env.GHOSTTY_RESOURCES_DIR !== undefined
}

/** The image numbers a draft references (`[Image #n]`), deduplicated, in order. From claude-image-view (MIT). */
export function imageNumbers(draft: string): number[] {
  const seen = new Set<number>()
  for (const m of draft.matchAll(/\[Image #(\d+)\]/g)) seen.add(Number(m[1]))
  return [...seen]
}
