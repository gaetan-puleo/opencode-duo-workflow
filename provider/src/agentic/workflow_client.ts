import WebSocket from "isomorphic-ws"
import { v4 as uuid4 } from "uuid"
import type { Logger } from "./logger"
import { WebSocketWorkflowStream } from "./websocket_stream"
type WebSocketConnectionConfig = {
  gitlabInstanceUrl: URL
  token: string
  agent?: object
  agentType?: "proxy" | "https" | "http"
  headers?: Record<string, string>
  selectedModelIdentifier?: string
}

export class WebSocketWorkflowClient {
  #logger: Logger
  #connectionDetails: WebSocketConnectionConfig
  #selectedModelIdentifier?: string
  #socket: WebSocket | null = null
  #stream: WebSocketWorkflowStream | null = null
  #correlationId = uuid4()

  constructor(logger: Logger, connectionDetails: WebSocketConnectionConfig) {
    this.#logger = logger
    this.#connectionDetails = connectionDetails
    this.#selectedModelIdentifier = connectionDetails.selectedModelIdentifier
  }

  async executeWorkflow(): Promise<WebSocketWorkflowStream> {
    const url = this.#buildWebSocketUrl()
    const headers = this.#createConnectionHeaders()

    const clientOptions: WebSocket.ClientOptions = { headers }
    if (this.#connectionDetails.agent) {
      Object.assign(clientOptions, { agent: this.#connectionDetails.agent })
    }

    this.#socket = new WebSocket(url, clientOptions)
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

  dispose(): void {
    this.#stream?.end()
    this.#stream = null
    this.#socket = null
  }

  #buildWebSocketUrl(): string {
    const baseUrl = new URL(this.#connectionDetails.gitlabInstanceUrl)
    const basePath = baseUrl.pathname.endsWith("/") ? baseUrl.pathname : `${baseUrl.pathname}/`
    const url = new URL(basePath + "api/v4/ai/duo_workflows/ws", baseUrl)
    url.protocol = baseUrl.protocol === "https:" ? "wss:" : "ws:"
    if (this.#selectedModelIdentifier) {
      url.searchParams.set("user_selected_model_identifier", this.#selectedModelIdentifier)
    }
    return url.toString()
  }

  #createConnectionHeaders(): Record<string, string> {
    const headers = { ...this.#connectionDetails.headers }
    headers["authorization"] = `Bearer ${this.#connectionDetails.token}`
    headers["x-request-id"] = this.#correlationId
    headers["x-gitlab-language-server-version"] = LANGUAGE_SERVER_VERSION
    headers["x-gitlab-client-type"] = "node-websocket"
    headers["user-agent"] = buildUserAgent()
    headers["origin"] = this.#connectionDetails.gitlabInstanceUrl.origin
    return headers
  }
}

const LANGUAGE_SERVER_VERSION = "8.62.2"

function buildUserAgent(): string {
  return `unknown/unknown unknown/unknown gitlab-language-server/${LANGUAGE_SERVER_VERSION}`
}
