/**
 * A simple async queue that allows producers to push values
 * and consumers to await the next available value.
 *
 * Supports closing: after close(), shift() returns null for any
 * pending or future consumers, and push() is ignored.
 */
export class AsyncQueue<T> {
  #values: T[] = []
  #waiters: Array<(value: T | null) => void> = []
  #closed = false

  push(value: T): void {
    if (this.#closed) return
    const waiter = this.#waiters.shift()
    if (waiter) {
      waiter(value)
      return
    }
    this.#values.push(value)
  }

  /** Returns null when closed and no buffered values remain. */
  shift(): Promise<T | null> {
    const value = this.#values.shift()
    if (value !== undefined) return Promise.resolve(value)
    if (this.#closed) return Promise.resolve(null)
    return new Promise<T | null>((resolve) => this.#waiters.push(resolve))
  }

  close(): void {
    this.#closed = true
    for (const waiter of this.#waiters) {
      waiter(null)
    }
    this.#waiters = []
  }
}
