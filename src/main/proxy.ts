export interface ProxyConfig {
  original: string
  protocol: string
  host: string
  port: string
  server: string
  proxyRules: string
  envUrl: string
  username?: string
  password?: string
}

const SUPPORTED_PROTOCOLS = new Set(['http', 'https', 'socks5'])

function encodeCredential(value: string): string {
  return encodeURIComponent(value)
}

function buildEnvUrl(protocol: string, host: string, port: string, username?: string, password?: string): string {
  const authPart = username
    ? `${encodeCredential(username)}:${encodeCredential(password || '')}@`
    : ''
  return `${protocol}://${authPart}${host}:${port}`
}

function parseProxyUrl(input: string): ProxyConfig {
  let parsed: URL

  try {
    parsed = new URL(input)
  } catch {
    throw new Error('代理地址格式无效')
  }

  const protocol = parsed.protocol.replace(/:$/, '').toLowerCase()
  if (!SUPPORTED_PROTOCOLS.has(protocol)) {
    throw new Error(`不支持的代理协议: ${protocol}`)
  }

  if (!parsed.hostname || !parsed.port) {
    throw new Error('代理地址必须包含主机和端口')
  }

  const username = parsed.username ? decodeURIComponent(parsed.username) : undefined
  const password = parsed.password ? decodeURIComponent(parsed.password) : undefined

  return {
    original: input,
    protocol,
    host: parsed.hostname,
    port: parsed.port,
    server: `${protocol}://${parsed.hostname}:${parsed.port}`,
    proxyRules: `${protocol}://${parsed.hostname}:${parsed.port}`,
    envUrl: buildEnvUrl(protocol, parsed.hostname, parsed.port, username, password),
    username,
    password
  }
}

function parseHostPortUserPass(input: string): ProxyConfig {
  const match = input.match(/^([^:\s]+):(\d+):([^:\s]+):(.+)$/)
  if (!match) {
    throw new Error('代理地址格式无效')
  }

  const [, host, port, username, password] = match
  const protocol = 'socks5'

  return {
    original: input,
    protocol,
    host,
    port,
    server: `${protocol}://${host}:${port}`,
    proxyRules: `${protocol}://${host}:${port}`,
    envUrl: buildEnvUrl(protocol, host, port, username, password),
    username,
    password
  }
}

export function parseProxyConfig(input: string): ProxyConfig {
  const trimmed = input.trim()
  if (!trimmed) {
    throw new Error('代理地址不能为空')
  }

  if (trimmed.includes('://')) {
    return parseProxyUrl(trimmed)
  }

  if (/^[^:\s]+:\d+:[^:\s]+:.+$/.test(trimmed)) {
    return parseHostPortUserPass(trimmed)
  }

  throw new Error('仅支持 protocol://host:port、protocol://user:pass@host:port 或 host:port:user:pass')
}
