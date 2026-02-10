import WebSocket from "isomorphic-ws"
import { EventEmitter } from "events"
import type { Logger } from "./logger"
import type { WorkflowAction } from "./types"

const KEEPALIVE_PING_INTERVAL_MS = 45 * 1000

export class WebSocketWorkflowStream extends EventEmitter {
  #socket: WebSocket
  #logger: Logger
  #keepalivePingIntervalId?: NodeJS.Timeout

  constructor(socket: WebSocket, logger: Logger) {
    super()
    this.#socket = socket
    this.#logger = logger
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
          this.#logger.warn("Received unknown message format")
          return
        }

        if (!message || message === "undefined") {
          this.#logger.warn("Received empty or undefined message, skipping")
          return
        }

        const parsed = JSON.parse(message) as WorkflowAction
        this.emit("data", parsed)
      } catch (err) {
        this.#logger.error("Failed to parse WebSocket message", err)
        this.emit("error", err instanceof Error ? err : new Error(String(err)))
      }
    })

    this.#socket.on("open", () => {
      this.#logger.debug("WebSocket connection opened")
      this.emit("open")
    })

    this.#socket.on("error", (event: WebSocket.ErrorEvent | Error) => {
      this.#logger.error("WebSocket error:", event)
      this.emit("error", event instanceof Error ? event : new Error(String(event)))
    })

    this.#socket.on("close", (code: number, reason: Buffer) => {
      clearInterval(this.#keepalivePingIntervalId)
      const reasonString = reason?.toString("utf8")
      this.#logger.debug(`WebSocket connection closed: ${JSON.stringify({ code, reason: reasonString })}`)
      if (code === 1000) {
        this.emit("end")
        return
      }

      this.emit("error", new Error(`WebSocket closed abnormally: ${code} ${reasonString || ""}`))
    })

    this.#socket.on("pong", (data: Buffer) => {
      try {
        const pingTime = parseInt(data.toString(), 10)
        const rtt = `${Date.now() - pingTime}ms`
        this.#logger.debug(`WebSocket keepalive pong: ${rtt}`)
      } catch (err) {
        this.#logger.debug("Failed to parse keepalive pong", err)
      }
    })

    this.#startKeepalivePingInterval()
  }

  #startKeepalivePingInterval(): void {
    this.#keepalivePingIntervalId = setInterval(() => {
      if (this.#socket.readyState !== WebSocket.OPEN) return
      const timestamp = Date.now().toString()
      this.#socket.ping(Buffer.from(timestamp), undefined, (err) => {
        if (err) {
          this.#logger.error("Keepalive ping failed:", err)
        }
      })
    }, KEEPALIVE_PING_INTERVAL_MS)
  }

  write(data: unknown): boolean {
    if (this.#socket.readyState !== WebSocket.OPEN) {
      this.#logger.error(`Attempting to write when socket not open: ${this.#socket.readyState}`)
      return false
    }
    this.#socket.send(JSON.stringify(data))
    return true
  }

  end(): void {
    this.#socket.close(1000)
  }
}
