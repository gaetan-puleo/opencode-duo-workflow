/**
 * A simple async queue that allows producers to push items and consumers
 * to iterate over them asynchronously.  Closing the queue signals the
 * consumer that no more items will arrive.
 */
export class AsyncQueue<T> {
  #items: T[] = []
  #resolvers: Array<(value: IteratorResult<T>) => void> = []
  #closed = false

  push(item: T): void {
    if (this.#closed) return
    const resolver = this.#resolvers.shift()
    if (resolver) {
      resolver({ value: item, done: false })
      return
    }
    this.#items.push(item)
  }

  close(): void {
    this.#closed = true
    while (this.#resolvers.length > 0) {
      const resolver = this.#resolvers.shift()
      if (resolver) resolver({ value: undefined as unknown as T, done: true })
    }
  }

  async *iterate(): AsyncGenerator<T> {
    while (true) {
      if (this.#items.length > 0) {
        yield this.#items.shift() as T
        continue
      }

      if (this.#closed) return

      const next = await new Promise<IteratorResult<T>>((resolve) => {
        this.#resolvers.push(resolve)
      })
      if (next.done) return
      yield next.value
    }
  }
}
