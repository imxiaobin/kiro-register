#!/usr/bin/env node

import crypto from 'node:crypto'
import http from 'node:http'
import { spawn } from 'node:child_process'

const DEFAULT_TENANT = 'consumers'
const DEFAULT_PORT = 53682
const DEFAULT_SCOPES = ['openid', 'offline_access', 'https://graph.microsoft.com/Mail.Read']
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000

function parseArgs(argv) {
  const args = {}

  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i]

    if (!item.startsWith('--')) {
      continue
    }

    const key = item.slice(2)
    const next = argv[i + 1]

    if (!next || next.startsWith('--')) {
      args[key] = 'true'
      continue
    }

    args[key] = next
    i += 1
  }

  return args
}

function printUsage() {
  console.log(`
Usage:
  node scripts/get-outlook-refresh-token.mjs --client-id <CLIENT_ID> [options]

Options:
  --client-id   Microsoft Entra app's Application (client) ID
  --tenant      Tenant segment for the authorize/token endpoints
                Default: consumers
  --port        Local callback port
                Default: 53682
  --scopes      Extra scopes, comma-separated
                Default: https://graph.microsoft.com/Mail.Read
  --no-open     Do not auto-open the browser

Before you run:
  1. Register an app in Microsoft Entra.
  2. Authentication -> Add platform -> Mobile and desktop applications.
  3. Add redirect URI: http://localhost
  4. If needed, set "Allow public client flows" to Yes.
  5. API permissions -> Microsoft Graph -> Delegated -> Mail.Read

Example:
  node scripts/get-outlook-refresh-token.mjs --client-id 00000000-0000-0000-0000-000000000000
`)
}

function toBase64Url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

function createPkcePair() {
  const verifier = toBase64Url(crypto.randomBytes(64))
  const challenge = toBase64Url(crypto.createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

function openBrowser(url) {
  const platform = process.platform

  if (platform === 'darwin') {
    spawn('open', [url], { stdio: 'ignore', detached: true }).unref()
    return
  }

  if (platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref()
    return
  }

  spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref()
}

function buildAuthorizeUrl({ tenant, clientId, redirectUri, scopes, challenge, state }) {
  const url = new URL(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`)
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('response_mode', 'query')
  url.searchParams.set('scope', scopes.join(' '))
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', state)
  return url
}

async function exchangeCodeForToken({ tenant, clientId, redirectUri, code, verifier }) {
  const body = new URLSearchParams()
  body.set('client_id', clientId)
  body.set('grant_type', 'authorization_code')
  body.set('code', code)
  body.set('redirect_uri', redirectUri)
  body.set('code_verifier', verifier)

  const response = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: body.toString()
  })

  const payload = await response.json().catch(() => ({}))

  if (!response.ok) {
    const message = payload.error_description || payload.error || `HTTP ${response.status}`
    throw new Error(message)
  }

  return payload
}

async function fetchProfile(accessToken) {
  const response = await fetch('https://graph.microsoft.com/v1.0/me?$select=displayName,mail,userPrincipalName', {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  })

  if (!response.ok) {
    return null
  }

  return response.json()
}

function waitForCallback({ port, expectedState, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', `http://localhost:${port}`)
      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')
      const error = url.searchParams.get('error')
      const errorDescription = url.searchParams.get('error_description')

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(`
<!doctype html>
<html>
  <body style="font-family: sans-serif; padding: 24px;">
    <h2>Authorization received</h2>
    <p>You can close this window and return to the terminal.</p>
  </body>
</html>
`)

      clearTimeout(timer)
      server.close()

      if (error) {
        reject(new Error(errorDescription || error))
        return
      }

      if (!code) {
        reject(new Error('No authorization code received.'))
        return
      }

      if (state !== expectedState) {
        reject(new Error('State mismatch.'))
        return
      }

      resolve(code)
    })

    server.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })

    server.listen(port, () => {
      console.log(`Listening for OAuth callback on http://localhost:${port}`)
    })

    const timer = setTimeout(() => {
      server.close()
      reject(new Error('Timed out waiting for the browser callback.'))
    }, timeoutMs)
  })
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const clientId = args['client-id']

  if (!clientId || args.help === 'true') {
    printUsage()
    process.exit(clientId ? 0 : 1)
  }

  const tenant = args.tenant || DEFAULT_TENANT
  const port = Number(args.port || DEFAULT_PORT)
  const extraScopes = args.scopes
    ? args.scopes.split(',').map((item) => item.trim()).filter(Boolean)
    : ['https://graph.microsoft.com/Mail.Read']
  const scopes = Array.from(new Set(['openid', 'offline_access', ...extraScopes]))
  const redirectUri = `http://localhost:${port}`
  const state = crypto.randomUUID()
  const { verifier, challenge } = createPkcePair()

  const authorizeUrl = buildAuthorizeUrl({
    tenant,
    clientId,
    redirectUri,
    scopes,
    challenge,
    state
  })

  console.log('Tenant      :', tenant)
  console.log('Client ID   :', clientId)
  console.log('Redirect URI:', redirectUri)
  console.log('Scopes      :', scopes.join(' '))
  console.log('')
  console.log('Open the following URL in a browser and sign in with your Outlook account:')
  console.log(authorizeUrl.toString())
  console.log('')

  if (args['no-open'] !== 'true') {
    try {
      openBrowser(authorizeUrl.toString())
      console.log('Attempted to open your default browser.')
    } catch (error) {
      console.log(`Browser auto-open failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const code = await waitForCallback({
    port,
    expectedState: state,
    timeoutMs: CALLBACK_TIMEOUT_MS
  })

  console.log('Authorization code received, exchanging for tokens...')

  const tokenResult = await exchangeCodeForToken({
    tenant,
    clientId,
    redirectUri,
    code,
    verifier
  })

  const profile = tokenResult.access_token
    ? await fetchProfile(tokenResult.access_token)
    : null

  console.log('')
  console.log('Success')
  console.log('client_id     :', clientId)
  console.log('refresh_token :', tokenResult.refresh_token || '')
  console.log('expires_in    :', tokenResult.expires_in || '')
  console.log('scope         :', tokenResult.scope || scopes.join(' '))

  if (profile) {
    console.log('mail          :', profile.mail || profile.userPrincipalName || '')
    console.log('display_name  :', profile.displayName || '')
  }

  console.log('')
  console.log('Paste into this project as:')
  console.log(`${tokenResult.refresh_token || ''}|${clientId}`)
}

main().catch((error) => {
  console.error('')
  console.error('Failed:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
