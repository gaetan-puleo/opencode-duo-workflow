import WebSocket from "isomorphic-ws"
import {
  WORKFLOW_CONNECT_TIMEOUT_MS,
  WORKFLOW_HEARTBEAT_INTERVAL_MS,
  WORKFLOW_KEEPALIVE_INTERVAL_MS,
} from "../constants"
import type { ClientEvent, WorkflowAction } from "./types"

type SocketCallbacks = {
  action: (action: WorkflowAction) => void
  error: (error: Error) => void
  close: (code: number, reason: string) => void
}

export class WorkflowWebSocketClient {
  #socket: WebSocket | null = null
  #heartbeat: NodeJS.Timeout | undefined
  #keepalive: NodeJS.Timeout | undefined
  #callbacks: SocketCallbacks

  constructor(callbacks: SocketCallbacks) {
    this.#callbacks = callbacks
  }

  async connect(url: string, headers: Record<string, string>): Promise<void> {
    const socket = new WebSocket(url, { headers })
    this.#socket = socket

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup()
        socket.close(1000)
        reject(new Error(`WebSocket connection timeout after ${WORKFLOW_CONNECT_TIMEOUT_MS}ms`))
      }, WORKFLOW_CONNECT_TIMEOUT_MS)

      const cleanup = () => {
        clearTimeout(timeout)
        socket.off("open", onOpen)
        socket.off("error", onError)
      }

      const onOpen = () => {
        cleanup()
        resolve()
      }

      const onError = (error: Error) => {
        cleanup()
        reject(error)
      }

      socket.once("open", onOpen)
      socket.once("error", onError)
    })

    socket.on("message", (data: WebSocket.Data) => {
      try {
        const payload = decodeSocketMessage(data)
        if (!payload) return
        const parsed = JSON.parse(payload) as WorkflowAction
        this.#callbacks.action(parsed)
      } catch (error) {
        const next = error instanceof Error ? error : new Error(String(error))
        this.#callbacks.error(next)
      }
    })

    socket.on("error", (error: unknown) => {
      this.#callbacks.error(error instanceof Error ? error : new Error(String(error)))
    })

    socket.on("close", (code: number, reason: Buffer) => {
      this.#stopIntervals()
      this.#callbacks.close(code, reason?.toString("utf8") ?? "")
    })

    this.#heartbeat = setInterval(() => {
      this.send({ heartbeat: { timestamp: Date.now() } })
    }, WORKFLOW_HEARTBEAT_INTERVAL_MS)

    this.#keepalive = setInterval(() => {
      if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN) return
      this.#socket.ping(Buffer.from(String(Date.now())))
    }, WORKFLOW_KEEPALIVE_INTERVAL_MS)
  }

  send(event: ClientEvent): boolean {
    if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN) return false
    this.#socket.send(JSON.stringify(event))
    return true
  }

  close(): void {
    this.#stopIntervals()
    if (!this.#socket) return
    this.#socket.close(1000)
    this.#socket = null
  }

  #stopIntervals(): void {
    if (this.#heartbeat) {
      clearInterval(this.#heartbeat)
      this.#heartbeat = undefined
    }
    if (this.#keepalive) {
      clearInterval(this.#keepalive)
      this.#keepalive = undefined
    }
  }
}

function decodeSocketMessage(data: WebSocket.Data): string | undefined {
  if (typeof data === "string") return data
  if (Buffer.isBuffer(data)) return data.toString("utf8")
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8")
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8")
  return undefined
}
