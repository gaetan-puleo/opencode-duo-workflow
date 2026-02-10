import WebSocket from "isomorphic-ws"
import { v4 as uuid4 } from "uuid"
import type { Logger } from "./logger"
import { WebSocketWorkflowStream } from "./websocket_stream"
import type { ClientEvent } from "./types"

type WebSocketConnectionConfig = {
  gitlabInstanceUrl: URL
  token: string
}

export class WebSocketWorkflowClient {
  #logger: Logger
  #connectionDetails: WebSocketConnectionConfig
  #socket: WebSocket | null = null
  #stream: WebSocketWorkflowStream | null = null
  #correlationId = uuid4()

  constructor(logger: Logger, connectionDetails: WebSocketConnectionConfig) {
    this.#logger = logger
    this.#connectionDetails = connectionDetails
  }

  getCorrelationId(): string {
    return this.#correlationId
  }

  async executeWorkflow(): Promise<WebSocketWorkflowStream> {
    const url = this.#buildWebSocketUrl()
    const headers = this.#createConnectionHeaders()

    this.#socket = new WebSocket(url, { headers })
    this.#stream = new WebSocketWorkflowStream(this.#socket, this.#logger)

    await new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error("WebSocket connection timeout"))
      }, 15000)

      const onOpen = () => {
        clearTimeout(timeoutId)
        this.#stream?.removeListener("error", onError)
        resolve()
      }
      const onError = (err: Error) => {
        clearTimeout(timeoutId)
        this.#stream?.removeListener("open", onOpen)
        reject(err)
      }

      this.#stream?.once("open", onOpen)
      this.#stream?.once("error", onError)
    })

    return this.#stream
  }

  write(event: ClientEvent): boolean {
    if (!this.#stream) return false
    return this.#stream.write(event)
  }

  dispose(): void {
    this.#stream?.end()
    this.#stream = null
    this.#socket = null
  }

  #buildWebSocketUrl(): string {
    const baseUrl = new URL(this.#connectionDetails.gitlabInstanceUrl)
    const url = new URL("/api/v4/ai/duo_workflows/ws", baseUrl)
    url.protocol = baseUrl.protocol === "https:" ? "wss:" : "ws:"
    return url.toString()
  }

  #createConnectionHeaders(): Record<string, string> {
    return {
      authorization: `Bearer ${this.#connectionDetails.token}`,
      "x-request-id": this.#correlationId,
      "x-gitlab-language-server-version": "8.62.2",
      "user-agent": "duo-cli/8.62.2 gitlab-language-server/8.62.2",
      origin: this.#connectionDetails.gitlabInstanceUrl.origin,
    }
  }
}
