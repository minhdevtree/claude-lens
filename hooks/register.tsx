import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, RenderSurface } from 'claude-code'

import type { LensDraftImage, LensItem } from '../types'
import {
  MEDIA_EXT, RENDERERS, TOOL_NAMES, baseName, commandPaths, configOf, fitCells, hash, imageLinks, imageNumbers, kindOf,
  paintsImages, parseBmp, parsePpm, pixelsPlan, pngSize, rasterCells, rowKey,
} from './lib'
import type { Config, Kind, Size, Source } from './lib'

type $ = EngineInterface

const gallery = atom({ plugin: 'lens', key: 'gallery' } as const, [] as LensItem[])
const draft = atom({ plugin: 'lens', key: 'draft' } as const, [] as LensDraftImage[])
const muted = atom({ plugin: 'lens', key: 'muted' } as const, false)

/** Longest side of a thumbnail PNG, in pixels: enough for 40 rows of a high-density terminal. */
const THUMB_PX = 800
/** A file bigger than this is not handed to a converter. */
const MAX_INPUT_BYTES = 64 * 1024 * 1024
/** The newest previews the gallery keeps, and how many its pane draws (each Image holds one of 255 terminal ids). */
const GALLERY_KEEP = 300
const GALLERY_SHOWN = 12
const POLL_MS = 250
const READS = new Set(['Read'])
const WRITES = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

type Host = { tools: Set<string>; cache: string; kitty: boolean; cwd: string; root: string; tmp: string }
type Thumb = { png: string; size: Size } | { error: string }
type Preview = { path: string; label: string; key: string }

let host: Promise<Host> | undefined
const jobs = new Map<string, Promise<Thumb>>()
const cellJobs = new Map<string, Promise<{ cells: string; columns: number; rows: number } | undefined>>()
const bashCalls = new Map<string, { command: string; at: number }>()
let isPolling = false
let isChecking = false
let pasteDir: { sessionId: string; dir: string } | undefined

async function setup($: $): Promise<Host> {
  const found = await $.process.run(['/bin/sh', '-c', 'for t in "$@"; do command -v "$t" >/dev/null 2>&1 && echo "$t"; done', 'sh', ...TOOL_NAMES])
    .catch(() => ({ stdout: '' }))
  const tmp = ((await $.env.get('TMPDIR')) ?? '/tmp').replace(/\/+$/, '')
  const kitty = paintsImages({
    CLAUDE_CODE_FORCE_TERMINAL_IMAGES: await $.env.get('CLAUDE_CODE_FORCE_TERMINAL_IMAGES'),
    TMUX: await $.env.get('TMUX'),
    STY: await $.env.get('STY'),
    TERM: await $.env.get('TERM'),
    TERM_PROGRAM: await $.env.get('TERM_PROGRAM'),
    KITTY_WINDOW_ID: await $.env.get('KITTY_WINDOW_ID'),
    GHOSTTY_RESOURCES_DIR: await $.env.get('GHOSTTY_RESOURCES_DIR'),
  })
  return { tools: new Set(found.stdout.split('\n').filter(Boolean)), cache: `${tmp}/claude-lens`, kitty, cwd: await $.session.cwd(), root: $.plugin.root, tmp }
}

function hostOf($: $): Promise<Host> {
  host ??= setup($)
  return host
}

async function run($: $, steps: readonly string[][]): Promise<string | undefined> {
  for (const argv of steps) {
    const ran = await $.process.run(argv, { timeoutMs: 20_000 }).catch((err: unknown) => ({ exitCode: -1, stderr: String(err) }))
    if (ran.exitCode !== 0) return `${argv[0]} failed: ${ran.stderr.trim().split('\n')[0]?.slice(0, 120) ?? ''}`
  }
  return undefined
}

/** A PNG thumbnail of one page of `path` in the cache, made once per content (path, size, mtime). */
async function thumbnail($: $, path: string, kind: Kind, page: number): Promise<Thumb> {
  const env = await hostOf($)
  const stat = await $.fs.stat(path).catch(() => undefined)
  if (stat === undefined || stat.kind !== 'file') return { error: 'file not found' }
  if (stat.size > MAX_INPUT_BYTES) return { error: `too big to preview (${Math.round(stat.size / 1048576)} MB)` }
  const out = `${env.cache}/${hash(`${path}|${stat.size}|${stat.mtimeMs}|${page}|${THUMB_PX}`)}.png`
  let job = jobs.get(out)
  if (job === undefined) {
    job = (async (): Promise<Thumb> => {
      if (!(await $.fs.exists(out))) {
        const steps = RENDERERS[kind](path, out, THUMB_PX, page, env.tools, env.root)
        if (steps === undefined) return { error: `no ${kind} converter found (see the lens README)` }
        await $.fs.write(`${env.cache}/.keep`, '')
        const failed = await run($, steps)
        if (failed !== undefined) return { error: failed }
      }
      const bytes = await $.fs.read(out, { as: 'bytes' }).catch(() => undefined)
      const size = bytes && pngSize(bytes.base64)
      return size ? { png: out, size } : { error: 'the converter made no picture' }
    })()
    jobs.set(out, job)
    job.then(t => { if ('error' in t) jobs.delete(out) })
  }
  return job
}

/** Colored-block cells for a thumbnail, `columns` x `rows` cells (two pixel rows a cell). */
async function blockCells($: $, png: string, columns: number, rows: number) {
  const key = `${png}|${columns}x${rows}`
  let job = cellJobs.get(key)
  if (job === undefined) {
    job = (async () => {
      const env = await hostOf($)
      const plan = pixelsPlan(png, png.replace(/\.png$/, `-${columns}x${rows * 2}`), columns, rows * 2, env.tools)
      if (plan === undefined || (await run($, plan.steps)) !== undefined) return undefined
      const file = png.replace(/\.png$/, `-${columns}x${rows * 2}.${plan.format}`)
      const { base64 } = await $.fs.read(file, { as: 'bytes' })
      const bytes = Uint8Array.fromBase64(base64)
      return rasterCells(plan.format === 'bmp' ? parseBmp(bytes) : parsePpm(bytes))
    })()
    cellJobs.set(key, job)
  }
  return job
}

/** Writes base64 bytes (a pasted or returned image) to the cache and answers the file's path. */
async function saveBytes($: $, base64: string, mediaType: string): Promise<string | undefined> {
  const env = await hostOf($)
  const ext = MEDIA_EXT[mediaType]
  if (ext === undefined) return undefined
  const out = `${env.cache}/${hash(base64)}-${base64.length}.${ext}`
  if (await $.fs.exists(out)) return out
  await $.fs.write(`${out}.b64`, base64)
  const ran = await $.process.run(['/bin/sh', '-c', 'base64 -d < "$1" > "$2" && rm -f "$1"', 'sh', `${out}.b64`, out]).catch(() => undefined)
  return ran?.exitCode === 0 ? out : undefined
}

/**
 * The tree for some previews on this surface: each a picture (kitty), colored blocks, or its name, under a dim
 * label. `els` is the surface's element table.
 */
async function previews($: $, e: { surface: RenderSurface; viewport?: { columns: number }; props: unknown }, cfg: Config,
  items: readonly Preview[], maxColumns: number, maxRows: number): Promise<RenderElement[]> {
  const els = $.ui.resolve(e as never) as Record<string, (...args: never[]) => RenderElement>
  const { Box, Text } = els as never as { Box: any; Text: any }
  const env = await hostOf($)
  const nodes: RenderElement[] = []
  const offScreen = (e.props as { onScreen?: unknown }).onScreen === null
  for (const item of items) {
    const kind = kindOf(item.path)
    if (kind === undefined || !cfg.kinds[kind]) continue
    if (e.surface !== 'terminal') {
      // Remote surfaces have no Image or Raster; an SVG can be drawn by their Svg element.
      if (kind !== 'svg') continue
      const { Svg } = els as never as { Svg: any }
      const source = await $.fs.read(item.path).catch(() => '')
      if (source.length > 0 && source.length <= 131072) {
        nodes.push(<Box flexDirection="column"><Text dimColor>{item.label}</Text><Svg source={source} alt={item.label} width={320} /></Box>)
      }
      continue
    }
    const painter = cfg.painter === 'auto' ? (env.kitty ? 'kitty' : 'blocks') : cfg.painter
    if (painter === 'text' || offScreen) {
      nodes.push(<Text dimColor>{`  ${item.label}`}</Text>)
      continue
    }
    const pages = kind === 'pdf' ? cfg.pdfPages : 1
    const width = Math.max(4, Math.floor((maxColumns - (pages - 1)) / pages))
    const row: RenderElement[] = []
    for (let page = 1; page <= pages; page++) {
      const t = await thumbnail($, item.path, kind, page)
      if ('error' in t) {
        if (page === 1) row.push(<Text dimColor>{`${item.label}: ${t.error}`}</Text>)
        break
      }
      const cells = fitCells(t.size, maxRows, width)
      if (painter === 'kitty') {
        const { Image } = els as never as { Image: any }
        row.push(<Image key={`${item.key}-${page}`} source={{ file: t.png, format: 'png' }} columns={cells.columns} rows={cells.rows} alt={`[${item.label}${pages > 1 ? ` p${page}` : ''}]`} />)
      } else {
        const { Raster } = els as never as { Raster: any }
        const r = await blockCells($, t.png, cells.columns, cells.rows)
        row.push(r ? <Raster key={`${item.key}-${page}`} cells={r.cells} columns={r.columns} rows={r.rows} /> : <Text dimColor>{`${item.label}: no pixel converter found`}</Text>)
      }
    }
    nodes.push(<Box flexDirection="column"><Text dimColor>{item.label}</Text><Box flexDirection="row" columnGap={1}>{row}</Box></Box>)
  }
  return nodes
}

/** Draws `previews` under what the engine draws for this row, indented like a tool's output. */
async function under($: $, e: any, next: (e: any) => Promise<RenderElement>, cfg: Config, items: readonly Preview[]): Promise<RenderElement> {
  if (items.length === 0) return next(e)
  const below = await next(e)
  const { Box } = $.ui.resolve(e) as never as { Box: any }
  const columns = Math.min(120, (e.viewport?.columns ?? 80) - 8)
  const nodes = await previews($, e, cfg, items, columns, cfg.maxRows)
  if (nodes.length === 0) return below
  return <Box flexDirection="column">{below}<Box flexDirection="column" paddingLeft={5}>{nodes}</Box></Box>
}

async function itemsFor($: $, cfg: Config, test: (item: LensItem) => boolean): Promise<Preview[]> {
  const list = await read($, gallery)
  return list.filter(item => cfg.where[item.source] === 'inline' || (item.source === 'pasted' && cfg.where.pasted === 'above'))
    .filter(test).map(item => ({ path: item.path, label: item.label, key: hash(item.id) }))
}

async function addItems($: $, items: readonly LensItem[]) {
  if (items.length === 0) return
  await update($, gallery, list => {
    const ids = new Set(list.map(item => item.id))
    return [...list, ...items.filter(item => !ids.has(item.id))].slice(-GALLERY_KEEP)
  })
}

/** Turns one stored row into previews: pasted images, files a tool reads or writes, image links, images a tool returns. */
async function collect($: $, cfg: Config, e: any, uuid: string) {
  const blocks: any[] = Array.isArray(e.message?.content) ? e.message.content : []
  const env = await hostOf($)
  const at = await $.clock.now()
  const wants = (source: Source, path: string) => {
    const kind = kindOf(path)
    return cfg.where[source] !== 'off' && kind !== undefined && cfg.kinds[kind]
  }
  const found: LensItem[] = []
  if (e.door === 'prompt') {
    let n = 0
    for (const b of blocks) {
      if (b.type !== 'image' || b.source?.type !== 'base64') continue
      n += 1
      const path = await saveBytes($, b.source.data, b.source.media_type)
      if (path && wants('pasted', path)) found.push({ id: `${uuid}:${n}`, source: 'pasted', path, label: `pasted image ${n}`, row: rowKey(uuid), at })
    }
  }
  if (e.door === 'response') {
    for (const b of blocks) {
      if (b.type === 'tool_use') {
        const path = b.input?.file_path ?? b.input?.notebook_path
        const source: Source | undefined = READS.has(b.name) ? 'read' : WRITES.has(b.name) ? 'written' : undefined
        if (source && typeof path === 'string' && wants(source, path)) {
          found.push({ id: `${b.id}:${path}`, source, path, label: baseName(path), toolUseId: b.id, at })
        }
        if (b.name === 'Bash' && typeof b.input?.command === 'string') bashCalls.set(b.id, { command: b.input.command, at })
      }
      if (b.type === 'text' && typeof b.text === 'string') {
        for (const path of imageLinks(b.text, env.cwd)) {
          if (wants('links', path)) found.push({ id: `${uuid}:${path}`, source: 'links', path, label: baseName(path), at })
        }
      }
    }
  }
  if (e.door === 'tool-result') {
    const tool = e.origin?.tool
    for (const b of blocks) {
      if (b.type !== 'tool_result') continue
      const bash = bashCalls.get(b.tool_use_id)
      if (bash) {
        bashCalls.delete(b.tool_use_id)
        for (const path of commandPaths(bash.command, env.cwd)) {
          const stat = await $.fs.stat(path).catch(() => undefined)
          // Only a file the command just made or changed, not one it merely read.
          if (stat?.kind === 'file' && stat.mtimeMs >= bash.at - 2000 && wants('written', path)) {
            found.push({ id: `${b.tool_use_id}:${path}`, source: 'written', path, label: baseName(path), toolUseId: b.tool_use_id, at })
          }
        }
      }
      if (READS.has(tool) || !Array.isArray(b.content)) continue
      let n = 0
      for (const c of b.content) {
        if (c.type !== 'image' || c.source?.type !== 'base64') continue
        n += 1
        const path = await saveBytes($, c.source.data, c.source.media_type)
        if (path && wants('toolImages', path)) {
          found.push({ id: `${b.tool_use_id}:${n}`, source: 'toolImages', path, label: `${tool ?? 'tool'} image ${n}`, toolUseId: b.tool_use_id, at })
        }
      }
    }
  }
  await addItems($, found)
}

// The draft band: Claude Code caches each paste as <tmp>/<project>/<session>/images/<n>.png and puts an
// `[Image #n]` tag in the prompt; pasting raises no prompt event, so the draft is polled. After claude-image-view (MIT).
async function findPasteDir($: $): Promise<string | undefined> {
  const sessionId = await $.session.id()
  if (pasteDir?.sessionId === sessionId) return pasteDir.dir
  const root = (await $.env.get('CLAUDE_CODE_TMPDIR')) ?? `/tmp/claude-${(await $.process.run(['id', '-u'])).stdout.trim()}`
  for (const entry of await $.fs.list(root).catch(() => [])) {
    const dir = `${root}/${entry.name}/${sessionId}/images`
    if (entry.kind === 'dir' && (await $.fs.exists(dir))) {
      pasteDir = { sessionId, dir }
      return dir
    }
  }
  return undefined
}

async function checkDraft($: $) {
  if (isChecking) return
  isChecking = true
  try {
    const numbers = imageNumbers((await $.prompt.read()).text)
    const before = await read($, draft)
    if (numbers.join() === before.map(d => d.n).join() && before.every(d => d.path !== null)) return
    const dir = numbers.length > 0 ? await findPasteDir($) : undefined
    const next: LensDraftImage[] = []
    for (const n of numbers) {
      const path = dir === undefined ? null : `${dir}/${n}.png`
      next.push({ n, path: path !== null && (await $.fs.exists(path)) ? path : null })
    }
    if (JSON.stringify(next) !== JSON.stringify(before)) await update($, draft, () => next)
  } finally {
    isChecking = false
  }
}

function startPolling($: $) {
  if (isPolling) return
  isPolling = true
  $.clock.every(POLL_MS, () => void checkDraft($).catch(() => {}))
}

async function status($: $, cfg: Config): Promise<string> {
  const env = await hostOf($)
  const painter = cfg.painter === 'auto' ? `auto (${env.kitty ? 'pictures' : 'colored blocks'})` : cfg.painter
  const off = (await read($, muted)) ? ' (off for now: /lens on)' : ''
  return [
    `drawing ${painter}${off}; images ${cfg.kinds.image ? 'on' : 'off'}, svg ${cfg.kinds.svg ? 'on' : 'off'}, pdf ${cfg.kinds.pdf ? `on (${cfg.pdfPages} page${cfg.pdfPages > 1 ? 's' : ''})` : 'off'}`,
    `placement: pasted ${cfg.where.pasted}, read ${cfg.where.read}, written ${cfg.where.written}, links ${cfg.where.links}, tool images ${cfg.where.toolImages}; up to ${cfg.maxRows} rows`,
    `converters: ${[...env.tools].join(', ') || 'none found'}; cache ${env.cache}`,
    `gallery: ${(await read($, gallery)).length} previews this session. Change these in /config (lens rows).`,
  ].join('\n')
}

export const register: Register = (on, options) => {
  const cfg = configOf(options as Record<string, unknown>)

  on('session.start', async ($, e, next) => {
    void hostOf($)
    const stored = await $.store.get('muted')
    if (stored === true) await update($, muted, () => true)
    await $.command.register({ name: 'lens', description: 'Image, SVG and PDF previews: the gallery, on/off, status', argumentHint: '[gallery|on|off|status|clear]' })
    if (cfg.where.pasted === 'above') startPolling($)
    return next(e)
  })

  on('command.run', { command: 'lens' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'on' || arg === 'off') {
      await update($, muted, () => arg === 'off')
      await $.store.set('muted', arg === 'off')
      return { text: `previews ${arg}` }
    }
    if (arg === 'status') return { text: await status($, cfg) }
    if (arg === 'clear') {
      await update($, gallery, () => [])
      return { text: 'gallery cleared' }
    }
    if (arg !== '' && arg !== 'gallery') return { text: 'usage: /lens [gallery|on|off|status|clear]' }
    const opened = await $.ui.open({ id: 'lens', title: 'lens gallery' })
    return { text: opened.isPlaced ? 'gallery opened' : 'gallery: widen the terminal to see it' }
  })

  on('session.append', async ($, e, next) => {
    const stored = await next(e)
    if (stored.uuid !== undefined) await collect($, cfg, e, stored.uuid).catch(() => {})
    return stored
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (e.props.isExpanded || (await read($, muted))) return next(e)
    const done = new Set(e.props.calls.filter(c => !c.isRunning && !c.isErrored).map(c => c.tool_use_id))
    return under($, e, next, cfg, await itemsFor($, cfg, item => item.toolUseId !== undefined && done.has(item.toolUseId)))
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    // A Read is drawn in a group; unfolded (verbose, ctrl+o) its rows are ToolUse with the output inline.
    if (!READS.has(e.props.tool) || e.props.isRunning || e.props.isErrored || (await read($, muted))) return next(e)
    return under($, e, next, cfg, await itemsFor($, cfg, item => item.toolUseId === e.props.tool_use_id))
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (READS.has(e.props.tool) || e.props.isErrored || (await read($, muted))) return next(e)
    return under($, e, next, cfg, await itemsFor($, cfg, item => item.toolUseId === e.props.tool_use_id))
  })

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (await read($, muted)) return next(e)
    const row = rowKey(e.requestId)
    return under($, e, next, cfg, await itemsFor($, cfg, item => item.row === row))
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (cfg.where.links !== 'inline' || (await read($, muted))) return next(e)
    const env = await hostOf($)
    const items = imageLinks(e.props.text, env.cwd).map(path => ({ path, label: baseName(path), key: hash(path) }))
    return under($, e, next, cfg, items)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (cfg.where.pasted !== 'above' || e.props.hasSurvey || (await read($, muted))) return next(e)
    startPolling($)
    const list = (await read($, draft)).filter(d => d.path !== null)
    if (list.length === 0) return next(e)
    const below = await next(e)
    const { Box } = $.ui.resolve(e) as never as { Box: any }
    const rows = Math.max(1, Math.min(cfg.maxRows, 6, e.props.maxRows - 3))
    const width = Math.max(4, Math.floor(e.props.bodyColumns / list.length) - 2)
    const items = list.map(d => ({ path: d.path!, label: `[Image #${d.n}]`, key: `draft-${d.n}` }))
    const nodes = await previews($, e, cfg, items, width, rows)
    return <Box flexDirection="column"><Box flexDirection="row" columnGap={2}>{nodes}</Box>{below}</Box>
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== 'lens') return next(e)
    const { Box, Text } = $.ui.resolve(e) as never as { Box: any; Text: any }
    const list = [...(await read($, gallery))].filter(item => cfg.where[item.source] !== 'off').reverse().slice(0, GALLERY_SHOWN)
    if (list.length === 0) return <Text dimColor>No previews yet this session. Paste an image, or have Claude read or write one.</Text>
    const items = list.map(item => ({ path: item.path, label: `${item.label}  (${item.source === 'toolImages' ? 'tool image' : item.source})`, key: hash(item.id) }))
    const nodes = await previews($, e, cfg, items, e.props.bodyColumns - 2, Math.min(cfg.maxRows, 8))
    return <Box flexDirection="column" rowGap={1}>{nodes}</Box>
  })
}
