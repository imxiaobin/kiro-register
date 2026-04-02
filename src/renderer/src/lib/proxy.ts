export type ProxyProtocol = 'http' | 'socks5'

function encodeCredential(value: string): string {
  return encodeURIComponent(value)
}

export function inferProxyProtocol(input: string): ProxyProtocol {
  const trimmed = input.trim().toLowerCase()
  if (trimmed.startsWith('socks5://')) {
    return 'socks5'
  }

  return 'http'
}

export function normalizeProxyInput(input: string, protocol: ProxyProtocol): string {
  const trimmed = input.trim()
  if (!trimmed) {
    return ''
  }

  if (trimmed.includes('://')) {
    return trimmed
  }

  const authMatch = trimmed.match(/^([^:\s]+):(\d+):([^:\s]+):(.+)$/)
  if (authMatch) {
    const [, host, port, username, password] = authMatch
    return `${protocol}://${encodeCredential(username)}:${encodeCredential(password)}@${host}:${port}`
  }

  const hostPortMatch = trimmed.match(/^([^:\s]+):(\d+)$/)
  if (hostPortMatch) {
    const [, host, port] = hostPortMatch
    return `${protocol}://${host}:${port}`
  }

  return trimmed
}
