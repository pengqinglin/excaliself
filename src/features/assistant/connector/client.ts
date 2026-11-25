export class ConnectorError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "ConnectorError"
  }
}

export interface ToolClient {
  call<T>(
    name: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T>
}

/** Small Streamable HTTP client; credentials never enter state files or argv. */
export class AssistantMcpClient implements ToolClient {
  private nextId = 1
  private protocolVersion = "2025-11-25"
  private sessionId: string | null = null
  private connected = false
  constructor(
    private readonly endpoint: string,
    private readonly token: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly timeoutMs = 25_000,
  ) {
    const url = new URL(endpoint)
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error(
        "Use an HTTP(S) MCP endpoint without credentials or query parameters",
      )
    if (!token || /\s/.test(token))
      throw new Error("EXCALISELF_TOKEN is missing or invalid")
  }

  async connect(signal?: AbortSignal) {
    const initialized = await this.request<{ protocolVersion: string }>(
      "initialize",
      {
        protocolVersion: this.protocolVersion,
        capabilities: {},
        clientInfo: { name: "excaliself-codex", version: "1.0.0" },
      },
      signal,
    )
    this.protocolVersion = initialized.protocolVersion
    this.connected = true
  }

  private async request<T>(
    method: string,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const id = this.nextId++
    const response = await this.fetcher(this.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${this.token}`,
        "mcp-protocol-version": this.protocolVersion,
        ...(this.sessionId && { "mcp-session-id": this.sessionId }),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)])
        : AbortSignal.timeout(this.timeoutMs),
    })
    if (response.status === 401 || response.status === 403)
      throw new ConnectorError(
        "credential_revoked",
        "The Excaliself credential was rejected",
      )
    if (!response.ok)
      throw new ConnectorError(
        "connection_error",
        `MCP returned HTTP ${response.status}`,
      )
    const sessionId = response.headers.get("mcp-session-id")
    if (sessionId) this.sessionId = sessionId
    const text = await response.text()
    if (text.length > 48 * 1024 * 1024)
      throw new ConnectorError(
        "response_too_large",
        "MCP response exceeds the connector limit",
      )
    const messages: { id?: number; result?: T; error?: unknown }[] =
      response.headers.get("content-type")?.includes("text/event-stream")
        ? text
            .replace(/\r\n/g, "\n")
            .split("\n\n")
            .flatMap((event) => {
              const data = event
                .split("\n")
                .filter((line) => line.startsWith("data:"))
                .map((line) => line.slice(5).trimStart())
                .join("\n")
              return data ? [JSON.parse(data)] : []
            })
        : [JSON.parse(text)]
    const message = messages.find((item) => item.id === id)
    if (!message || message.error || !("result" in message))
      throw new ConnectorError(
        "protocol_error",
        "MCP returned an invalid response",
      )
    return message.result as T
  }

  async call<T>(
    name: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (!this.connected) await this.connect(signal)
    let result: {
      isError?: boolean
      content: { type: string; text?: string }[]
    }
    try {
      result = await this.request(
        "tools/call",
        { name, arguments: input },
        signal,
      )
    } catch (error) {
      this.connected = false
      this.sessionId = null
      throw error
    }
    const text = result.content.find((item) => item.type === "text")?.text
    if (!text)
      throw new ConnectorError(
        "protocol_error",
        "The tool returned no JSON content",
      )
    const data = JSON.parse(text)
    if (result.isError || data?.error)
      throw new ConnectorError(
        data?.error?.code ?? "tool_error",
        data?.error?.message ?? "The tool request failed",
      )
    return data as T
  }
}
