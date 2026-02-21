export type GitLabClientOptions = {
  instanceUrl: string
  token: string
}

export class GitLabApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = "GitLabApiError"
  }
}

async function request(options: GitLabClientOptions, path: string, init: RequestInit): Promise<Response> {
  const url = `${options.instanceUrl}/api/v4/${path}`
  const headers = new Headers(init.headers)
  headers.set("authorization", `Bearer ${options.token}`)
  const response = await fetch(url, {
    ...init,
    headers,
  })

  return response
}

export async function get<T>(options: GitLabClientOptions, path: string): Promise<T> {
  const response = await request(options, path, { method: "GET" })

  if (!response.ok) {
    const text = await response.text().catch(() => "")
    throw new GitLabApiError(response.status, `GET ${path} failed (${response.status}): ${text}`)
  }

  return response.json() as Promise<T>
}

export async function post<T>(
  options: GitLabClientOptions,
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const response = await request(options, path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => "")
    throw new GitLabApiError(response.status, `POST ${path} failed (${response.status}): ${text}`)
  }

  return response.json() as Promise<T>
}

export async function graphql<T>(options: GitLabClientOptions, query: string, variables: Record<string, unknown>): Promise<T> {
  const url = `${options.instanceUrl}/api/graphql`
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${options.token}`,
    },
    body: JSON.stringify({ query, variables }),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => "")
    throw new GitLabApiError(response.status, `GraphQL request failed (${response.status}): ${text}`)
  }

  const result = (await response.json()) as { data?: T; errors?: Array<{ message: string }> }

  if (result.errors?.length) {
    throw new GitLabApiError(0, result.errors.map((e) => e.message).join("; "))
  }

  if (!result.data) {
    throw new GitLabApiError(0, "GraphQL response missing data")
  }

  return result.data
}
