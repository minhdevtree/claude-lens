// Pure helpers: no `$` here (the engine follows `$` only within register.tsx).

export type Kind = 'image' | 'svg' | 'pdf'
export type Where = 'above' | 'inline' | 'pane' | 'off'
export type Painter = 'auto' | 'kitty' | 'blocks' | 'text'
/** How finely the colored blocks divide a cell: 2x3 sextants, 2x2 quadrants, or 1x2 half blocks. */
export type Detail = 'auto' | 'sextant' | 'quadrant' | 'halfblock'
export type Mosaic = Exclude<Detail, 'auto'>
export type Source = 'pasted' | 'read' | 'written' | 'links' | 'toolImages'

export type Config = {
  kinds: Record<Kind, boolean>
  where: Record<Source, Where>
  painter: Painter
  detail: Detail
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
    detail: pick(o.detail, ['auto', 'sextant', 'quadrant', 'halfblock'], 'auto'),
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
 * The mosaic `auto` draws with: sextants in CSM (its xterm.js WebGL renderer draws U+1FB00-1FB3B itself, as solid
 * blocks), quadrants elsewhere (Menlo and most monospace fonts have U+2596-259F; no font macOS ships has sextants).
 */
export const mosaicFor = (detail: Detail, env: { csm: boolean }): Mosaic =>
  detail !== 'auto' ? detail : env.csm ? 'sextant' : 'quadrant'

/** Pixel samples per cell, across and down, for each mosaic. */
export const SAMPLES: Record<Mosaic, { x: number; y: number }> = { halfblock: { x: 1, y: 2 }, quadrant: { x: 2, y: 2 }, sextant: { x: 2, y: 3 } }

/** Quadrant glyphs by mask, bit 0 upper left, 1 upper right, 2 lower left, 3 lower right (Block Elements, U+2580-259F). */
export const QUADRANTS = [
  0x20, 0x2598, 0x259d, 0x2580, 0x2596, 0x258c, 0x259e, 0x259b,
  0x2597, 0x259a, 0x2590, 0x259c, 0x2584, 0x2599, 0x259f, 0x2588,
]

/**
 * The sextant glyph for a mask, bit n the n+1th of the six sub-cells read row by row (upper left, upper right, middle
 * left, ...). U+1FB00-1FB3B (Symbols for Legacy Computing) skip the three that Block Elements already have: the empty
 * cell, the left and right halves and the full block.
 */
export function sextantGlyph(mask: number): number {
  if (mask === 0) return 0x20
  if (mask === 63) return 0x2588
  if (mask === 21) return 0x258c
  if (mask === 42) return 0x2590
  return 0x1fb00 + mask - 1 - (mask > 21 ? 1 : 0) - (mask > 42 ? 1 : 0)
}

export type Cell = { glyph: number; fg: number; bg: number }

/**
 * The two colors and the split that draw `n` samples best: every split of the samples into a foreground and a background
 * set is tried, each set taking its mean color, and the one with the least squared error wins (2^(n-1) splits: 2 for half
 * blocks, 8 for quadrants, 32 for sextants). Samples whose alpha is under 128 count as the terminal's own background; a
 * set made only of them takes the default color. `rgba` holds the n samples, 4 bytes each.
 */
export function fitCell(rgba: ArrayLike<number>, n: number): { mask: number; fg: number; bg: number } {
  const clear = (i: number) => rgba[i * 4 + 3]! < 128
  // Clear samples are fitted as a mid grey so they group together, then drawn as the default color.
  const ch = (i: number, c: number) => (clear(i) ? 128 : rgba[i * 4 + c]!)
  let best = { mask: 0, error: Infinity, fg: 0, bg: 0 }
  for (let mask = 0; mask < 1 << (n - 1); mask++) {
    const sums = [[0, 0, 0, 0], [0, 0, 0, 0]] as [number[], number[]]
    for (let i = 0; i < n; i++) {
      const s = sums[(mask >> i) & 1]!
      s[0]! += ch(i, 0); s[1]! += ch(i, 1); s[2]! += ch(i, 2); s[3]! += 1
    }
    const mean = sums.map(s => (s[3] === 0 ? [0, 0, 0] : [s[0]! / s[3]!, s[1]! / s[3]!, s[2]! / s[3]!]))
    let error = 0
    for (let i = 0; i < n; i++) {
      const m = mean[(mask >> i) & 1]!
      error += (ch(i, 0) - m[0]!) ** 2 + (ch(i, 1) - m[1]!) ** 2 + (ch(i, 2) - m[2]!) ** 2
    }
    if (error < best.error) {
      const color = (set: 0 | 1, m: number[]) => {
        let allClear = true
        for (let i = 0; i < n; i++) if (((mask >> i) & 1) === set && !clear(i)) allClear = false
        return allClear ? DEFAULT_COLOR : (Math.round(m[0]!) << 16) | (Math.round(m[1]!) << 8) | Math.round(m[2]!)
      }
      best = { mask, error, fg: color(1, mean[1]!), bg: color(0, mean[0]!) }
    }
  }
  // Masks are tried with the last sample in the background; when every sample is one color, draw it as background.
  return { mask: best.mask, fg: best.fg, bg: best.bg }
}

/** Cells for pixels sampled `SAMPLES[mode]` per cell: `(columns * x) x (rows * y)` pixels in, `columns x rows` cells out. */
export function mosaicCells(p: Pixels, mode: Mosaic): { columns: number; rows: number; cells: Cell[] } {
  const { x: sx, y: sy } = SAMPLES[mode]
  const columns = Math.floor(p.width / sx), rows = Math.ceil(p.height / sy)
  const n = sx * sy
  const block = new Uint8Array(n * 4)
  const cells: Cell[] = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      for (let dy = 0; dy < sy; dy++) {
        for (let dx = 0; dx < sx; dx++) {
          const y = r * sy + dy, o = (y * p.width + c * sx + dx) * 4, i = (dy * sx + dx) * 4
          if (y < p.height) block.set(p.rgba.subarray(o, o + 4), i)
          else block.fill(0, i, i + 4) // below the last pixel row: clear
        }
      }
      const { mask, fg, bg } = fitCell(block, n)
      const glyph = mode === 'sextant' ? sextantGlyph(mask) : mode === 'quadrant' ? QUADRANTS[mask]! : mask === 1 ? 0x2580 : mask === 2 ? 0x2584 : 0x20
      cells.push({ glyph, fg, bg })
    }
  }
  return { columns, rows, cells }
}

/** A `Raster`'s packed cells (u32 triplets, base64); every glyph must be in the BMP, so not sextants. */
export function packCells(m: { columns: number; rows: number; cells: Cell[] }): { cells: string; columns: number; rows: number } {
  const words = new Uint32Array(m.cells.length * 3)
  m.cells.forEach((c, i) => { words[i * 3] = c.glyph; words[i * 3 + 1] = c.fg; words[i * 3 + 2] = c.bg })
  return { cells: new Uint8Array(words.buffer).toBase64(), columns: m.columns, rows: m.rows }
}

export type Run = { text: string; fg?: string; bg?: string }

/** Rows of text runs, adjacent cells of the same colors joined: how sextants are drawn (`Raster` refuses beyond-BMP glyphs). */
export function textRows(m: { columns: number; rows: number; cells: Cell[] }): Run[][] {
  const hex = (c: number) => (c === DEFAULT_COLOR ? undefined : '#' + c.toString(16).padStart(6, '0'))
  const out: Run[][] = []
  for (let r = 0; r < m.rows; r++) {
    const row: Run[] = []
    for (let c = 0; c < m.columns; c++) {
      const cell = m.cells[r * m.columns + c]!
      const fg = cell.glyph === 0x20 ? undefined : hex(cell.fg), bg = hex(cell.bg)
      const last = row[row.length - 1]
      if (last && last.fg === fg && last.bg === bg) last.text += String.fromCodePoint(cell.glyph)
      else row.push({ text: String.fromCodePoint(cell.glyph), ...(fg ? { fg } : {}), ...(bg ? { bg } : {}) })
    }
    out.push(row)
  }
  return out
}

/** Distinct (foreground, background) pairs, the unit `Raster`'s palette counts (1024 per frame). */
export const colorPairs = (cells: readonly Cell[]) => new Set(cells.map(c => `${c.fg}/${c.bg}`)).size

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

/** Labels for a prompt's pasted images, in order: Claude Code's own `Image #n` from the prompt's `[Image #n]` tags
 *  (the stored row keeps the ids beside the blocks, `imagePasteIds`, but the hook's input does not carry them), or
 *  `pasted image n` when the tags do not match the images one for one. */
export function pastedLabels(text: string, count: number): string[] {
  const nums = imageNumbers(text)
  return Array.from({ length: count }, (_, i) => (nums.length === count ? `Image #${nums[i]}` : `pasted image ${i + 1}`))
}
