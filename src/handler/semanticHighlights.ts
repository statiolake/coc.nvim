import { Neovim } from "@chemzqm/neovim"
import {
  CancellationTokenSource,
  Disposable,
  Range
} from "vscode-languageserver-protocol"
import languages from "../languages"
import Document from "../model/document"
import { disposeAll } from "../util"
import workspace from "../workspace"
const logger = require("../util/logger")("documentSemanticHighlight")

const NS_SEMANTIC_HIGHLIGHTS: string = "ns-semantic-highlights"
const HL_SEMANTIC_TOKENS_PREFIX: string = "CocSem_"

/**
 * Semantic highlights for current buffer.
 */
export default class SemanticHighlights {
  private disposables: Disposable[] = []
  private tokenSource: CancellationTokenSource = null
  private buffers: Set<number> = new Set()

  constructor(private nvim: Neovim) {}

  public async semanticHighlight(doc: Document): Promise<boolean> {
    const nvim = this.nvim
    this.cancel()

    if (!doc || !doc.attached) return false
    if (!languages.hasProvider("semanticTokens", doc.textDocument)) return false

    const highlights = await this.getHighlights(doc)
    if (!highlights) return false

    const map: Map<string, Range[]> = new Map()
    for (const [group, range] of highlights) {
      if (!map.has(group)) map.set(group, [])
      map.get(group).push(range)
    }

    // record, clear, and add highlights
    nvim.pauseNotification()
    doc.buffer.clearNamespace(NS_SEMANTIC_HIGHLIGHTS)
    for (const [group, ranges] of map) {
      doc.buffer.highlightRanges(NS_SEMANTIC_HIGHLIGHTS, group, ranges)
    }
    if (workspace.isVim) nvim.command("redraw", true)

    const res = nvim.resumeNotification()
    if (Array.isArray(res) && res[1] != null) {
      logger.error("Error on highlight", res[1][2])
    } else {
      this.highlights.set(bufnr, highlights)
    }

    return true
  }

  public async getHighlights(
    doc: Document
  ): Promise<[group: string, range: Range][]> {
    if (!doc || !doc.attached) return null
    if (!languages.hasProvider("semanticTokens", doc.textDocument)) return null

    try {
      const { token: _token } = new CancellationTokenSource()
      doc.forceSync()
      const legend = languages.getSemanticTokensLegend()
      const highlights = await languages.provideDocumentSemanticTokens(
        doc.textDocument,
        _token
      )

      let res: [string, Range][] = []
      let currentLine = 0
      let currentChar = 0
      for (let i = 0; i < highlights.data.length; i += 5) {
        const deltaLine = highlights.data[i]
        const deltaStartChar = highlights.data[i + 1]
        const length = highlights.data[i + 2]
        const tokenType = highlights.data[i + 3]
        // TODO: support tokenModifiers
        // const tokenModifiers = highlights.data[i + 4];

        const line = currentLine + deltaLine
        const startChar =
          deltaLine == 0 ? currentChar + deltaStartChar : deltaStartChar
        currentLine = line
        currentChar = startChar

        res.push([
          HL_SEMANTIC_TOKENS_PREFIX + legend.tokenTypes[tokenType],
          {
            start: { line: line, character: startChar },
            end: { line: line, character: startChar + length }
          }
        ])
      }

      return res
    } catch (_e) {
      return null
    }
  }

  public hasHighlights(bufnr: number): boolean {
    return this.buffers.has(bufnr)
  }

  public clearHighlights(): void {
    if (this.buffers.size == 0) return
    for (const bufid of this.buffers) {
      const buf = this.nvim.createBuffer(bufid)
      buf.clearNamespace(NS_SEMANTIC_HIGHLIGHTS)
    }
    this.buffers.clear()
  }

  private cancel(): void {
    if (this.tokenSource) {
      this.tokenSource.cancel()
      this.tokenSource.dispose()
      this.tokenSource = null
    }
  }

  public dispose(): void {
    this.clearHighlights()
    this.buffers.clear()
    this.cancel()
    disposeAll(this.disposables)
  }
}
