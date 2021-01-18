import { Neovim } from "@chemzqm/neovim"
import {
  CancellationTokenSource,
  Disposable
} from "vscode-languageserver-protocol"
import languages from "../languages"
import Document from "../model/document"
import { disposeAll } from "../util"
import workspace from "../workspace"

const logger = require("../util/logger")("documentSemanticHighlight")

const SEMANTIC_HIGHLIGHTS_NAMESPACE: string = "ns-semantic-highlights"
const SEMANTIC_HIGHLIGHTS_HLGROUP_PREFIX: string = "CocSem_"

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
 * highlight
 */
interface Highlight {
  group: string
  line: number // 0-indexed
  startCharacter: number // 0-indexed
  endCharacter: number // 0-indexed
}

/**
 * Semantic highlights for current buffer.
 */
export default class SemanticHighlights {
  private disposables: Disposable[] = []
  private tokenSource: CancellationTokenSource = null
  private highlightGroups: Map<number, Set<string>> = new Map()

  constructor(private nvim: Neovim) {}

  public async semanticHighlight(doc: Document): Promise<boolean> {
    const nvim = this.nvim
    this.cancel()

    if (!doc || !doc.attached) return false
    if (!languages.hasProvider("semanticTokens", doc.textDocument)) return false
    if (!(await this.vimCheckFeatures())) return false

    logger.debug("initial check OK")

    const curr = await this.getHighlights(doc)
    if (!curr) return false

    logger.debug("getting new highlights finished")

    const bufnr = doc.bufnr

    const prev = await this.vimGetCurrentHighlights(doc)

    logger.debug("getting existing highlights finished")

    const highlightChanges = this.calculateHighlightUpdates(prev, curr)
    logger.debug("calculating highlight changes finished")
    // logger.debug(
    //   `calculating highlight changes finished: updates ${JSON.stringify(
    //     Object.fromEntries(highlightChanges)
    //   )}`
    // )

    // record, clear, and add highlights
    nvim.pauseNotification()
    this.vimPrepareHighlighting(doc)
    logger.debug("preparing highlighting finished")
    for (const [line, highlights] of highlightChanges) {
      this.vimClearHighlights(doc, line)
      for (const hl of highlights) this.vimAddHighlight(doc, hl)
    }
    logger.debug("adding highlights finished")
    if (workspace.isVim) nvim.command("redraw", true)

    const res = nvim.resumeNotification()
    if (Array.isArray(res) && res[1] != null) {
      logger.error("Error on highlight", res[1][2])
    } else {
      const groups = new Set(curr.map(e => e.group))
      this.highlightGroups.set(bufnr, groups)
    }
    logger.debug("semantic highlighting finished")

    return true
  }

  public async getHighlights(doc: Document): Promise<Highlight[]> {
    if (!doc || !doc.attached) return null
    if (!languages.hasProvider("semanticTokens", doc.textDocument)) return null

    try {
      const relatives = await this.getRelativeHighlights(doc)

      let res: Highlight[] = []
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
        const endCharacter = startCharacter + length
        currentLine = line
        currentCharacter = startCharacter

        res.push({ group, line, startCharacter, endCharacter })
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

        const group =
          SEMANTIC_HIGHLIGHTS_HLGROUP_PREFIX + legend.tokenTypes[tokenType]
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
    prev: Highlight[],
    curr: Highlight[]
  ): Map<number, Highlight[]> {
    const stringCompare = Intl.Collator("en").compare
    function compare(a: Highlight, b: Highlight): number {
      return (
        a.line - b.line ||
        a.startCharacter - b.startCharacter ||
        a.endCharacter - b.endCharacter ||
        stringCompare(a.group, b.group)
      )
    }

    prev = prev.slice().sort(compare)
    curr = curr.slice().sort(compare)

    const prevByLine: Map<number, Highlight[]> = new Map()
    for (const hl of prev) {
      if (!prevByLine.has(hl.line)) prevByLine.set(hl.line, [])
      prevByLine.get(hl.line).push(hl)
    }

    const currByLine: Map<number, Highlight[]> = new Map()
    for (const hl of curr) {
      if (!currByLine.has(hl.line)) currByLine.set(hl.line, [])
      currByLine.get(hl.line).push(hl)
    }

    const lastLine = Math.max(
      (prev[prev.length - 1] || { line: 0 }).line,
      (curr[curr.length - 1] || { line: 0 }).line
    )
    const lineNumbersToUpdate: Set<number> = new Set()
    for (let i = 0; i <= lastLine; i++) {
      const ph = prevByLine.has(i)
      const ch = currByLine.has(i)
      if (ph !== ch) {
        lineNumbersToUpdate.add(i)
        continue
      } else if (!ph && !ch) {
        continue
      }

      const pp = prevByLine.get(i)
      const cc = currByLine.get(i)

      if (pp.length !== cc.length) {
        lineNumbersToUpdate.add(i)
        continue
      }

      for (let j = 0; j < pp.length; j++) {
        if (compare(pp[j], cc[j]) !== 0) {
          lineNumbersToUpdate.add(i)
          continue
        }
      }
    }

    const res: Map<number, Highlight[]> = new Map()
    for (const line of lineNumbersToUpdate) {
      res.set(line, currByLine.get(line) || [])
    }
    return res
  }

  public hasHighlights(bufnr: number): boolean {
    return this.highlightGroups.has(bufnr)
  }

  public clearHighlights(): void {
    if (this.highlightGroups.size == 0) return
    for (const bufnr of this.highlightGroups.keys()) {
      const doc = workspace.getDocument(bufnr)
      this.vimClearHighlights(doc)
    }
    this.highlightGroups.clear()
  }

  private async vimCheckFeatures(): Promise<boolean> {
    if (workspace.isVim) {
      return await this.nvim.call("has", ["textprop"])
    } else if (workspace.isNvim) {
      return await this.nvim.call("exists", ["*nvim_buf_add_highlight"])
    } else {
      return false
    }
  }

  private async vimPrepareHighlighting(doc: Document): Promise<void> {
    if (workspace.isVim) {
      this.highlightGroups.set(
        doc.bufnr,
        new Set(await this.nvim.call("prop_type_list"))
      )
    }
  }

  private async vimPrepareHighlightGroup(
    doc: Document,
    group: string
  ): Promise<void> {
    if (workspace.isVim) {
      await this.nvim.call("prop_type_add", [
        group,
        { bufnr: doc.bufnr, highlight: group }
      ])
    }
  }

  private async vimAddHighlight(
    doc: Document,
    highlight: Highlight
  ): Promise<void> {
    const { group, line, startCharacter, endCharacter } = highlight
    const readyHighlightGroups =
      this.highlightGroups.get(doc.bufnr) || new Set()
    if (!readyHighlightGroups.has(group)) {
      await this.vimPrepareHighlightGroup(doc, group)
    }

    if (workspace.isNvim) {
      const nsId = await this.nvim.call("nvim_create_namespace", [
        SEMANTIC_HIGHLIGHTS_NAMESPACE
      ])
      await this.nvim.call("nvim_buf_add_highlight", [
        doc.bufnr,
        nsId,
        group,
        line,
        startCharacter,
        endCharacter
      ])
    } else if (workspace.isVim) {
      await this.nvim.call("prop_add", [
        line + 1,
        startCharacter + 1,
        {
          end_lnum: line + 1,
          end_col: endCharacter + 1,
          bufnr: doc.bufnr,
          type: group
        }
      ])
    }
  }

  private async vimGetCurrentHighlights(doc: Document): Promise<Highlight[]> {
    const res: Highlight[] = []
    if (workspace.isVim) {
      for (let line = 0; line < doc.lineCount; line++) {
        const list = await this.nvim.call("prop_list", [
          line + 1,
          { bufnr: doc.bufnr }
        ])
        for (const prop of list) {
          let {
            type: group,
            col: startCharacter,
            length: length,
            start,
            end
          } = prop
          if (start === 0 || end === 0) {
            logger.info(
              `multiline token found: ${JSON.stringify(prop)}. ignore it.`
            )
            continue
          }

          startCharacter--
          const endCharacter = startCharacter + length
          res.push({ group, line, startCharacter, endCharacter })
        }
      }
    } else if (workspace.isNvim) {
      const nsId = await this.nvim.call("nvim_create_namespace", [
        SEMANTIC_HIGHLIGHTS_NAMESPACE
      ])
      const marks = await this.nvim.call("nvim_buf_get_extmarks", [
        doc.bufnr,
        nsId,
        0,
        -1,
        { details: true }
      ])

      for (const mark of marks) {
        const [
          ,
          line,
          startCharacter,
          { hl_group: group, end_col: endCharacter }
        ] = mark
        res.push({ group, line, startCharacter, endCharacter })
      }
    }
    return res
  }

  private async vimClearHighlights(
    doc: Document,
    line?: number
  ): Promise<void> {
    if (workspace.isVim) {
      line++
      const lineStart = line === undefined ? 1 : line
      const lineEnd = line === undefined ? doc.lineCount : line
      await this.nvim.call("prop_clear", [
        lineStart,
        lineEnd,
        { bufnr: doc.bufnr }
      ])
    } else if (workspace.isNvim) {
      const lineStart = line === undefined ? 0 : line
      const lineEnd = line === undefined ? -1 : line + 1
      const nsId = await this.nvim.call("nvim_create_namespace", [
        SEMANTIC_HIGHLIGHTS_NAMESPACE
      ])
      await this.nvim.call("nvim_buf_clear_namespace", [
        doc.bufnr,
        nsId,
        lineStart,
        lineEnd
      ])
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
    this.highlightGroups.clear()
    this.cancel()
    disposeAll(this.disposables)
  }
}
