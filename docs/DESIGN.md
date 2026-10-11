# claude-lens design

lens is a Claude Code mod (one hooks module, `hooks/register.tsx`) that previews images, SVGs and PDF pages where
they appear in a session. This note says how, and why, with what was measured on Claude Code 2.1.296 (macOS 26.6).

## Pipeline

```
SOURCES (session.append rows)  ->  RENDERERS (kind -> PNG thumbnail)  ->  PAINTERS (per surface and terminal)  ->  PLACEMENTS
```

### Sources

One `session.append` hook sees every row the conversation keeps and records a preview item (a file path plus where
it came from) in the `lens.gallery` state:

| Source | Row | How lens finds the file |
| --- | --- | --- |
| pasted | door `prompt` | the image block's base64, decoded into the cache |
| read | door `response`, `tool_use` Read | `input.file_path` |
| written | `tool_use` Write, Edit, MultiEdit, NotebookEdit; Bash | `file_path`; for Bash, image paths in the command whose file changed since the call |
| links | door `response`, text | markdown images `![..](path)` with a local path |
| toolImages | door `tool-result`, not Read | image blocks in the `tool_result`, decoded into the cache |

Why `session.append`: the render props do not carry what lens needs. `UserMessage` has the prompt's text but no image
data (`prompt.submit` has only kind and MIME); the bytes are on the appended row. A Read in the default view is
folded into a `ToolGroup` row and raises no `ToolResult` at all.

### Renderers

`RENDERERS` in `hooks/lib.ts` maps each kind to the argv steps that make a PNG of at most 800 px, chosen from the
tools `command -v` finds once per session:

| Kind | macOS (no install) | Linux |
| --- | --- | --- |
| image | `sips` | ImageMagick |
| svg | `sips` (renders SVG correctly on macOS 26) | `rsvg-convert`, else ImageMagick |
| pdf | page 1 `sips` (about 60 ms); other pages PDFKit through `osascript -l JavaScript` (`bin/pdfpage.js`, 200-900 ms) | `pdftoppm`, `mutool`, else ImageMagick |

A new kind is one entry in `RENDERERS`, one extension in `EXT` and one `userConfig` row.

Why host tools: a hooks module has no WebAssembly, no `eval` or `new Function`, no `CompressionStream`, and no Node
(measured), so a bundled rasteriser (resvg-wasm, pdf.js) cannot run. `$.process.run` runs the tools with no prompt.

### Painters

| Painter | Element | Where |
| --- | --- | --- |
| kitty | `Image` with a `{ file, format: 'png' }` source | terminal, when it paints kitty graphics |
| blocks | `Raster`: one cell per pixel column, U+2580 with the top pixel as foreground and the bottom as background | any other terminal |
| text | `Text`, the file name | `painter: text`, or a row scrolled off screen |
| svg | `Svg` with the file's markup | desktop, VS Code, mobile (no `Image` or `Raster` there) |

`auto` picks kitty when the environment says kitty or Ghostty outside tmux and screen (`TERM`, `TERM_PROGRAM`,
`KITTY_WINDOW_ID`, `GHOSTTY_RESOURCES_DIR`, `TMUX`, `STY`, `CLAUDE_CODE_FORCE_TERMINAL_IMAGES`), else blocks. The mod
cannot ask the engine, which probes the terminal itself; these are the same signals its debug log reports.

The blocks need raw pixels and the module has no zlib, so a second step makes an uncompressed BMP (`sips -s format
bmp -z h w`) or PPM (ImageMagick), parsed in `lib.ts`.

### Placements

| Placement | Hook |
| --- | --- |
| inline, Read | `ToolGroup` (folded), `ToolUse` (unfolded, ctrl+o) |
| inline, Write/Edit/Bash/tool images | `ToolResult` |
| inline, pasted | `UserMessage`, matched by the append uuid less its last group (the row's id is the uuid with the last group zeroed) |
| inline, links | `AssistantMessage`, from the reply's own text |
| above the prompt | `AbovePrompt`, from `[Image #n]` tags in the draft and Claude Code's paste cache (polled every 250 ms, after claude-image-view) |
| gallery | `Pane` `lens`, opened by `/lens`: the newest 12 |
| fallback | `AbovePrompt`: this turn's previews no row drew, from the turn's end until the next prompt |

Each preview is drawn under `await next(e)`, so the engine's own row stays.

## Config

`userConfig` in `plugin.json`: one `/config` row each (11 rows, verified in `/config`). Values live in user settings
`pluginConfigs.lens.options`; project settings are not read. A change reloads the module. `/lens on|off` is a
session switch kept in `$.store`.

## Decisions and the evidence for them

- **Prepare in the collector, not only in the draw.** A draw that is superseded has its `$.process.run` killed and
  its promise never settles; on the main screen a finished row is printed once. A live run showed a PDF row printed
  bare because its converter was killed mid-run. So the `session.append` collector makes the thumbnail and the block
  cells as soon as Claude names the file, draws never share in-flight work, only settled results are cached, and each
  conversion writes a temporary file and moves it into place.
- **`{ file }` sources, not bytes.** The terminal reads the file itself: no 2 MiB cap, no pixels through `$`.
- **A fallback for rows another mod answers.** Mod hooks nest in `enabledPlugins` order, first outermost. claude-skins
  answers `ToolGroup`, a closed `ToolUse` and `UserMessage` with its own card and no `next(e)`, so a lens listed after
  it never runs on those rows (0.1.1 debug run: lens's `ToolGroup` hook ran 0 times with skins first, 6 times with lens
  first). lens cannot change the order, so it records what each inline hook drew, and 1.5 s after `turn.complete` puts
  the turn's undrawn previews in the band above the prompt, which skins hands on. With lens first, or without such a
  mod, nothing goes to the band.
- **Reply links are labelled, not moved.** A preview sits under the whole reply: placing it after the paragraph that
  holds the link would mean lens redrawing the reply itself, replacing Claude Code's drawing (and any other mod's).
  Instead each preview is labelled with the link's text and file, `revenue by month (chart.png)`, which is how Claude
  Code draws the link in the reply.
- **Skip failed rows.** A Read that errored (a 231-page PDF without `pages`) gets no preview.
- **Remote surfaces draw SVG only.** Desktop, VS Code and mobile have no `Image` element; a PNG wrapped in an SVG data
  URI may work there but was not tested.
- **Plugin name `lens`, version floor 2.1.294.** The mod loaded and drew on 2.1.294 and 2.1.296 (mock API runs).

## Limits

- 255 kitty image ids at once (the engine draws the alt past that).
- `Raster` paints 1024 color pairs per frame; the rest take the nearest.
- `$.fs` reads and writes at most 4 MiB, text writes only; inputs over 64 MB are skipped.
- Windows: not supported (`/bin/sh`).

## Verified, and not

Verified on macOS with Claude Code 2.1.296 against a mock Messages API: inline previews for a Read PNG, SVG and
2-page PDF, a reply's image link, a Write of an SVG, a Bash command that made a PNG, a pasted image, the band, the
gallery pane, the 11 `/config` rows, and a 2.1.294 run. In a pseudo-terminal that answers Claude Code's probes as
Ghostty, the engine sent each preview as kitty graphics (`a=T,U=1,f=100,t=f`, 1440 placeholder cells for three
pictures). Not verified: a real kitty or Ghostty window, Linux converters, the desktop app, VS Code and mobile.
