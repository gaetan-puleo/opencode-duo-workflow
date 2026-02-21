import { DEFAULT_INSTANCE_URL } from "../constants"

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

export function envInstanceUrl(): string | undefined {
  return process.env.GITLAB_INSTANCE_URL ?? process.env.GITLAB_URL ?? process.env.GITLAB_BASE_URL
}

export function normalizeInstanceUrl(value: unknown): string {
  const raw = text(value) ?? DEFAULT_INSTANCE_URL
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`

  try {
    const url = new URL(withProtocol)
    return `${url.protocol}//${url.host}`
  } catch {
    return DEFAULT_INSTANCE_URL
  }
}
