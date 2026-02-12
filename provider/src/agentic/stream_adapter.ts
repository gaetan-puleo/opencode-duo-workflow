import { createRequire } from "node:module"

type ReadableStreamConstructor = typeof ReadableStream

function resolveReadableStream(): ReadableStreamConstructor {
  if (typeof ReadableStream !== "undefined") {
    return ReadableStream
  }
  const require = createRequire(import.meta.url)
  const web = require("node:stream/web") as { ReadableStream: ReadableStreamConstructor }
  return web.ReadableStream
}

export function asyncIteratorToReadableStream<T>(iter: AsyncIterable<T>): ReadableStream<T> {
  const iterator = iter[Symbol.asyncIterator]()
  const Readable = resolveReadableStream()

  return new Readable({
    async pull(controller) {
      try {
        const { value, done } = await iterator.next()
        if (done) {
          controller.close()
          return
        }
        controller.enqueue(value)
      } catch (error) {
        controller.error(error)
      }
    },
    async cancel() {
      if (iterator.return) {
        await iterator.return()
      }
    },
  })
}
