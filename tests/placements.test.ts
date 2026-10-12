import { expect, mock, test } from 'claude-code/testing'

import { hash, rowKey } from '../hooks/lib'
import { bmp2x2, pngHead } from './fixtures'

const CACHE = '/t/claude-lens'
const STAT = { kind: 'file', size: 100, mtimeMs: 1000, isLink: false }
/** The cached thumbnail lens names for page 1 of `path` (the stat above). */
const thumbOf = (path: string, page = 1) => `${CACHE}/${hash(`${path}|100|1000|${page}|800`)}.png`
const ROW = { isRunning: false, isErrored: false, isInterrupted: false }
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10"/></svg>'

/**
 * The world beneath lens: a Mac with sips, every file present and 100 bytes, thumbnails already cached as
 * 800x400 PNGs, converters that succeed, and a terminal named by `terminal`.
 */
function world(on: any, terminal: Record<string, string> = { TERM_PROGRAM: 'ghostty' }) {
  const ran: string[][] = []
  mock.env(on, { TMPDIR: '/t', ...terminal })
  const clock = mock.clock(on)
  mock.store(on)
  on('session.cwd', () => ({ value: '/work' }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('process.run', ($: any, e: any) => {
    ran.push([...e.argv])
    const stdout = e.argv[0] === '/bin/sh' && String(e.argv[2]).includes('command -v') ? 'sips\nosascript\n' : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.stat', () => ({ value: STAT }))
  on('fs.exists', () => ({ value: true }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.read', ($: any, e: any) => {
    if (String(e.path).endsWith('.bmp')) return { value: { base64: bmp2x2().toBase64() } }
    if (String(e.path).endsWith('.svg')) return { value: SVG }
    return { value: { base64: pngHead(800, 400) } }
  })
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine row'] }))
  return { ran, clock }
}

const model = { kind: 'model', model: 'claude-test' } as const

async function toolUse($: any, id: string, name: string, input: Record<string, unknown>) {
  await $.session.append({ door: 'response', origin: model, uuid: `u-${id}`, message: { type: 'assistant', role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } })
}

async function toolResult($: any, id: string, tool: string, content: unknown[] = [{ type: 'text', text: 'ok' }]) {
  await $.session.append({ door: 'tool-result', origin: { kind: 'tool', tool }, uuid: `r-${id}`, message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] } })
}

function mountOf(surface: 'terminal' | 'desktop', component: string, props: unknown, requestId = 'row') {
  return { plugin: 'lens', surface, component, requestId, viewport: { columns: 100, rows: 40 }, props } as any
}

test('a Read in a tool group: a picture under the group row in Ghostty', async ($, on) => {
  world(on)
  await toolUse($, 't1', 'Read', { file_path: '/work/a.png' })
  const ui = await $.ui.mount(mountOf('terminal', 'ToolGroup', { isActive: false, isExpanded: false, calls: [{ tool_use_id: 't1', tool: 'Read', input: { file_path: '/work/a.png' }, ...ROW }] }))
  expect((await ui.find({ type: 'Image' }))?.props).toMatchObject({ source: { file: thumbOf('/work/a.png'), format: 'png' }, columns: 40, rows: 10, alt: '[a.png]' })
  expect(await ui.find({ type: 'Text', text: 'engine row' })).toBeDefined()
})

const READ_A = { isActive: false, isExpanded: false, calls: [{ tool_use_id: 't1', tool: 'Read', input: { file_path: '/work/a.png' }, ...ROW }] }

test('the same Read in tmux: quadrant blocks, not a picture', async ($, on) => {
  const { ran } = world(on, { TMUX: '/tmp/tmux-501/default,1,0', TERM_PROGRAM: 'ghostty' })
  await toolUse($, 't1', 'Read', { file_path: '/work/a.png' })
  const ui = await $.ui.mount(mountOf('terminal', 'ToolGroup', { isActive: false, isExpanded: false, calls: [{ tool_use_id: 't1', tool: 'Read', input: { file_path: '/work/a.png' }, ...ROW }] }))
  expect(await ui.find({ type: 'Image' })).toBeUndefined()
  // bmp2x2 stands for the pixels: one quadrant cell. The pixels asked for are 2x2 per cell of the 40x10 box.
  expect((await ui.find({ type: 'Raster' }))?.props).toMatchObject({ columns: 1, rows: 1 })
  expect(ran.some(argv => argv[0] === 'sips' && argv.includes('bmp') && argv.includes('20') && argv.includes('80'))).toBe(true)
})

test('in CSM the blocks are sextants, drawn as colored text (Raster takes BMP glyphs only)', async ($, on) => {
  const { ran } = world(on, { TERM_PROGRAM: 'xterm', CSM_SESSION: 's1' })
  await toolUse($, 't1', 'Read', { file_path: '/work/a.png' })
  const ui = await $.ui.mount(mountOf('terminal', 'ToolGroup', READ_A))
  expect(await ui.find({ type: 'Raster' })).toBeUndefined()
  // 40x10 cells, 2x3 pixels each.
  expect(ran.some(argv => argv[0] === 'sips' && argv.includes('30') && argv.includes('80'))).toBe(true)
  const texts = await ui.findAll({ type: 'Text' })
  expect(texts.some(t => /[\u{1FB00}-\u{1FB3B}\u2580-\u259F]/u.test(String((t as any).text ?? '')))).toBe(true)
})

test('config detail "halfblock" in CSM: a Raster of half blocks', { options: { detail: 'halfblock' } }, async ($, on) => {
  const { ran } = world(on, { TERM_PROGRAM: 'xterm', CSM_SESSION: 's1' })
  await toolUse($, 't1', 'Read', { file_path: '/work/a.png' })
  const ui = await $.ui.mount(mountOf('terminal', 'ToolGroup', READ_A))
  expect((await ui.find({ type: 'Raster' }))?.props).toMatchObject({ columns: 2, rows: 1 })
  expect(ran.some(argv => argv[0] === 'sips' && argv.includes('20') && argv.includes('40'))).toBe(true)
})

test('a Read still running, or one that failed, gets no preview', async ($, on) => {
  world(on)
  await toolUse($, 't1', 'Read', { file_path: '/work/a.png' })
  const running = await $.ui.mount(mountOf('terminal', 'ToolGroup', { isActive: true, isExpanded: false, calls: [{ tool_use_id: 't1', tool: 'Read', input: { file_path: '/work/a.png' }, ...ROW, isRunning: true }] }))
  expect(await running.find({ type: 'Image' })).toBeUndefined()
  const failed = await $.ui.mount(mountOf('terminal', 'ToolGroup', { isActive: false, isExpanded: false, calls: [{ tool_use_id: 't1', tool: 'Read', input: { file_path: '/work/a.png' }, ...ROW, isErrored: true }] }, 'row2'))
  expect(await failed.find({ type: 'Image' })).toBeUndefined()
})


test('config painter "text": the file name, no picture', { options: { painter: 'text' } }, async ($, on) => {
  world(on)
  await toolUse($, 't1', 'Read', { file_path: '/work/a.png' })
  const ui = await $.ui.mount(mountOf('terminal', 'ToolGroup', READ_A))
  expect(await ui.find({ type: 'Image' })).toBeUndefined()
  expect(await ui.find({ type: 'Raster' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '  a.png' })).toBeDefined()
})

test('config read "off": nothing drawn, nothing kept', { options: { read: 'off' } }, async ($, on) => {
  world(on)
  await toolUse($, 't1', 'Read', { file_path: '/work/a.png' })
  const ui = await $.ui.mount(mountOf('terminal', 'ToolGroup', READ_A))
  expect(await ui.find({ type: 'Image' })).toBeUndefined()
})

test('config images off: a PNG is not previewed', { options: { images: false } }, async ($, on) => {
  world(on)
  await toolUse($, 't1', 'Read', { file_path: '/work/a.png' })
  const ui = await $.ui.mount(mountOf('terminal', 'ToolGroup', READ_A))
  expect(await ui.find({ type: 'Image' })).toBeUndefined()
})

test('config painter "blocks" in Ghostty: colored blocks anyway', { options: { painter: 'blocks' } }, async ($, on) => {
  world(on)
  await toolUse($, 't1', 'Read', { file_path: '/work/a.png' })
  const ui = await $.ui.mount(mountOf('terminal', 'ToolGroup', READ_A))
  expect(await ui.find({ type: 'Raster' })).toBeDefined()
})

test('config pdfPages 2: two pages side by side', { options: { pdfPages: 2 } }, async ($, on) => {
  world(on)
  await toolUse($, 't1', 'Read', { file_path: '/work/r.pdf' })
  const ui = await $.ui.mount(mountOf('terminal', 'ToolGroup', { isActive: false, isExpanded: false, calls: [{ tool_use_id: 't1', tool: 'Read', input: { file_path: '/work/r.pdf' }, ...ROW }] }))
  const files = (await ui.findAll({ type: 'Image' })).map(i => (i.props as any).source.file)
  expect(files).toEqual([thumbOf('/work/r.pdf', 1), thumbOf('/work/r.pdf', 2)])
})

test('a PDF shows its first page by default', async ($, on) => {
  world(on)
  await toolUse($, 't1', 'Read', { file_path: '/work/r.pdf' })
  const ui = await $.ui.mount(mountOf('terminal', 'ToolGroup', { isActive: false, isExpanded: false, calls: [{ tool_use_id: 't1', tool: 'Read', input: { file_path: '/work/r.pdf' }, ...ROW }] }))
  const images = await ui.findAll({ type: 'Image' })
  expect(images.map(i => (i.props as any).source.file)).toEqual([thumbOf('/work/r.pdf', 1)])
})

test('a file Claude writes with Write shows under its result', async ($, on) => {
  world(on)
  await toolUse($, 'w1', 'Write', { file_path: '/work/logo.svg', content: SVG })
  await toolResult($, 'w1', 'Write')
  const ui = await $.ui.mount(mountOf('terminal', 'ToolResult', { tool_use_id: 'w1', tool: 'Write', output: {}, isErrored: false }))
  expect((await ui.find({ type: 'Image' }))?.props).toMatchObject({ source: { file: thumbOf('/work/logo.svg') }, alt: '[logo.svg]' })
})

test('a file a Bash command just wrote shows under its result', async ($, on) => {
  world(on)
  await toolUse($, 'b1', 'Bash', { command: 'sips -s format png in.svg --out out.png' })
  await toolResult($, 'b1', 'Bash')
  const ui = await $.ui.mount(mountOf('terminal', 'ToolResult', { tool_use_id: 'b1', tool: 'Bash', output: { stdout: '', stderr: '' }, isErrored: false }))
  const files = (await ui.findAll({ type: 'Image' })).map(i => (i.props as any).source.file)
  expect(files).toEqual([thumbOf('/work/in.svg'), thumbOf('/work/out.png')])
})

test('an image a tool returns (an MCP screenshot) shows under its result', async ($, on) => {
  world(on)
  await toolResult($, 'm1', 'mcp__browser__screenshot', [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: pngHead(800, 400) } }])
  const ui = await $.ui.mount(mountOf('terminal', 'ToolResult', { tool_use_id: 'm1', tool: 'mcp__browser__screenshot', output: [], isErrored: false }))
  const image = await ui.find({ type: 'Image' })
  expect((image?.props as any)?.alt).toBe('[mcp__browser__screenshot image 1]')
})

test('a pasted image shows under the prompt row it was sent with', async ($, on) => {
  world(on)
  const uuid = '5ba350cf-854d-4d31-a1a6-4b98b90d8059'
  await $.session.append({ door: 'prompt', origin: { kind: 'composer' }, uuid, message: { type: 'user', role: 'user', content: [{ type: 'text', text: '[Image #1] what is this' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: pngHead(800, 400) } }] } } as any)
  const ui = await $.ui.mount(mountOf('terminal', 'UserMessage', { text: '[Image #1] what is this', origin: { kind: 'composer' }, isExpanded: false }, `${rowKey(uuid)}-000000000000`))
  expect((await ui.find({ type: 'Image' }))?.props).toMatchObject({ alt: '[Image #1]' })
  const other = await $.ui.mount(mountOf('terminal', 'UserMessage', { text: 'hello', origin: { kind: 'composer' }, isExpanded: false }, 'aaaaaaaa-bbbb-cccc-dddd-000000000000'))
  expect(await other.find({ type: 'Image' })).toBeUndefined()
})

test('pasted images are labelled with Claude Code\'s own numbers, else counted', async ($, on) => {
  world(on)
  const img = (w: number) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: pngHead(w, 400) } })
  const two = '6ba350cf-854d-4d31-a1a6-4b98b90d8059', bare = '7ba350cf-854d-4d31-a1a6-4b98b90d8059'
  await $.session.append({ door: 'prompt', origin: { kind: 'composer' }, uuid: two, message: { type: 'user', role: 'user', content: [{ type: 'text', text: '[Image #78] [Image #79] compare' }, img(800), img(801)] } } as any)
  await $.session.append({ door: 'prompt', origin: { kind: 'composer' }, uuid: bare, message: { type: 'user', role: 'user', content: [{ type: 'text', text: 'what is this' }, img(802)] } } as any)
  const ui = await $.ui.mount(mountOf('terminal', 'UserMessage', { text: '[Image #78] [Image #79] compare', origin: { kind: 'composer' }, isExpanded: false }, `${rowKey(two)}-000000000000`))
  expect((await ui.findAll({ type: 'Image' })).map(i => (i.props as any).alt)).toEqual(['[Image #78]', '[Image #79]'])
  const ui2 = await $.ui.mount(mountOf('terminal', 'UserMessage', { text: 'what is this', origin: { kind: 'composer' }, isExpanded: false }, `${rowKey(bare)}-000000000000`))
  expect((await ui2.find({ type: 'Image' }))?.props).toMatchObject({ alt: '[pasted image 1]' })
})

test('a local image link in a reply shows under it; a web link does not', async ($, on) => {
  world(on)
  const ui = await $.ui.mount(mountOf('terminal', 'AssistantMessage', { text: 'Here: ![chart](out/chart.png) and ![w](https://x.dev/w.png)', isFirstOfReply: true }))
  const images = await ui.findAll({ type: 'Image' })
  expect(images.map(i => (i.props as any).source.file)).toEqual([thumbOf('/work/out/chart.png')])
  // Labelled with the link's own text, as Claude Code draws the link in the reply.
  expect((images[0]?.props as any)?.alt).toBe('[chart (chart.png)]')
  expect(await ui.find({ type: 'Text', text: 'chart (chart.png)' })).toBeDefined()
})

test('desktop has no Image: an SVG link is drawn with Svg, a PNG link leaves the row alone', async ($, on) => {
  world(on)
  const svg = await $.ui.mount(mountOf('desktop', 'AssistantMessage', { text: '![logo](logo.svg)', isFirstOfReply: true }))
  expect((await svg.find({ type: 'Svg' }))?.props).toMatchObject({ source: SVG, alt: 'logo (logo.svg)' })
  const png = await $.ui.mount(mountOf('desktop', 'AssistantMessage', { text: '![chart](chart.png)', isFirstOfReply: true }, 'row2'))
  expect(await png.find({ type: 'Svg' })).toBeUndefined()
  expect(await png.find({ type: 'Text', text: 'engine row' })).toBeDefined()
})

test('the /lens pane lists this session\'s previews, newest first', async ($, on) => {
  world(on)
  await toolUse($, 't1', 'Read', { file_path: '/work/a.png' })
  await toolUse($, 't2', 'Read', { file_path: '/work/b.svg' })
  const ui = await $.ui.mount(mountOf('terminal', 'Pane', { title: 'lens gallery', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} }, 'lens'))
  const alts = (await ui.findAll({ type: 'Image' })).map(i => (i.props as any).alt)
  expect(alts).toEqual(['[b.svg  (read)]', '[a.png  (read)]'])
})

test('the band above the prompt shows the draft\'s pasted images from the paste cache', async ($, on) => {
  const { clock } = world(on, { TERM_PROGRAM: 'ghostty', CLAUDE_CODE_TMPDIR: '/tmp/claude-501' })
  on('session.start', () => ({ cwd: '/work' }))
  on('prompt.read', () => ({ value: { text: 'see [Image #1]', cursor: 14 } }))
  on('fs.list', () => ({ value: [{ name: '-work', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }] }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
  await clock.advance(300)
  await clock.advance(300)
  const ui = await $.ui.mount(mountOf('terminal', 'AbovePrompt', { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 100, scroll: { offset: 0, bodyRows: 20 }, view: {} }, 'above-prompt'))
  expect((await ui.find({ type: 'Image' }))?.props).toMatchObject({ source: { file: thumbOf('/tmp/claude-501/-work/sess-1/images/1.png') }, alt: '[Image #1]' })
})

const BAND = { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 100, scroll: { offset: 0, bodyRows: 20 }, view: {} }

/** A turn: the prompt, then rows appended by `body`, then its end and the settle delay. */
async function turn($: any, on: any, clock: any, body: () => Promise<unknown>) {
  on('prompt.submit', ($$: any, e: any) => ({ text: e.text }))
  on('turn.complete', () => ({ text: '' }))
  await $.prompt.submit({ text: 'go', wait: false, origin: { kind: 'composer' } })
  await body()
  await $.turn.complete({ reason: 'answer', answer: '', durationMs: 1, isAborted: false, turnId: 't' } as any)
  await clock.advance(2000)
}

test('a Read whose row another mod drew without passing it on shows above the prompt', { options: { pasted: 'inline' } }, async ($, on) => {
  const { clock } = world(on)
  await turn($, on, clock, () => toolUse($, 't1', 'Read', { file_path: '/work/a.png' }))
  const ui = await $.ui.mount(mountOf('terminal', 'AbovePrompt', BAND, 'above-prompt'))
  expect((await ui.find({ type: 'Image' }))?.props).toMatchObject({ source: { file: thumbOf('/work/a.png') }, alt: '[a.png]' })
  expect(await ui.find({ type: 'Text', text: 'lens: previews from this turn (another mod drew their rows)' })).toBeDefined()
})

test('a pasted image whose prompt row another mod drew shows above the prompt', { options: { pasted: 'inline' } }, async ($, on) => {
  const { clock } = world(on)
  await turn($, on, clock, () => $.session.append({ door: 'prompt', origin: { kind: 'composer' }, uuid: '5ba350cf-854d-4d31-a1a6-4b98b90d8059', message: { type: 'user', role: 'user', content: [{ type: 'text', text: '[Image #1]' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: pngHead(800, 400) } }] } } as any))
  const ui = await $.ui.mount(mountOf('terminal', 'AbovePrompt', BAND, 'above-prompt'))
  expect((await ui.find({ type: 'Image' }))?.props).toMatchObject({ alt: '[Image #1]' })
})

test('a Read its own row drew is not repeated above the prompt; the next prompt clears the band', { options: { pasted: 'inline' } }, async ($, on) => {
  const { clock } = world(on)
  await turn($, on, clock, async () => {
    await toolUse($, 't1', 'Read', { file_path: '/work/a.png' })
    await toolUse($, 't2', 'Read', { file_path: '/work/b.png' })
    const row = await $.ui.mount(mountOf('terminal', 'ToolGroup', READ_A))
    expect(await row.find({ type: 'Image' })).toBeDefined()
  })
  const band = await $.ui.mount(mountOf('terminal', 'AbovePrompt', BAND, 'above-prompt'))
  expect((await band.findAll({ type: 'Image' })).map(i => (i.props as any).alt)).toEqual(['[b.png]'])
  await band.unmount()
  await $.prompt.submit({ text: 'next', wait: false, origin: { kind: 'composer' } } as any)
  const after = await $.ui.mount(mountOf('terminal', 'AbovePrompt', BAND, 'above-prompt'))
  expect(await after.find({ type: 'Image' })).toBeUndefined()
})
