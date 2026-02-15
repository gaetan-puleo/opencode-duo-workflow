import WebSocket from "isomorphic-ws"
import { EventEmitter } from "events"
import type { WorkflowAction } from "./types"

const KEEPALIVE_PING_INTERVAL_MS = 45 * 1000

export class WebSocketWorkflowStream extends EventEmitter {
  #socket: WebSocket
  #keepalivePingIntervalId?: NodeJS.Timeout

  constructor(socket: WebSocket) {
    super()
    this.#socket = socket
    this.#setupEventHandlers()
  }

  #setupEventHandlers(): void {
    this.#socket.on("message", (event: WebSocket.MessageEvent | string | Buffer | ArrayBuffer | Buffer[]) => {
      try {
        const data = event && typeof event === "object" && "data" in event ? event.data : event
        let message: string
        if (typeof data === "string") {
          message = data
        } else if (Buffer.isBuffer(data)) {
          message = data.toString("utf8")
        } else if (data instanceof ArrayBuffer) {
          message = Buffer.from(data).toString("utf8")
        } else if (Array.isArray(data)) {
          message = Buffer.concat(data).toString("utf8")
        } else {
          return
        }

        if (!message || message === "undefined") {
          return
        }

        const parsed = JSON.parse(message) as WorkflowAction
        this.emit("data", parsed)
      } catch (err) {
        this.emit("error", err instanceof Error ? err : new Error(String(err)))
      }
    })

    this.#socket.on("open", () => {
      this.emit("open")
    })

    this.#socket.on("error", (event: WebSocket.ErrorEvent | Error) => {
      if (event instanceof Error) {
        this.emit("error", event)
        return
      }

      const serialized = safeStringifyErrorEvent(event)
      this.emit("error", new Error(serialized))
    })

    this.#socket.on("close", (code: number, reason: Buffer) => {
      clearInterval(this.#keepalivePingIntervalId)
      if (code === 1000) {
        this.emit("end")
        return
      }

      const reasonString = reason?.toString("utf8")
      this.emit("error", new Error(`WebSocket closed abnormally: ${code} ${reasonString || ""}`))
    })

    this.#socket.on("pong", () => {
      // keepalive acknowledged
    })

    this.#startKeepalivePingInterval()
  }

  #startKeepalivePingInterval(): void {
    this.#keepalivePingIntervalId = setInterval(() => {
      if (this.#socket.readyState !== WebSocket.OPEN) return
      const timestamp = Date.now().toString()
      this.#socket.ping(Buffer.from(timestamp), undefined, () => {})
    }, KEEPALIVE_PING_INTERVAL_MS)
  }

  write(data: unknown): boolean {
    if (this.#socket.readyState !== WebSocket.OPEN) {
      return false
    }
    this.#socket.send(JSON.stringify(data))
    return true
  }

  end(): void {
    this.#socket.close(1000)
  }
}

function safeStringifyErrorEvent(event: WebSocket.ErrorEvent): string {
  const payload = {
    type: event.type,
    message: event.message,
    error: event.error ? String(event.error) : undefined,
    target: {
      readyState: (event.target as WebSocket | undefined)?.readyState,
      url: (event.target as WebSocket | undefined)?.url,
    },
  }
  return JSON.stringify(payload)
}
