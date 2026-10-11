import { expect, test } from 'claude-code/testing'

import {
  RENDERERS, commandPaths, configOf, fitCells, hash, imageLinks, imageNumbers, kindOf, linkLabel, paintsImages, parseBmp, parsePpm,
  pixelsPlan, pngSize, rasterCells, resolvePath, rowKey,
} from '../hooks/lib'

import { bmp2x2, pngHead } from './fixtures'

test('config: defaults, picks and clamps', () => {
  const d = configOf({})
  expect(d).toEqual({
    kinds: { image: true, svg: true, pdf: true },
    where: { pasted: 'above', read: 'inline', written: 'inline', links: 'inline', toolImages: 'inline' },
    painter: 'auto', maxRows: 10, pdfPages: 1,
  })
  const c = configOf({ svg: false, read: 'pane', links: 'above', painter: 'blocks', maxRows: 99, pdfPages: 0 })
  expect(c.kinds.svg).toBe(false)
  expect(c.where.read).toBe('pane')
  expect(c.where.links).toBe('inline') // "above" is for pasted images only
  expect([c.painter, c.maxRows, c.pdfPages]).toEqual(['blocks', 40, 1])
})

test('kinds come from the extension, case aside', () => {
  expect([kindOf('/a/b.PNG'), kindOf('x.jpeg'), kindOf('d.svg'), kindOf('r.pdf'), kindOf('n.txt'), kindOf('noext')])
    .toEqual(['image', 'image', 'svg', 'pdf', undefined, undefined])
})

test('paths resolve under the working directory; web URLs are not files', () => {
  expect(resolvePath('img/a.png', '/w/p')).toBe('/w/p/img/a.png')
  expect(resolvePath('../a.png', '/w/p')).toBe('/w/a.png')
  expect(resolvePath('file:///tmp/a%20b.png', '/w')).toBe('/tmp/a b.png')
  expect(resolvePath('<docs/my shot.png>', '/w')).toBe('/w/docs/my shot.png')
  expect(resolvePath('https://x.dev/a.png', '/w')).toBeUndefined()
})

test('markdown image links: local previewable files only, deduplicated', () => {
  const text = 'See ![a](shots/a.png "title") and ![b](/abs/b.svg), ![web](https://x.dev/c.png), [not an image](d.png), ![a again](shots/a.png) ![t](notes.txt)'
  expect(imageLinks(text, '/w')).toEqual([{ path: '/w/shots/a.png', alt: 'a' }, { path: '/abs/b.svg', alt: 'b' }])
  expect(linkLabel({ path: '/w/out/chart.png', alt: 'revenue by month' })).toBe('revenue by month (chart.png)')
  expect(linkLabel({ path: '/w/out/chart.png', alt: '' })).toBe('chart.png')
})

test('command paths: previewable files a shell command names', () => {
  expect(commandPaths('sips -s format png in.svg --out out/x.png && open "My Shot.pdf"', '/w'))
    .toEqual(['/w/in.svg', '/w/out/x.png', '/w/My Shot.pdf'])
  expect(commandPaths('convert a.jpg -resize 50% b.webp; echo done', '/w')).toEqual(['/w/a.jpg', '/w/b.webp'])
  expect(commandPaths('npm test', '/w')).toEqual([])
})

test('a pasted prompt row is keyed by its uuid less the last group', () => {
  expect(rowKey('5ba350cf-854d-4d31-a1a6-4b98b90d8059')).toBe(rowKey('5ba350cf-854d-4d31-a1a6-000000000000'))
})

test('hash is stable and hex', () => {
  expect(hash('abc')).toBe(hash('abc'))
  expect(hash('abc')).not.toBe(hash('abd'))
  expect(/^[0-9a-f]{8}$/.test(hash('x'))).toBe(true)
})

test('PNG size from its header; not a PNG is null', () => {
  expect(pngSize(pngHead(1630, 632))).toEqual({ width: 1630, height: 632 })
  expect(pngSize(btoa('\xff\xd8\xff\xe0 a jpeg, not a png at all......'))).toBeNull()
})

test('cells keep the shape within the limits', () => {
  expect(fitCells({ width: 800, height: 400 }, 10, 120)).toEqual({ columns: 40, rows: 10 })
  expect(fitCells({ width: 3000, height: 500 }, 10, 60)).toEqual({ columns: 60, rows: 5 })
  expect(fitCells({ width: 100, height: 4000 }, 10, 60)).toEqual({ columns: 2, rows: 10 })
})

test('BMP pixels, top row first', () => {
  const p = parseBmp(bmp2x2())
  expect([p.width, p.height]).toEqual([2, 2])
  expect([...p.rgba]).toEqual([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255])
})

test('BMP: 32-bit BITFIELDS top-down, as sips writes it', () => {
  const b = new Uint8Array(138 + 8)
  const v = new DataView(b.buffer)
  v.setUint16(0, 0x4d42, true); v.setUint32(10, 138, true); v.setUint32(14, 124, true)
  v.setInt32(18, 2, true); v.setInt32(22, -1, true); v.setUint16(28, 32, true); v.setUint32(30, 3, true)
  v.setUint32(54, 0xff000000, true); v.setUint32(58, 0x00ff0000, true); v.setUint32(62, 0x0000ff00, true); v.setUint32(66, 0x000000ff, true)
  v.setUint32(138, 0x11223380, true) // r 0x11, g 0x22, b 0x33, a 0x80
  v.setUint32(142, 0xff0000ff, true)
  expect([...parseBmp(b).rgba]).toEqual([0x11, 0x22, 0x33, 0x80, 0xff, 0, 0, 0xff])
})

test('PPM pixels, comments skipped', () => {
  const head = new TextEncoder().encode('P6\n# made by a test\n2 1\n255\n')
  const bytes = new Uint8Array(head.length + 6)
  bytes.set(head)
  bytes.set([1, 2, 3, 4, 5, 6], head.length)
  expect([...parsePpm(bytes).rgba]).toEqual([1, 2, 3, 255, 4, 5, 6, 255])
})

test('half-block cells: top pixel is the foreground, bottom the background; transparent is the default color', () => {
  const c = rasterCells(parseBmp(bmp2x2()))
  const w = new Uint32Array(Uint8Array.fromBase64(c.cells).buffer)
  expect([c.columns, c.rows]).toEqual([2, 1])
  expect([...w]).toEqual([0x2580, 0xff0000, 0x0000ff, 0x2580, 0x00ff00, 0xffffff])
  const clear = rasterCells({ width: 1, height: 1, rgba: new Uint8Array([9, 9, 9, 0]) })
  expect([...new Uint32Array(Uint8Array.fromBase64(clear.cells).buffer)]).toEqual([0x2580, 0x01000000, 0x01000000])
})

test('renderers pick the tool this machine has', () => {
  const mac = new Set(['sips', 'osascript'])
  const linux = new Set(['pdftoppm', 'rsvg-convert', 'magick'])
  expect(RENDERERS.image('/a.jpg', '/o.png', 800, 1, mac, '/r')?.[0]?.[0]).toBe('sips')
  expect(RENDERERS.image('/a.gif', '/o.png', 800, 1, linux, '/r')).toEqual([['magick', '/a.gif[0]', '-thumbnail', '800x800', 'png:/o.png']])
  expect(RENDERERS.svg('/a.svg', '/o.png', 800, 1, linux, '/r')?.[0]?.[0]).toBe('rsvg-convert')
  expect(RENDERERS.pdf('/a.pdf', '/o.png', 800, 1, mac, '/r')?.[0]?.[0]).toBe('sips')
  expect(RENDERERS.pdf('/a.pdf', '/o.png', 800, 3, mac, '/r')).toEqual([['osascript', '-l', 'JavaScript', '/r/bin/pdfpage.js', '/a.pdf', '3', '800', '/o.png']])
  expect(RENDERERS.pdf('/a.pdf', '/o.png', 800, 2, linux, '/r')).toEqual([['pdftoppm', '-png', '-f', '2', '-l', '2', '-scale-to', '800', '-singlefile', '/a.pdf', '/o']])
  expect(RENDERERS.pdf('/a.pdf', '/o.png', 800, 2, new Set(['mutool']), '/r')?.[0]?.[0]).toBe('mutool')
  expect(RENDERERS.svg('/a.svg', '/o.png', 800, 1, new Set(), '/r')).toBeUndefined()
  expect(pixelsPlan('/t.png', '/t-4x8', 4, 8, mac)?.format).toBe('bmp')
  expect(pixelsPlan('/t.png', '/t-4x8', 4, 8, linux)?.steps).toEqual([['magick', '/t.png', '-resize', '4x8!', 'ppm:/t-4x8.ppm']])
  expect(pixelsPlan('/t.png', '/t-4x8', 4, 8, new Set(['pdftoppm']))).toBeUndefined()
})

test('pictures are painted only by kitty and Ghostty outside tmux and screen', () => {
  expect(paintsImages({ TERM_PROGRAM: 'ghostty' })).toBe(true)
  expect(paintsImages({ TERM: 'xterm-kitty' })).toBe(true)
  expect(paintsImages({ KITTY_WINDOW_ID: '1' })).toBe(true)
  expect(paintsImages({ TERM_PROGRAM: 'ghostty', TMUX: '/tmp/tmux-501/default,1,0' })).toBe(false)
  expect(paintsImages({ TERM_PROGRAM: 'iTerm.app' })).toBe(false)
  expect(paintsImages({ TERM_PROGRAM: 'vscode' })).toBe(false)
  expect(paintsImages({ TMUX: 'x', CLAUDE_CODE_FORCE_TERMINAL_IMAGES: '1' })).toBe(true)
})

test('image numbers in a draft', () => {
  expect(imageNumbers('look [Image #2] and [Image #1] again [Image #2]')).toEqual([2, 1])
})
