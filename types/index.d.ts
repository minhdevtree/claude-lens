/** One preview lens has seen this session: a file on disk, and where it came from. */
export type LensItem = {
  /** Unique within the session. */
  id: string
  source: 'pasted' | 'read' | 'written' | 'links' | 'toolImages'
  /** Absolute path of the file shown (a pasted or returned image is first written to the cache). */
  path: string
  /** What the person reads beside it: the file's name, or `pasted image 1`. */
  label: string
  /** The tool call it belongs to, for previews drawn under a tool row. */
  toolUseId?: string
  /** The prompt row it belongs to (the append uuid less its last group), for pasted images. */
  row?: string
  /** When lens saw it, epoch ms. */
  at: number
}

/** An image the draft references as `[Image #n]`, and its file in Claude Code's paste cache when found. */
export type LensDraftImage = { n: number; path: string | null }

declare module 'claude-code' {
  interface PluginState {
    lens: { gallery: LensItem[]; draft: LensDraftImage[]; muted: boolean; unplaced: string[] }
  }
}
