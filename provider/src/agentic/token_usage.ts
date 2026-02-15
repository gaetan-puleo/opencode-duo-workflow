/**
 * Client-side token usage estimation.
 *
 * GitLab Duo Workflow Service does not expose token counts in its events,
 * so we estimate usage by counting characters flowing through the stream
 * and dividing by an average chars-per-token ratio.
 *
 * The default ratio of 4 characters per token is a reasonable approximation
 * for English text across most LLMs. This is an estimate, not exact.
 */

const DEFAULT_CHARS_PER_TOKEN = 4

export class TokenUsageEstimator {
  #inputChars = 0
  #outputChars = 0
  #charsPerToken: number

  constructor(charsPerToken: number = DEFAULT_CHARS_PER_TOKEN) {
    this.#charsPerToken = charsPerToken
  }

  /** Record characters sent to DWS (prompt, system context, tool results). */
  addInputChars(text: string): void {
    this.#inputChars += text.length
  }

  /** Record characters received from DWS (text chunks, tool call args). */
  addOutputChars(text: string): void {
    this.#outputChars += text.length
  }

  get inputTokens(): number {
    return Math.ceil(this.#inputChars / this.#charsPerToken)
  }

  get outputTokens(): number {
    return Math.ceil(this.#outputChars / this.#charsPerToken)
  }

  get totalTokens(): number {
    return this.inputTokens + this.outputTokens
  }

  /** Reset counters for a new turn. */
  reset(): void {
    this.#inputChars = 0
    this.#outputChars = 0
  }
}
