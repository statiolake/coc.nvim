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

const Diff = require("diff")
const logger = require("../util/logger")("documentSemanticHighlight")

const NS_SEMANTIC_HIGHLIGHTS: string = "ns-semantic-highlights"
const HL_SEMANTIC_TOKENS_PREFIX: string = "CocSem_"

/**
 * Relative highlight
 */
interface RelativeHighlight {
  group: string
  deltaLine: number
  deltaStartCharacter: number
  length: number
}

/**
 * Semantic highlights for current buffer.
 */
export default class SemanticHighlights {
  private disposables: Disposable[] = []
  private tokenSource: CancellationTokenSource = null
  private highlights: Map<number, RelativeHighlight[]> = new Map()

  constructor(private nvim: Neovim) {}

  public async semanticHighlight(doc: Document): Promise<boolean> {
    const nvim = this.nvim
    this.cancel()

    if (!doc || !doc.attached) return false
    if (!languages.hasProvider("semanticTokens", doc.textDocument)) return false

    const curr = await this.getRelativeHighlights(doc)
    if (!curr) return false

    const bufnr = doc.bufnr

    const prev = this.highlights.has(bufnr) ? this.highlights.get(bufnr) : []
    const highlightChanges = this.calculateHighlightUpdates(prev, curr)
    logger.debug(
      `Highlight updates: ${JSON.stringify(
        Object.fromEntries(highlightChanges)
      )}`
    )

    // record, clear, and add highlights
    nvim.pauseNotification()
    for (const [line, highlights] of highlightChanges) {
      doc.buffer.clearNamespace(NS_SEMANTIC_HIGHLIGHTS, line, line + 1)
      for (const [group, range] of highlights) {
        this.vimAddHighlight(doc, group, range)
      }
    }
    if (workspace.isVim) nvim.command("redraw", true)

    const res = nvim.resumeNotification()
    if (Array.isArray(res) && res[1] != null) {
      logger.error("Error on highlight", res[1][2])
    } else {
      this.highlights.set(bufnr, curr)
    }

    return true
  }

  public async getHighlights(
    doc: Document
  ): Promise<[group: string, range: Range][]> {
    if (!doc || !doc.attached) return null
    if (!languages.hasProvider("semanticTokens", doc.textDocument)) return null

    try {
      const relatives = await this.getRelativeHighlights(doc)

      let res: [string, Range][] = []
      let currentLine = 0
      let currentCharacter = 0
      for (const {
        group,
        deltaLine,
        deltaStartCharacter,
        length
      } of relatives) {
        const line = currentLine + deltaLine
        const startCharacter =
          deltaLine == 0
            ? currentCharacter + deltaStartCharacter
            : deltaStartCharacter
        currentLine = line
        currentCharacter = startCharacter
        const start = { line: line, character: startCharacter }
        const end = { line: line, character: startCharacter + length }
        res.push([group, { start, end }])
      }

      return res
    } catch (_e) {
      return null
    }
  }

  private async getRelativeHighlights(
    doc: Document
  ): Promise<RelativeHighlight[]> {
    try {
      const { token: _token } = new CancellationTokenSource()
      doc.forceSync()
      const legend = languages.getSemanticTokensLegend()
      const highlights = await languages.provideDocumentSemanticTokens(
        doc.textDocument,
        _token
      )

      const res: RelativeHighlight[] = []
      for (let i = 0; i < highlights.data.length; i += 5) {
        const deltaLine = highlights.data[i]
        const deltaStartCharacter = highlights.data[i + 1]
        const length = highlights.data[i + 2]
        const tokenType = highlights.data[i + 3]
        // TODO: support tokenModifiers
        // const tokenModifiers = highlights.data[i + 4];

        const group = HL_SEMANTIC_TOKENS_PREFIX + legend.tokenTypes[tokenType]
        res.push({
          group,
          deltaLine,
          deltaStartCharacter,
          length
        })
      }

      return res
    } catch (_e) {
      return null
    }
  }

  public calculateHighlightUpdates(
    prev: RelativeHighlight[],
    curr: RelativeHighlight[]
  ): Map<number, [string, Range][]> {
    // Basically we need to update the added and removed part of highlights.
    // Since Vim's textprop and Neovim's highlight features follow changes to
    // line numbering (as lines are inserted/removed above the highlighted
    // line), we only need to highlight newly inserted lines or existing lines
    // whose highlights are changed.
    //
    // We can calculate highlights which need to be updated as follows:
    //
    // 1. Calculate differences of *relative* highlight positions (almost same
    // with the response of semanticTokens) between the previously processed
    // response and current resnponse. That will give us candidates of
    // highlight changes.
    //
    // 2. Calculate line numbers to update.
    //
    // 3. Calculate the new highlights
    //
    // 4. Add extra lines to update (as described below).
    //
    //   We sometimes cannot determine which line is changed concretely. For
    //   example,
    //
    //   line +1: +A +B
    //   line +1:  A  B
    //   line +1:  A  B
    //
    //   and
    //
    //   line +1:  A  B
    //   line +1: +A +B
    //   line +1:  A  B
    //
    //   and
    //
    //   line +1: +A +B -C -D
    //   line +1: A B
    //   line +1: A B
    //
    //   and so on.
    //
    //   (line +1 means deltaLine of the highlight is 1. A..D represents one
    //   highlight information.)
    //
    //   are undeterminable. If the continuous multiple lines have the same
    //   content as a result, we can do nothing other than updating all
    //   possible lines.
    //
    // 5. Return final highlight update.

    type ChangeObject = {
      value: RelativeHighlight[] | RelativeHighlight
      added: boolean
      removed: boolean
      count: number
    }

    // 1. Calculate differences of *relative* highlight positions
    function relativeHighlightEquals(
      a: RelativeHighlight,
      b: RelativeHighlight
    ): boolean {
      if (!a || !b) return false
      return (
        a.group === b.group &&
        a.deltaLine === b.deltaLine &&
        a.deltaStartCharacter === b.deltaStartCharacter &&
        a.length === b.length
      )
    }

    const diff: ChangeObject[] = Diff.diffArrays(prev, curr, {
      comparator: relativeHighlightEquals
    })

    const summary = diff.map(
      x => `${x.added ? "+" : x.removed ? "-" : "="}${x.count}`
    )
    logger.debug(`got diff: ${JSON.stringify(summary)}`)

    // 2. Calculate line numbers to update.
    const lineNumbersToUpdate: Set<number> = new Set()
    let currentLine = 0
    for (const { value, added, removed } of diff) {
      if (!Array.isArray(value)) return null
      for (const { deltaLine } of value) {
        const line = currentLine + deltaLine
        if (added || removed) lineNumbersToUpdate.add(line)
        if (!removed) currentLine = line
      }
    }

    // 3. Calculate the new highlights
    const highlights: Map<number, [group: string, range: Range][]> = new Map()
    currentLine = 0
    let currentCharacter = 0
    for (const { group, deltaLine, deltaStartCharacter, length } of curr) {
      const line = currentLine + deltaLine
      const startCharacter =
        deltaLine == 0
          ? currentCharacter + deltaStartCharacter
          : deltaStartCharacter
      currentLine = line
      currentCharacter = startCharacter
      const start = { line: line, character: startCharacter }
      const end = { line: line, character: startCharacter + length }

      if (!highlights.has(line)) highlights.set(line, [])
      highlights.get(line).push([group, { start, end }])
    }
    const lastLine = currentLine

    // 4. Add extra lines to update (as described below).
    function highlightsEquals(a: number, b: number): boolean {
      function equals(
        [ag, ar]: [string, Range],
        [bg, br]: [string, Range]
      ): boolean {
        return (
          ag === bg &&
          ar.start.character === br.start.character &&
          ar.end.character === br.end.character
        )
      }

      if (!highlights.has(a) || !highlights.has(b)) return false
      const aa = highlights.get(a)
      const bb = highlights.get(b)

      if (aa.length != bb.length) return false

      const stringify = ([g, r]) =>
        `${g}:${r.start.character}:${r.end.character}`
      const aaa = aa.map(stringify).sort().join("+")
      const bbb = bb.map(stringify).sort().join("+")
      return aaa === bbb
    }

    for (const update of lineNumbersToUpdate.keys()) {
      // backward
      for (let i = update - 1; i >= 0; i--) {
        // if i'th line is already registered as update, then the lines before
        // i'th line are already checked.
        if (lineNumbersToUpdate.has(i)) break

        // if all of the entries are the same, then this line should be
        // updated.
        if (highlightsEquals(update, i)) {
          lineNumbersToUpdate.add(i)
        } else {
          break
        }
      }

      // forward
      for (let i = update + 1; i <= lastLine; i++) {
        if (lineNumbersToUpdate.has(i)) break
        if (highlightsEquals(update, i)) {
          lineNumbersToUpdate.add(i)
        } else {
          break
        }
      }
    }

    return new Map(
      [...highlights.entries()].filter(([line]) =>
        lineNumbersToUpdate.has(line)
      )
    )
  }

  public hasHighlights(bufnr: number): boolean {
    return this.highlights.has(bufnr)
  }

  public clearHighlights(): void {
    if (this.highlights.size == 0) return
    for (const bufnr of this.highlights.keys()) {
      const doc = workspace.getDocument(bufnr)
      this.vimClearHighlights(doc)
    }
    this.highlights.clear()
  }

  private vimAddHighlight(doc: Document, group: string, range: Range): void {
    doc.buffer.highlightRanges(NS_SEMANTIC_HIGHLIGHTS, group, [range])
  }

  private vimClearHighlights(doc: Document, line?: number): void {
    if (line) {
      doc.buffer.clearNamespace(NS_SEMANTIC_HIGHLIGHTS, line, line + 1)
    } else {
      doc.buffer.clearNamespace(NS_SEMANTIC_HIGHLIGHTS)
    }
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
    this.highlights.clear()
    this.cancel()
    disposeAll(this.disposables)
  }
}
