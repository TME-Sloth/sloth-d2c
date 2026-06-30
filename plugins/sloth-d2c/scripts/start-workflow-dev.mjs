#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { existsSync, promises as fs } from 'node:fs'
import os from 'node:os'
import { createServer } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[i + 1]
    if (!next || next.startsWith('--')) {
      args[key] = true
    } else {
      args[key] = next
      i += 1
    }
  }
  return args
}

function repoRoot() {
  const scriptPath = fileURLToPath(import.meta.url)
  return path.resolve(path.dirname(scriptPath), '../../..')
}

function cleanPart(value, fallback = 'root') {
  return String(value || fallback).replace(/[^a-zA-Z0-9\u4e00-\u9fff\u3400-\u4dbf-_]/g, '_')
}

function hasArg(args, key) {
  return Object.prototype.hasOwnProperty.call(args, key)
}

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.listen(Number(port), () => {
      server.close(() => resolve(true))
    })
  })
}

async function resolvePort({ name, requestedPort, shouldListen, explicit, maxAttempts = 20 }) {
  const startPort = Number(requestedPort)
  if (!Number.isInteger(startPort) || startPort <= 0) {
    throw new Error(`[sloth-d2c] Invalid ${name} port: ${requestedPort}`)
  }

  if (!shouldListen) return String(startPort)

  if (explicit) {
    if (await isPortAvailable(startPort)) return String(startPort)
    throw new Error(`[sloth-d2c] ${name} port ${startPort} is already in use. Pick another port or omit the flag to auto-select.`)
  }

  for (let port = startPort; port < startPort + maxAttempts; port += 1) {
    if (await isPortAvailable(port)) return String(port)
  }
  throw new Error(`[sloth-d2c] No available ${name} port found in range ${startPort}-${startPort + maxAttempts - 1}`)
}

function legacyGlobalFilesRoot() {
  if (process.env.SLOTH_D2C_GLOBAL_CACHE_DIR) {
    return path.resolve(process.env.SLOTH_D2C_GLOBAL_CACHE_DIR)
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library/Application Support/d2c-mcp-nodejs/files')
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData/Roaming'), 'd2c-mcp-nodejs/files')
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share'), 'd2c-mcp-nodejs/files')
}

async function copyIfExists(sourcePath, targetPath, { overwrite = false } = {}) {
  if (!existsSync(sourcePath)) return false
  if (!overwrite && existsSync(targetPath)) return false
  await fs.mkdir(path.dirname(targetPath), { recursive: true })
  await fs.cp(sourcePath, targetPath, { recursive: true, force: overwrite })
  return true
}

async function syncLegacyDesignCache({ workspace, fileKey, nodeId, overwrite = false }) {
  if (!fileKey) return { skipped: true, reason: 'missing-file-key', copied: [] }

  const cleanFileKey = cleanPart(fileKey, 'file')
  const cleanNodeId = cleanPart(nodeId, 'root')
  const sourceDir = path.join(legacyGlobalFilesRoot(), cleanFileKey, cleanNodeId)
  const targetDir = path.join(workspace, '.sloth', cleanFileKey, cleanNodeId)
  const copied = []

  if (!existsSync(sourceDir)) {
    return { skipped: true, reason: 'source-not-found', sourceDir, targetDir, copied }
  }

  const filenames = [
    'nodeList.json',
    'imageMap.json',
    'absolute.html',
    'groupsData.json',
    'moduleData.json',
    'promptSetting.json',
    'configSetting.json',
  ]

  for (const filename of filenames) {
    const didCopy = await copyIfExists(path.join(sourceDir, filename), path.join(targetDir, filename), { overwrite })
    if (didCopy) copied.push(filename)
  }

  const didCopyScreenshots = await copyIfExists(path.join(sourceDir, 'screenshots'), path.join(targetDir, 'screenshots'), { overwrite })
  if (didCopyScreenshots) copied.push('screenshots/')

  return { skipped: false, sourceDir, targetDir, copied }
}

function spawnService(name, command, args, options) {
  const child = spawn(command, args, {
    ...options,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  child.on('exit', (code, signal) => {
    if (stopping) return
    console.error(`[sloth-d2c:${name}] exited (${signal || code})`)
    stopAll(code || 1)
  })
  children.push(child)
  return child
}

function stopAll(code = 0) {
  stopping = true
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM')
  }
  setTimeout(() => process.exit(code), 200)
}

const args = parseArgs(process.argv.slice(2))
const slothRepo = path.resolve(String(args['sloth-repo'] || repoRoot()))
const workspace = path.resolve(String(args.workspace || process.cwd()))
const only = String(args.only || 'all')
const shouldSyncCache = only === 'all' || only === 'sync-cache'
const shouldStartMcp = only === 'all' || only === 'mcp'
const shouldStartWeb = only === 'all' || only === 'web'
const mcpPort = await resolvePort({
  name: 'MCP',
  requestedPort: args['mcp-port'] || process.env.SLOTH_MCP_PORT || 3100,
  shouldListen: shouldStartMcp,
  explicit: hasArg(args, 'mcp-port') || Boolean(process.env.SLOTH_MCP_PORT),
})
const webPort = await resolvePort({
  name: 'interceptor web',
  requestedPort: args['web-port'] || 5173,
  shouldListen: shouldStartWeb,
  explicit: hasArg(args, 'web-port'),
})
const webHost = String(args['web-host'] || '127.0.0.1')
const mcpTarget = `http://127.0.0.1:${mcpPort}`

const children = []
let stopping = false

console.log('[sloth-d2c] starting dev workflow')
console.log(`[sloth-d2c] sloth repo: ${slothRepo}`)
console.log(`[sloth-d2c] target workspace: ${workspace}`)
console.log(`[sloth-d2c] mcp: ${mcpTarget}`)
console.log(`[sloth-d2c] interceptor: http://${webHost}:${webPort}/auth-page?...`)

if (shouldSyncCache) {
  const syncResult = await syncLegacyDesignCache({
    workspace,
    fileKey: args['file-key'],
    nodeId: args['node-id'],
    overwrite: Boolean(args['overwrite-cache']),
  })
  if (syncResult.skipped) {
    console.log(`[sloth-d2c] cache sync skipped: ${syncResult.reason}`)
  } else {
    console.log(`[sloth-d2c] cache sync source: ${syncResult.sourceDir}`)
    console.log(`[sloth-d2c] cache sync target: ${syncResult.targetDir}`)
    console.log(`[sloth-d2c] cache sync copied: ${syncResult.copied.length ? syncResult.copied.join(', ') : 'nothing'}`)
  }
}

if (only === 'sync-cache') {
  process.exit(0)
}

if (shouldStartMcp) {
  spawnService(
    'mcp',
    process.execPath,
    [path.join(slothRepo, 'apps/d2c-mcp/cli/run.js'), '--server', '--dev'],
    {
      cwd: slothRepo,
      env: {
        ...process.env,
        SLOTH_WORKSPACE_ROOT: workspace,
        SLOTH_MCP_PORT: mcpPort,
      },
    },
  )
}

if (shouldStartWeb) {
  const interceptorDir = path.join(slothRepo, 'apps/interceptor-web')
  const viteBin = path.join(interceptorDir, 'node_modules/.bin/vite')
  const hasLocalVite = existsSync(viteBin)
  spawnService(
    'web',
    hasLocalVite ? viteBin : 'pnpm',
    hasLocalVite
      ? ['--host', webHost, '--port', webPort]
      : ['--dir', interceptorDir, 'exec', 'vite', '--host', webHost, '--port', webPort],
    {
      cwd: interceptorDir,
      env: {
        ...process.env,
        CI: process.env.CI || 'true',
        SLOTH_D2C_MCP_TARGET: mcpTarget,
      },
    },
  )
}

process.on('SIGINT', () => stopAll(0))
process.on('SIGTERM', () => stopAll(0))
