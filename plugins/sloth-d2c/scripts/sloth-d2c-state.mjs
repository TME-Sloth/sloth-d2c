#!/usr/bin/env node
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

function parseArgs(argv) {
  const [command, ...rest] = argv
  const args = { _: [] }
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i]
    if (!token.startsWith('--')) {
      args._.push(token)
      continue
    }
    const key = token.slice(2)
    const next = rest[i + 1]
    if (!next || next.startsWith('--')) {
      args[key] = true
    } else {
      args[key] = next
      i += 1
    }
  }
  return { command, args }
}

function workspaceOf(args) {
  return path.resolve(String(args.workspace || process.cwd()))
}

function requireArg(args, key) {
  const value = args[key]
  if (!value || value === true) throw new Error(`Missing required --${key}`)
  return String(value)
}

function optionalList(args, key) {
  const value = args[key]
  if (!value || value === true) return []
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function optionalNumberList(args, key) {
  return optionalList(args, key)
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item) && item > 0)
}

function cleanPart(value, fallback = 'root') {
  return String(value || fallback).replace(/[^a-zA-Z0-9\u4e00-\u9fff\u3400-\u4dbf-_]/g, '_')
}

function sessionId(fileKey, nodeId) {
  return `${cleanPart(fileKey, 'file')}_${cleanPart(nodeId, 'root')}`
}

function sessionDir(workspace, fileKey, nodeId) {
  return path.join(d2cDir(workspace, fileKey, nodeId), 'session')
}

function legacySessionDir(workspace, fileKey, nodeId) {
  return path.join(workspace, '.sloth', 'sessions', sessionId(fileKey, nodeId))
}

function d2cDir(workspace, fileKey, nodeId) {
  return path.join(workspace, '.sloth', cleanPart(fileKey, 'file'), cleanPart(nodeId, 'root'))
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback
    throw error
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function readJsonl(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf8')
    return content
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

async function copyDirIfMissing(source, target) {
  if (await pathExists(target)) return false
  if (!(await pathExists(source))) return false
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.cp(source, target, { recursive: true, force: false, errorOnExist: false })
  return true
}

async function ensureSessionStorage(workspace, fileKey, nodeId) {
  return copyDirIfMissing(legacySessionDir(workspace, fileKey, nodeId), sessionDir(workspace, fileKey, nodeId))
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function scriptPath() {
  return path.resolve(import.meta.filename || process.argv[1])
}

function commandString(parts) {
  return parts.map((part) => shellQuote(part)).join(' ')
}

function normalizeUrl(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  if (/^https?:\/\//i.test(raw)) return raw
  return `http://${raw}`
}

function extractTitle(html) {
  const match = String(html || '').match(/<title[^>]*>([^<]*)<\/title>/i)
  return match ? match[1].trim() : ''
}

async function probeImplementationUrl(url, timeoutMs = 1500) {
  const targetUrl = normalizeUrl(url)
  if (!targetUrl) {
    return { url: targetUrl, reachable: false, error: 'empty url' }
  }
  try {
    const response = await fetch(targetUrl, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    })
    const contentType = response.headers.get('content-type') || ''
    const text = await response.text().catch(() => '')
    return {
      url: targetUrl,
      reachable: response.ok,
      status: response.status,
      contentType,
      title: extractTitle(text),
      bytes: text.length,
    }
  } catch (error) {
    return {
      url: targetUrl,
      reachable: false,
      error: error?.message || String(error),
    }
  }
}

function implementationUrlCandidates(args, state) {
  const explicitUrls = optionalList(args, 'url').map(normalizeUrl)
  if (explicitUrls.length) return explicitUrls

  const hosts = optionalList(args, 'hosts')
  const hostList = hosts.length ? hosts : ['127.0.0.1', 'localhost']
  const ports = optionalNumberList(args, 'ports')
  const portList = ports.length ? ports : [3000, 3001, 4173, 4200, 5000, 8000, 8080, 5174, 5175]
  const pathValue = args.path && args.path !== true ? String(args.path) : '/'
  const route = pathValue.startsWith('/') ? pathValue : `/${pathValue}`
  const candidates = []
  if (state?.implementationUrl) candidates.push(normalizeUrl(state.implementationUrl))
  for (const host of hostList) {
    for (const port of portList) {
      candidates.push(`http://${host}:${port}${route}`)
    }
  }
  return Array.from(new Set(candidates.filter(Boolean)))
}

function defaultSeedGroups(width, height) {
  const safeWidth = Math.max(1, Number(width) || 780)
  const safeHeight = Math.max(1, Number(height) || 1688)
  return [
    {
      groupIndex: 0,
      elements: ['seed-nav'],
      rect: { left: 0, top: 0, width: safeWidth, height: Math.round(safeHeight * 0.13) },
      label: '顶部导航',
    },
    {
      groupIndex: 1,
      elements: ['seed-profile'],
      rect: { left: Math.round(safeWidth * 0.05), top: Math.round(safeHeight * 0.18), width: Math.round(safeWidth * 0.9), height: Math.round(safeHeight * 0.15) },
      label: '个人资料卡片',
    },
    {
      groupIndex: 2,
      elements: ['seed-content'],
      rect: { left: Math.round(safeWidth * 0.05), top: Math.round(safeHeight * 0.35), width: Math.round(safeWidth * 0.9), height: Math.round(safeHeight * 0.45) },
      label: '内容列表',
    },
  ]
}

function screenshotBackedHtml({ dataUrl, width, height, fileKey, nodeId, sourceUrl }) {
  const groups = defaultSeedGroups(width, height)
  const overlays = groups
    .map((group) => {
      const id = group.elements[0]
      const rect = group.rect
      return `<div data-id="${id}" data-name="${group.label}" data-type="CONTAINER" style="position:absolute;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;background:rgba(0,0,0,0);"></div>`
    })
    .join('\n')
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>sloth d2c seed ${fileKey}/${nodeId || 'root'}</title>
  </head>
  <body style="margin:0;background:#f1f5f7;">
    <div data-id="seed-root" data-name="Figma MCP Seed" data-source="${sourceUrl || ''}" style="position:relative;width:${width}px;height:${height}px;overflow:hidden;">
      <img data-id="seed-screenshot" data-name="Figma Screenshot" src="${dataUrl}" style="position:absolute;left:0;top:0;width:${width}px;height:${height}px;display:block;" />
      ${overlays}
    </div>
  </body>
</html>
`
}

async function appendEvent(workspace, fileKey, nodeId, event) {
  await ensureSessionStorage(workspace, fileKey, nodeId)
  await fs.mkdir(sessionDir(workspace, fileKey, nodeId), { recursive: true })
  await fs.appendFile(path.join(sessionDir(workspace, fileKey, nodeId), 'events.jsonl'), `${JSON.stringify(event)}\n`, 'utf8')
}

async function seedFigmaSession(workspace, args) {
  const fileKey = requireArg(args, 'file-key')
  const nodeId = args['node-id'] ? String(args['node-id']) : undefined
  const screenshotUrl = requireArg(args, 'screenshot-url')
  const width = Number(args.width || 780)
  const height = Number(args.height || 1688)
  const note = args.note ? String(args.note) : 'Seeded from Codex Figma MCP screenshot because the local Sloth Figma API token could not access the file.'
  const response = await fetch(screenshotUrl)
  if (!response.ok) {
    throw new Error(`Cannot download screenshot: HTTP ${response.status}`)
  }
  const imageBytes = Buffer.from(await response.arrayBuffer())
  const dataUrl = `data:image/png;base64,${imageBytes.toString('base64')}`
  const groupsData = defaultSeedGroups(width, height)
  const targetD2cDir = d2cDir(workspace, fileKey, nodeId)
  const targetSessionDir = sessionDir(workspace, fileKey, nodeId)
  const now = new Date().toISOString()
  const snapshot = {
    snapshotId: 'v0001',
    version: 1,
    fileKey,
    nodeId,
    groupsData,
    createdAt: now,
    source: {
      kind: 'figma-mcp-screenshot-seed',
      screenshotUrl,
      note,
    },
  }
  const state = {
    sessionId: sessionId(fileKey, nodeId),
    fileKey,
    nodeId,
    currentVersion: 1,
    createdAt: now,
    updatedAt: now,
    latestSnapshotId: 'v0001',
    agents: {},
    seedSource: snapshot.source,
  }
  const event = {
    id: `evt_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    sessionId: sessionId(fileKey, nodeId),
    version: 1,
    snapshotId: 'v0001',
    type: 'workflow.seeded',
    source: 'agent',
    payload: {
      summary: note,
      screenshot: 'screenshots/index.png',
      groups: groupsData.length,
    },
    createdAt: now,
  }

  await fs.mkdir(path.join(targetD2cDir, 'screenshots'), { recursive: true })
  await fs.mkdir(path.join(targetD2cDir, 'chunks'), { recursive: true })
  await fs.mkdir(path.join(targetSessionDir, 'snapshots'), { recursive: true })
  await fs.writeFile(path.join(targetD2cDir, 'screenshots', 'index.png'), imageBytes)
  await fs.writeFile(path.join(targetD2cDir, 'absolute.html'), screenshotBackedHtml({ dataUrl, width, height, fileKey, nodeId, sourceUrl: screenshotUrl }), 'utf8')
  await writeJson(path.join(targetD2cDir, 'groupsData.json'), groupsData)
  await fs.writeFile(
    path.join(targetD2cDir, 'chunks', 'figma-mcp-seed.md'),
    `# Figma MCP seed\n\n${note}\n\n- fileKey: ${fileKey}\n- nodeId: ${nodeId || 'root'}\n- screenshot: screenshots/index.png\n- size: ${width}x${height}\n- groups: ${groupsData.length}\n`,
    'utf8',
  )
  await writeJson(path.join(targetSessionDir, 'snapshots', 'v0001.json'), snapshot)
  await writeJson(path.join(targetSessionDir, 'state.json'), state)
  await fs.writeFile(path.join(targetSessionDir, 'events.jsonl'), '', 'utf8')
  await appendEvent(workspace, fileKey, nodeId, event)

  return {
    state,
    event,
    d2cDir: targetD2cDir,
    sessionDir: targetSessionDir,
    groupsData,
    files: {
      absoluteHtml: path.join(targetD2cDir, 'absolute.html'),
      groupsData: path.join(targetD2cDir, 'groupsData.json'),
      screenshot: path.join(targetD2cDir, 'screenshots', 'index.png'),
      snapshot: path.join(targetSessionDir, 'snapshots', 'v0001.json'),
      state: path.join(targetSessionDir, 'state.json'),
    },
  }
}

function resolveWorkspacePath(workspace, value) {
  if (!value || value === true) return undefined
  const raw = String(value)
  return path.isAbsolute(raw) ? raw : path.resolve(workspace, raw)
}

function packageBoundaryCandidates(workspace) {
  return [
    path.join(workspace, 'apps', 'd2c-mcp', 'package.json'),
    path.join(workspace, 'package.json'),
    path.join(process.cwd(), 'apps', 'd2c-mcp', 'package.json'),
    path.join(process.cwd(), 'package.json'),
  ]
}

function requireWorkspacePackage(workspace, packageName) {
  const errors = []
  for (const candidate of packageBoundaryCandidates(workspace)) {
    try {
      return createRequire(candidate)(packageName)
    } catch (error) {
      errors.push(`${candidate}: ${error?.message || error}`)
    }
  }
  try {
    return createRequire(import.meta.url)(packageName)
  } catch (error) {
    errors.push(`plugin: ${error?.message || error}`)
  }
  throw new Error(`Cannot load package "${packageName}". Tried workspace and cwd package boundaries.\n${errors.join('\n')}`)
}

async function readTextPreview(filePath, maxChars) {
  try {
    const content = await fs.readFile(filePath, 'utf8')
    return {
      path: filePath,
      exists: true,
      preview: content.slice(0, maxChars),
      truncated: content.length > maxChars,
      chars: content.length,
    }
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        path: filePath,
        exists: false,
        preview: '',
        truncated: false,
        chars: 0,
      }
    }
    throw error
  }
}

async function walkFiles(root, predicate = () => true) {
  if (!(await pathExists(root))) return []
  const result = []
  async function visit(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await visit(fullPath)
      } else if (entry.isFile() && predicate(fullPath)) {
        const stat = await fs.stat(fullPath).catch(() => null)
        result.push({
          name: path.relative(root, fullPath),
          path: fullPath,
          bytes: stat?.size || 0,
          updatedAt: stat?.mtime?.toISOString?.(),
        })
      }
    }
  }
  await visit(root)
  return result.sort((a, b) => a.name.localeCompare(b.name))
}

async function findD2cSessions(workspace) {
  const root = path.join(workspace, '.sloth')
  if (!(await pathExists(root))) return []
  const fileEntries = await fs.readdir(root, { withFileTypes: true })
  const sessionsByKey = new Map()
  for (const fileEntry of fileEntries) {
    if (!fileEntry.isDirectory() || fileEntry.name === 'sessions' || fileEntry.name === 'plugin') continue
    const fileKey = fileEntry.name
    const fileDir = path.join(root, fileKey)
    const nodeEntries = await fs.readdir(fileDir, { withFileTypes: true })
    for (const nodeEntry of nodeEntries) {
      if (!nodeEntry.isDirectory()) continue
      const nodeId = nodeEntry.name
      const dir = path.join(fileDir, nodeId)
      await ensureSessionStorage(workspace, fileKey, nodeId)
      const statePath = path.join(sessionDir(workspace, fileKey, nodeId), 'state.json')
      const key = sessionId(fileKey, nodeId)
      const dirStat = await fs.stat(dir).catch(() => null)
      sessionsByKey.set(key, {
        sessionId: key,
        fileKey,
        nodeId,
        dir,
        hasGroupsData: await pathExists(path.join(dir, 'groupsData.json')),
        hasChunks: await pathExists(path.join(dir, 'chunks')),
        hasSessionState: await pathExists(statePath),
        updatedAt: dirStat?.mtime?.toISOString?.(),
      })
    }
  }

  const stateRoot = path.join(root, 'sessions')
  if (await pathExists(stateRoot)) {
    const entries = await fs.readdir(stateRoot, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const statePath = path.join(stateRoot, entry.name, 'state.json')
      const state = await readJson(statePath, null)
      if (!state?.fileKey) continue
      await ensureSessionStorage(workspace, state.fileKey, state.nodeId)
      const key = sessionId(state.fileKey, state.nodeId)
      const existing = sessionsByKey.get(key) || {}
      sessionsByKey.set(key, {
        sessionId: key,
        fileKey: state.fileKey,
        nodeId: state.nodeId,
        dir: d2cDir(workspace, state.fileKey, state.nodeId),
        hasGroupsData: await pathExists(path.join(d2cDir(workspace, state.fileKey, state.nodeId), 'groupsData.json')),
        hasChunks: await pathExists(path.join(d2cDir(workspace, state.fileKey, state.nodeId), 'chunks')),
        ...existing,
        hasSessionState: true,
        currentVersion: state.currentVersion || 0,
        latestSnapshotId: state.latestSnapshotId,
        implementationUrl: state.implementationUrl,
        updatedAt: state.updatedAt || existing.updatedAt,
      })
    }
  }

  return Array.from(sessionsByKey.values()).sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
}

async function getState(workspace, fileKey, nodeId) {
  await ensureSessionStorage(workspace, fileKey, nodeId)
  const dir = sessionDir(workspace, fileKey, nodeId)
  const createdAt = new Date().toISOString()
  return readJson(path.join(dir, 'state.json'), {
    sessionId: sessionId(fileKey, nodeId),
    fileKey,
    nodeId,
    currentVersion: 0,
    createdAt,
    updatedAt: createdAt,
    agents: {},
  })
}

async function saveState(workspace, state) {
  await ensureSessionStorage(workspace, state.fileKey, state.nodeId)
  await writeJson(path.join(sessionDir(workspace, state.fileKey, state.nodeId), 'state.json'), state)
}

async function getPendingEvents(workspace, fileKey, nodeId, agentId, source = 'human') {
  const state = await getState(workspace, fileKey, nodeId)
  const progress = state.agents?.[agentId] || {
    processedUntilVersion: 0,
    processedEventIds: [],
  }
  const processed = new Set(progress.processedEventIds || [])
  await ensureSessionStorage(workspace, fileKey, nodeId)
  const events = await readJsonl(path.join(sessionDir(workspace, fileKey, nodeId), 'events.jsonl'))
  return {
    state,
    events: events.filter((event) => event.source === source && !processed.has(event.id)),
  }
}

function isActionableWorkflowEvent(event) {
  return ['workflow.submitted', 'annotation.submitted', 'diff.confirmed', 'repair.requested'].includes(event?.type)
}

function deriveWorkflowPhase(state, events, pendingEvents) {
  const hasImplementation = Boolean(state?.implementationUrl)
  const hasWorkflowSubmitted = events.some((event) => event.type === 'workflow.submitted')
  const pendingWorkflowSubmit = pendingEvents.find((event) => event.type === 'workflow.submitted')
  const pendingAnnotationSubmit = pendingEvents.find((event) => event.type === 'annotation.submitted')
  const pendingDiff = pendingEvents.find((event) => event.type === 'diff.confirmed')
  const pendingRepair = pendingEvents.find((event) => event.type === 'repair.requested')

  if (!hasImplementation) {
    if (pendingWorkflowSubmit) {
      return {
        phase: 'initial_generation_requested',
        waitingFor: 'codex-initial-generation',
        eventId: pendingWorkflowSubmit.id,
        description: 'The user submitted the first-pass design configuration. Codex should generate code before writing implementationUrl.',
      }
    }
    if (hasWorkflowSubmitted) {
      return {
        phase: 'initial_generating',
        waitingFor: 'implementation-url',
        description: 'The first generation has been submitted, but no implementation preview URL has been recorded yet.',
      }
    }
    return {
      phase: 'design_prepare',
      waitingFor: 'workflow.submitted',
      description: 'Open the interceptor on the design preview and wait for the user to finish first-pass grouping/annotations and submit.',
    }
  }

  if (pendingAnnotationSubmit) {
    return {
      phase: 'implementation_annotations_requested',
      waitingFor: 'codex-annotation-fix',
      eventId: pendingAnnotationSubmit.id,
      description: 'The user submitted generated-preview annotations. Codex should fix the implementation and complete the event.',
    }
  }

  if (pendingDiff) {
    return {
      phase: 'design_diff_requested',
      waitingFor: 'codex-design-diff',
      eventId: pendingDiff.id,
      description: 'The user confirmed design diffs. Codex should apply the requested visual fixes.',
    }
  }

  if (pendingRepair) {
    return {
      phase: 'legacy_repair_requested',
      waitingFor: 'codex-repair',
      eventId: pendingRepair.id,
      description: 'A legacy repair event is pending. Codex should handle it through the focused event brief.',
    }
  }

  return {
    phase: 'implementation_loop',
    waitingFor: 'annotation.submitted',
    description: 'The generated implementation is connected. Keep the interceptor in loop mode and wait for new generated-preview annotations.',
  }
}

async function resolveSession(workspace, args) {
  const fileKey = args['file-key'] ? String(args['file-key']) : undefined
  const nodeId = args['node-id'] ? String(args['node-id']) : undefined
  if (fileKey) {
    return {
      fileKey,
      nodeId,
      sessions: await findD2cSessions(workspace),
      inferred: false,
    }
  }

  const sessions = await findD2cSessions(workspace)
  if (!sessions.length) {
    throw new Error('No Sloth D2C sessions found. Run sloth d2c first or pass --file-key and --node-id.')
  }
  return {
    fileKey: sessions[0].fileKey,
    nodeId: sessions[0].nodeId,
    sessions,
    inferred: true,
  }
}

function shouldUseLocalDesignData(args = {}) {
  return args.local === true || args.local === 'true'
}

function interceptorDataSource(args = {}) {
  return shouldUseLocalDesignData(args) ? 'local' : 'restful'
}

function buildInterceptorUrl({ host = 'localhost', port = '3100', fileKey, nodeId, token, mode = 'create', supportSampling = '1', supportRoots = '1', dataSource = 'restful' }) {
  const url = new URL(`http://${host}:${port}/auth-page`)
  url.searchParams.set('token', token || `sloth-d2c-${sessionId(fileKey, nodeId)}`)
  url.searchParams.set('fileKey', fileKey)
  if (nodeId) url.searchParams.set('nodeId', nodeId)
  url.searchParams.set('mode', mode)
  url.searchParams.set('supportSampling', supportSampling)
  url.searchParams.set('supportRoots', supportRoots)
  url.searchParams.set('dataSource', dataSource)
  return url.toString()
}

async function firstReachableInterceptorUrl(candidates) {
  for (const candidate of candidates) {
    const url = buildInterceptorUrl(candidate)
    const probe = await probeImplementationUrl(url, 700)
    if (probe.reachable) {
      return {
        ...candidate,
        url,
        probe,
      }
    }
  }
  return null
}

async function workflowStatus(workspace, args, agentId) {
  const selected = await resolveSession(workspace, args)
  const fileKey = selected.fileKey
  const nodeId = selected.nodeId
  const pending = await getPendingEvents(workspace, fileKey, nodeId, agentId, args.source ? String(args.source) : 'human')
  const state = await getState(workspace, fileKey, nodeId)
  await ensureSessionStorage(workspace, fileKey, nodeId)
  const events = await readJsonl(path.join(sessionDir(workspace, fileKey, nodeId), 'events.jsonl'))
  const actionablePendingEvents = pending.events.filter(isActionableWorkflowEvent)
  const workflowPhase = deriveWorkflowPhase(state, events, actionablePendingEvents)
  const chunks = await listChunks(workspace, fileKey, nodeId)
  const interceptorUrl = buildInterceptorUrl({
    host: String(args.host || 'localhost'),
    port: String(args.port || '3100'),
    fileKey,
    nodeId,
    token: args.token && args.token !== true ? String(args.token) : undefined,
    mode: String(args.mode || 'create'),
    supportSampling: String(args['support-sampling'] || '1'),
    supportRoots: String(args['support-roots'] || '1'),
    dataSource: interceptorDataSource(args),
  })
  const explicitDevPort = args['dev-port'] && args['dev-port'] !== true ? String(args['dev-port']) : ''
  const devMode = args.dev === true || args.dev === 'true' || Boolean(explicitDevPort)
  const devCandidates = devMode
    ? explicitDevPort
      ? [{ host: String(args['dev-host'] || '127.0.0.1'), port: explicitDevPort }]
      : ['5173', '5174', '5175'].flatMap((port) => [
          { host: '127.0.0.1', port },
          { host: 'localhost', port },
        ])
    : []
  const devInterceptor = devMode
    ? await firstReachableInterceptorUrl(
        devCandidates.map((candidate) => ({
          ...candidate,
          fileKey,
          nodeId,
          token: args.token && args.token !== true ? String(args.token) : undefined,
          mode: String(args.mode || 'create'),
          supportSampling: String(args['support-sampling'] || '1'),
          supportRoots: String(args['support-roots'] || '1'),
          dataSource: interceptorDataSource(args),
        })),
      )
    : null
  const devInterceptorUrl = devInterceptor?.url
  const preferredInterceptorUrl = devInterceptorUrl || interceptorUrl
  const warnings = []
  if (devMode && !devInterceptorUrl) {
    warnings.push({
      code: 'no-dev-interceptor',
      message:
        'No Sloth workflow dev interceptor was found. Run commands.startWorkflowDev and rerun workflow-handoff, or omit --dev to use the standard interceptor URL.',
    })
  }

  return {
    workspace,
    selected: {
      fileKey,
      nodeId,
      inferred: selected.inferred,
      sessionId: sessionId(fileKey, nodeId),
    },
    interceptorUrl,
    devInterceptorUrl,
    preferredInterceptorUrl,
    devMode,
    warnings,
    interceptorProbe: {
      dev: devInterceptor || null,
      fallback: {
        host: String(args.host || 'localhost'),
        port: String(args.port || '3100'),
        url: interceptorUrl,
      },
    },
    state,
    workflowPhase,
    pendingEvents: actionablePendingEvents,
    allPendingEvents: pending.events,
    d2cDir: d2cDir(workspace, fileKey, nodeId),
    chunks,
    sessions: selected.sessions,
  }
}

async function nextEventContext(workspace, args, agentId) {
  const status = await workflowStatus(workspace, args, agentId)
  const event = status.pendingEvents[0]
  if (!event) {
    return {
      ...status,
      nextEvent: null,
      context: null,
    }
  }
  return {
    ...status,
    nextEvent: event,
    context: await eventContext(workspace, status.selected.fileKey, status.selected.nodeId, event.id),
  }
}

async function ackEvents(workspace, fileKey, nodeId, agentId, eventIds) {
  const state = await getState(workspace, fileKey, nodeId)
  await ensureSessionStorage(workspace, fileKey, nodeId)
  const events = await readJsonl(path.join(sessionDir(workspace, fileKey, nodeId), 'events.jsonl'))
  const acknowledged = events.filter((event) => eventIds.includes(event.id))
  const previous = state.agents?.[agentId] || {
    processedUntilVersion: 0,
    processedEventIds: [],
    updatedAt: state.createdAt,
  }
  const nextState = {
    ...state,
    updatedAt: new Date().toISOString(),
    agents: {
      ...(state.agents || {}),
      [agentId]: {
        processedUntilVersion: Math.max(previous.processedUntilVersion || 0, ...acknowledged.map((event) => Number(event.version || 0)), 0),
        processedEventIds: Array.from(new Set([...(previous.processedEventIds || []), ...eventIds])),
        updatedAt: new Date().toISOString(),
      },
    },
  }
  await ensureSessionStorage(workspace, fileKey, nodeId)
  await writeJson(path.join(sessionDir(workspace, fileKey, nodeId), 'state.json'), nextState)
  return nextState
}

async function appendAgentEvent(workspace, fileKey, nodeId, type, payload) {
  const state = await getState(workspace, fileKey, nodeId)
  const version = Number(state.currentVersion || 0)
  const event = {
    id: `evt_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    sessionId: sessionId(fileKey, nodeId),
    version,
    snapshotId: state.latestSnapshotId,
    type,
    source: 'agent',
    payload,
    createdAt: new Date().toISOString(),
  }
  await ensureSessionStorage(workspace, fileKey, nodeId)
  await fs.mkdir(sessionDir(workspace, fileKey, nodeId), { recursive: true })
  await fs.appendFile(path.join(sessionDir(workspace, fileKey, nodeId), 'events.jsonl'), `${JSON.stringify(event)}\n`, 'utf8')
  const nextState = {
    ...state,
    updatedAt: event.createdAt,
  }
  await writeJson(path.join(sessionDir(workspace, fileKey, nodeId), 'state.json'), nextState)
  return { state: nextState, event }
}

async function setImplementationUrl(workspace, args) {
  const selected = await resolveSession(workspace, args)
  const fileKey = selected.fileKey
  const nodeId = selected.nodeId
  const url = normalizeUrl(requireArg(args, 'url'))
  const probe = args['skip-check'] ? { url, reachable: true, skipped: true } : await probeImplementationUrl(url, Number(args['timeout-ms'] || 1500))
  if (!probe.reachable) {
    throw new Error(`Implementation URL is not reachable: ${url}${probe.error ? ` (${probe.error})` : ''}`)
  }
  const state = await getState(workspace, fileKey, nodeId)
  const timestamp = new Date().toISOString()
  const nextState = {
    ...state,
    implementationUrl: url,
    implementationUpdatedAt: timestamp,
    updatedAt: timestamp,
  }
  await saveState(workspace, nextState)
  const result = await appendAgentEvent(workspace, fileKey, nodeId, 'implementation.ready', {
    url,
    summary: args.summary ? String(args.summary) : 'Implementation preview connected.',
  })
  return {
    ...result,
    state: {
      ...result.state,
      implementationUrl: url,
      implementationUpdatedAt: timestamp,
    },
    selected: {
      fileKey,
      nodeId,
      inferred: selected.inferred,
      sessionId: sessionId(fileKey, nodeId),
    },
    probe,
  }
}

async function detectImplementationUrl(workspace, args) {
  const selected = await resolveSession(workspace, args)
  const state = await getState(workspace, selected.fileKey, selected.nodeId)
  const timeoutMs = Number(args['timeout-ms'] || 1500)
  const candidates = implementationUrlCandidates(args, state)
  const probes = []
  for (const url of candidates) {
    const probe = await probeImplementationUrl(url, timeoutMs)
    probes.push(probe)
    if (probe.reachable && args.write) {
      const result = await setImplementationUrl(workspace, {
        ...args,
        url: probe.url,
        summary: args.summary || 'Implementation preview detected.',
      })
      return {
        selected: probe,
        probes,
        wrote: true,
        result,
      }
    }
    if (probe.reachable && !args.all) {
      break
    }
  }
  return {
    selected: probes.find((probe) => probe.reachable) || null,
    probes,
    wrote: false,
  }
}

async function clearImplementationUrl(workspace, args) {
  const selected = await resolveSession(workspace, args)
  const state = await getState(workspace, selected.fileKey, selected.nodeId)
  const timestamp = new Date().toISOString()
  const nextState = {
    ...state,
    implementationUrl: undefined,
    implementationUpdatedAt: timestamp,
    updatedAt: timestamp,
  }
  await saveState(workspace, nextState)
  const result = await appendAgentEvent(workspace, selected.fileKey, selected.nodeId, 'implementation.cleared', {
    summary: args.summary ? String(args.summary) : 'Implementation preview disconnected.',
  })
  return {
    ...result,
    state: {
      ...result.state,
      implementationUrl: undefined,
      implementationUpdatedAt: timestamp,
    },
    selected: {
      fileKey: selected.fileKey,
      nodeId: selected.nodeId,
      inferred: selected.inferred,
      sessionId: sessionId(selected.fileKey, selected.nodeId),
    },
  }
}

async function completeEvent(workspace, fileKey, nodeId, agentId, args) {
  const eventIds = optionalList(args, 'event-ids')
  if (!eventIds.length) throw new Error('Missing required --event-ids')
  const before = await getPendingEvents(workspace, fileKey, nodeId, agentId)
  const handledEvents = before.events.filter((event) => eventIds.includes(event.id))
  const basePayload = args['payload-json'] ? JSON.parse(String(args['payload-json'])) : {}
  const payload = {
    ...basePayload,
    summary: args.summary ? String(args.summary) : basePayload.summary || 'Handled Sloth D2C event',
    handledEventIds: eventIds,
  }
  if (handledEvents.length && !basePayload.handledEventSummaries) {
    payload.handledEventSummaries = handledEvents.map((event) => ({
      id: event.id,
      type: event.type,
      version: event.version,
      snapshotId: event.snapshotId,
      groupIndices: eventGroupIndices(event),
      annotationIds: eventAnnotationIds(event),
      canvasAnnotations: eventCanvasAnnotationSummaries(event),
      intent: typeof event.payload?.intent === 'string' ? event.payload.intent : undefined,
    }))
  }
  const files = optionalList(args, 'files')
  const checks = optionalList(args, 'checks')
  if (files.length) payload.files = files
  if (checks.length) payload.checks = checks
  if (args['diff-summary']) payload.diffSummary = String(args['diff-summary'])
  if (args['visual-diffs-json']) payload.visualDiffs = JSON.parse(String(args['visual-diffs-json']))

  const result = await appendAgentEvent(workspace, fileKey, nodeId, String(args.type || 'agent.result'), payload)
  const state = await ackEvents(workspace, fileKey, nodeId, agentId, eventIds)
  const after = await getPendingEvents(workspace, fileKey, nodeId, agentId)
  return {
    ...result,
    acknowledgedEventIds: eventIds,
    handledEvents,
    remainingPendingEvents: after.events,
    remainingPendingCount: after.events.length,
    state,
  }
}

async function claimEvent(workspace, fileKey, nodeId, agentId, args) {
  const pending = await getPendingEvents(workspace, fileKey, nodeId, agentId)
  const eventIds = optionalList(args, 'event-ids')
  const targetEventIds = eventIds.length ? eventIds : pending.events[0] ? [pending.events[0].id] : []
  if (!targetEventIds.length) throw new Error('Missing --event-ids and no pending events were found.')
  const targetEvents = pending.events.filter((event) => targetEventIds.includes(event.id))
  const status = args.status && args.status !== true ? String(args.status) : 'working'
  const payload = {
    status,
    summary: args.summary ? String(args.summary) : `Codex is ${status} ${targetEventIds.length} Sloth D2C event(s).`,
    targetEventIds,
    targetEventSummaries: targetEvents.map((event) => ({
      id: event.id,
      type: event.type,
      version: event.version,
      snapshotId: event.snapshotId,
      groupIndices: eventGroupIndices(event),
      annotationIds: eventAnnotationIds(event),
      canvasAnnotations: eventCanvasAnnotationSummaries(event),
      intent: typeof event.payload?.intent === 'string' ? event.payload.intent : undefined,
    })),
  }
  const result = await appendAgentEvent(workspace, fileKey, nodeId, 'agent.status', payload)
  return {
    ...result,
    targetEvents,
    remainingPendingEvents: pending.events,
    remainingPendingCount: pending.events.length,
  }
}

async function listChunks(workspace, fileKey, nodeId) {
  const chunkDir = path.join(d2cDir(workspace, fileKey, nodeId), 'chunks')
  if (!(await pathExists(chunkDir))) return { chunkDir, chunks: [] }
  const entries = await fs.readdir(chunkDir, { withFileTypes: true })
  return {
    chunkDir,
    chunks: entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort()
      .map((name) => ({
        name,
        path: path.join(chunkDir, name),
      })),
  }
}

function isGroupChunkFileName(name) {
  const normalized = String(name || '').toLowerCase()
  if (!normalized.endsWith('.md')) return false
  if (normalized === 'codeaggregation.md' || normalized === 'finalgenerate.md') return false
  return true
}

function summarizeChunkGeneration(chunks, expectedGroupCount = 0) {
  const chunkList = Array.isArray(chunks?.chunks) ? chunks.chunks : []
  const groupChunks = chunkList.filter((chunk) => isGroupChunkFileName(chunk.name))
  const hasCodeAggregation = chunkList.some((chunk) => String(chunk.name || '').toLowerCase() === 'codeaggregation.md')
  const hasFinalGenerate = chunkList.some((chunk) => String(chunk.name || '').toLowerCase() === 'finalgenerate.md')
  const safeExpected = Math.max(0, Number(expectedGroupCount) || 0)
  return {
    chunkDir: chunks?.chunkDir,
    expectedGroupCount: safeExpected,
    groupChunkCount: groupChunks.length,
    hasCodeAggregation,
    hasFinalGenerate,
    needsSlothD2c: (safeExpected > 0 && groupChunks.length < safeExpected) || !hasCodeAggregation || !hasFinalGenerate,
    groupChunks,
  }
}

function buildSlothD2cArgs(fileKey, nodeId, framework = 'react', args = {}) {
  return [
    'd2c',
    '--file-key',
    fileKey,
    ...(nodeId ? ['--node-id', nodeId] : []),
    '--framework',
    framework || 'react',
    ...(shouldUseLocalDesignData(args) ? ['--local'] : []),
    '--silent',
    '--json',
  ]
}

function previewOutput(value, maxChars = 6000) {
  const raw = String(value || '')
  if (raw.length <= maxChars) return raw
  return `${raw.slice(0, maxChars)}\n...<truncated ${raw.length - maxChars} chars>`
}

async function runSlothD2cAtomicCommand(workspace, fileKey, nodeId, framework, args) {
  const d2cArgs = buildSlothD2cArgs(fileKey, nodeId, framework, args)
  const env = { ...process.env, SLOTH_WORKSPACE_ROOT: workspace }
  const preferRepoCli = Boolean(args['repo-cli'] || args['prefer-repo-cli'])
  const repoCliPath = path.resolve(process.cwd(), 'apps', 'd2c-mcp', 'cli', 'run.js')
  const candidates = preferRepoCli
    ? [
        { kind: 'repo-cli', bin: process.execPath, args: [repoCliPath, ...d2cArgs] },
        { kind: 'sloth', bin: 'sloth', args: d2cArgs },
      ]
    : [
        { kind: 'sloth', bin: 'sloth', args: d2cArgs },
        { kind: 'repo-cli', bin: process.execPath, args: [repoCliPath, ...d2cArgs] },
      ]
  const attempts = []

  for (const candidate of candidates) {
    if (candidate.kind === 'repo-cli' && !(await pathExists(repoCliPath))) {
      attempts.push({
        kind: candidate.kind,
        command: commandString([candidate.bin, ...candidate.args]),
        skipped: true,
        error: `Repo CLI not found: ${repoCliPath}`,
      })
      continue
    }

    try {
      const result = await execFileAsync(candidate.bin, candidate.args, {
        cwd: workspace,
        env,
        maxBuffer: 30 * 1024 * 1024,
      })
      return {
        kind: candidate.kind,
        command: commandString([candidate.bin, ...candidate.args]),
        stdout: previewOutput(result.stdout),
        stderr: previewOutput(result.stderr),
        attempts,
      }
    } catch (error) {
      const failure = {
        kind: candidate.kind,
        command: commandString([candidate.bin, ...candidate.args]),
        error: error?.message || String(error),
        code: error?.code,
        stdout: previewOutput(error?.stdout),
        stderr: previewOutput(error?.stderr),
      }
      attempts.push(failure)
      const allowFallback = failure.code === 'ENOENT' || args['fallback-on-error']
      if (!allowFallback) break
    }
  }

  const last = attempts[attempts.length - 1]
  const detail = last ? `${last.command}\n${last.error || ''}\n${last.stderr || ''}` : 'No command attempted'
  throw new Error(`sloth d2c failed. ${detail}`)
}

async function ensureInitialChunks(workspace, args, agentId) {
  const selected = await resolveSession(workspace, args)
  const fileKey = selected.fileKey
  const nodeId = selected.nodeId
  const status = await workflowStatus(
    workspace,
    {
      ...args,
      'file-key': fileKey,
      'node-id': nodeId,
    },
    agentId,
  )
  const eventId = args['event-id'] ? String(args['event-id']) : status.pendingEvents[0]?.id
  const context = eventId ? await eventContext(workspace, fileKey, nodeId, eventId) : null
  const expectedGroupCount = Array.isArray(context?.groups) && context.groups.length ? context.groups.length : context?.snapshot?.groupCount || 0
  const before = summarizeChunkGeneration(status.chunks, expectedGroupCount)
  const force = Boolean(args.force)

  if (!before.needsSlothD2c && !force) {
    return {
      workspace,
      selected,
      eventId,
      ran: false,
      reason: 'chunks already complete',
      before,
      after: before,
    }
  }

  const run = await runSlothD2cAtomicCommand(workspace, fileKey, nodeId, String(args.framework || 'react'), args)
  const afterChunks = await listChunks(workspace, fileKey, nodeId)
  const after = summarizeChunkGeneration(afterChunks, expectedGroupCount)

  return {
    workspace,
    selected,
    eventId,
    ran: true,
    before,
    after,
    command: run.command,
    commandKind: run.kind,
    stdout: run.stdout,
    stderr: run.stderr,
    attempts: run.attempts,
  }
}

async function chunkPreviews(workspace, fileKey, nodeId, maxChars, maxChunks) {
  const chunks = await listChunks(workspace, fileKey, nodeId)
  const selected = chunks.chunks.slice(0, maxChunks)
  return {
    ...chunks,
    chunks: await Promise.all(
      selected.map(async (chunk) => ({
        ...chunk,
        ...(await readTextPreview(chunk.path, maxChars)),
      })),
    ),
    omitted: Math.max(chunks.chunks.length - selected.length, 0),
  }
}

async function screenshotInventory(workspace, fileKey, nodeId) {
  const screenshotsDir = path.join(d2cDir(workspace, fileKey, nodeId), 'screenshots')
  const screenshots = await walkFiles(screenshotsDir, (filePath) => /\.(png|jpe?g|webp|gif)$/i.test(filePath))
  return {
    screenshotsDir,
    screenshots,
    pageScreenshot: screenshots.find((item) => item.name === 'index.png') || null,
  }
}

async function visualCompare(workspace, args) {
  const selected = await resolveSession(workspace, args)
  const fileKey = selected.fileKey
  const nodeId = selected.nodeId
  const screenshots = await screenshotInventory(workspace, fileKey, nodeId)
  const baselinePath = resolveWorkspacePath(workspace, args.baseline) || screenshots.pageScreenshot?.path
  const candidatePath = resolveWorkspacePath(workspace, args.candidate)
  if (!baselinePath) throw new Error('Missing --baseline and no Sloth page screenshot was found.')
  if (!candidatePath) throw new Error('Missing required --candidate')
  if (!(await pathExists(baselinePath))) throw new Error(`Baseline image not found: ${baselinePath}`)
  if (!(await pathExists(candidatePath))) throw new Error(`Candidate image not found: ${candidatePath}`)

  const Jimp = requireWorkspacePackage(workspace, 'jimp')
  const baseline = await Jimp.read(baselinePath)
  const candidateOriginal = await Jimp.read(candidatePath)
  const baselineSize = { width: baseline.bitmap.width, height: baseline.bitmap.height }
  const candidateSize = { width: candidateOriginal.bitmap.width, height: candidateOriginal.bitmap.height }
  const sizeMismatch = baselineSize.width !== candidateSize.width || baselineSize.height !== candidateSize.height
  const candidateForDiff = sizeMismatch ? candidateOriginal.clone().resize(baselineSize.width, baselineSize.height) : candidateOriginal
  const threshold = Number(args.threshold || 0.1)
  const diffResult = Jimp.diff(baseline, candidateForDiff, threshold)
  const mismatchPercent = Number(diffResult.percent || 0)
  const mismatchRatio = Number(mismatchPercent.toFixed(6))
  const label = String(args.label || 'visual-compare')
  const idBase = cleanPart(`${label}_${Date.now()}`, 'visual_diff')
  const outputDir = resolveWorkspacePath(workspace, args['output-dir']) || path.join(sessionDir(workspace, fileKey, nodeId), 'visual-diffs')
  await fs.mkdir(outputDir, { recursive: true })
  const diffImagePath = path.join(outputDir, `${idBase}.png`)
  await diffResult.image.writeAsync(diffImagePath)

  const status = mismatchPercent <= threshold && !sizeMismatch ? 'matched' : 'needs-review'
  const visualDiff = {
    id: idBase,
    type: 'visual',
    status,
    title: String(args.title || (status === 'matched' ? 'Visual match' : 'Visual difference')),
    summary:
      String(args.summary || '') ||
      `${(mismatchPercent * 100).toFixed(2)}% pixels differ${sizeMismatch ? `; size ${candidateSize.width}x${candidateSize.height} vs ${baselineSize.width}x${baselineSize.height}` : ''}.`,
    label,
    baselinePath,
    candidatePath,
    diffImagePath,
    mismatchPercent: mismatchRatio,
    threshold,
    sizeMismatch,
    baselineSize,
    candidateSize,
    eventId: args['event-id'] && args['event-id'] !== true ? String(args['event-id']) : undefined,
  }

  return {
    workspace,
    selected: {
      fileKey,
      nodeId,
      inferred: selected.inferred,
      sessionId: sessionId(fileKey, nodeId),
    },
    visualDiff,
    visualDiffs: [visualDiff],
    visualDiffsJson: JSON.stringify([visualDiff]),
    paths: {
      baseline: baselinePath,
      candidate: candidatePath,
      diffImage: diffImagePath,
    },
  }
}

async function implementationScreenshotTarget(workspace, args) {
  const selected = await resolveSession(workspace, args)
  const fileKey = selected.fileKey
  const nodeId = selected.nodeId
  const state = await getState(workspace, fileKey, nodeId)
  const label = cleanPart(String(args.label || `implementation_${Date.now()}`), 'implementation')
  const outputDir = resolveWorkspacePath(workspace, args['output-dir']) || path.join(sessionDir(workspace, fileKey, nodeId), 'implementation-screenshots')
  const screenshotPath = resolveWorkspacePath(workspace, args.output) || path.join(outputDir, `${label}.png`)
  await fs.mkdir(path.dirname(screenshotPath), { recursive: true })
  const implementationUrl = args.url && args.url !== true ? String(args.url) : state.implementationUrl
  const compareParts = [
    'node',
    scriptPath(),
    'visual-compare',
    '--workspace',
    workspace,
    '--file-key',
    fileKey,
    ...(nodeId ? ['--node-id', nodeId] : []),
    '--candidate',
    screenshotPath,
    '--label',
    label,
    ...(args.threshold && args.threshold !== true ? ['--threshold', String(args.threshold)] : []),
    ...(args['event-id'] && args['event-id'] !== true ? ['--event-id', String(args['event-id'])] : []),
  ]

  return {
    workspace,
    selected: {
      fileKey,
      nodeId,
      inferred: selected.inferred,
      sessionId: sessionId(fileKey, nodeId),
    },
    screenshotPath,
    implementationUrl,
    commands: {
      visualCompare: commandString(compareParts),
    },
    browserRecipe: {
      url: implementationUrl || '<local implementation URL>',
      screenshotPath,
      steps: [
        'Do not navigate the Codex in-app browser away from the Sloth interceptor.',
        'Capture this URL with headless/local screenshot tooling, or skip the screenshot and report the validation gap if no headless capture is available.',
        'Run commands.visualCompare and pass its visualDiffsJson to complete-event.',
      ],
    },
  }
}

function groupScreenshotCandidates(group) {
  const candidates = []
  for (const [key, value] of Object.entries(group || {})) {
    if (!/screenshot|image|preview/i.test(key)) continue
    if (typeof value === 'string' && value && !value.startsWith('data:') && !/^https?:\/\//i.test(value)) {
      candidates.push({ field: key, value })
    }
  }
  return candidates
}

async function groupScreenshots(workspace, fileKey, nodeId, groups) {
  const screenshotsDir = path.join(d2cDir(workspace, fileKey, nodeId), 'screenshots')
  const all = await screenshotInventory(workspace, fileKey, nodeId)
  const byName = new Map(all.screenshots.map((item) => [item.name, item]))
  const byBase = new Map(all.screenshots.map((item) => [path.basename(item.path), item]))
  return groups.map((group) => {
    const candidates = groupScreenshotCandidates(group)
    const matches = candidates
      .map((candidate) => {
        const rawPath = candidate.value
        const absolute = path.isAbsolute(rawPath) ? rawPath : path.join(screenshotsDir, rawPath)
        const match = byName.get(rawPath) || byBase.get(path.basename(rawPath)) || null
        return {
          ...candidate,
          path: match?.path || absolute,
          exists: Boolean(match),
        }
      })
      .filter((candidate, index, list) => list.findIndex((item) => item.path === candidate.path) === index)
    return {
      groupIndex: group?.groupIndex,
      screenshots: matches,
    }
  })
}

async function readSnapshot(workspace, fileKey, nodeId, snapshotId) {
  if (!snapshotId) return null
  await ensureSessionStorage(workspace, fileKey, nodeId)
  return readJson(path.join(sessionDir(workspace, fileKey, nodeId), 'snapshots', `${snapshotId}.json`), null)
}

function eventGroupIndices(event) {
  const targetIndices = Array.isArray(event?.target?.groupIndices) ? event.target.groupIndices : []
  const payloadIndices = Array.isArray(event?.payload?.changedGroupIndices) ? event.payload.changedGroupIndices : []
  const changedGroups = Array.isArray(event?.payload?.changedGroups) ? event.payload.changedGroups.map((group) => group?.groupIndex) : []
  return Array.from(
    new Set([...targetIndices, ...payloadIndices, ...changedGroups].map((value) => Number(value)).filter((value) => Number.isInteger(value) && value >= 0)),
  ).sort((a, b) => a - b)
}

function eventAnnotationIds(event) {
  const targetIds = Array.isArray(event?.target?.annotationIds) ? event.target.annotationIds : []
  const payloadIds = Array.isArray(event?.payload?.changedAnnotationIds) ? event.payload.changedAnnotationIds : []
  const changedAnnotations = Array.isArray(event?.payload?.changedCanvasAnnotations)
    ? event.payload.changedCanvasAnnotations.map((annotation) => annotation?.id)
    : []
  return Array.from(new Set([...targetIds, ...payloadIds, ...changedAnnotations].map((value) => String(value || '')).filter(Boolean)))
}

function eventCanvasAnnotationSummaries(event) {
  const changed = Array.isArray(event?.payload?.changedCanvasAnnotations) ? event.payload.changedCanvasAnnotations : []
  const all = Array.isArray(event?.payload?.canvasAnnotations) ? event.payload.canvasAnnotations : []
  const ids = eventAnnotationIds(event)
  const source = changed.length ? changed : all.filter((annotation) => ids.includes(String(annotation?.id || '')))
  return source.map((annotation) => ({
    id: String(annotation?.id || ''),
    text: typeof annotation?.text === 'string' ? annotation.text : '',
    changeType: typeof annotation?.changeType === 'string' ? annotation.changeType : undefined,
    target: annotation?.target === 'implementation' ? 'implementation' : 'design',
    x1: typeof annotation?.x1 === 'number' ? annotation.x1 : undefined,
    y1: typeof annotation?.y1 === 'number' ? annotation.y1 : undefined,
    x2: typeof annotation?.x2 === 'number' ? annotation.x2 : undefined,
    y2: typeof annotation?.y2 === 'number' ? annotation.y2 : undefined,
  }))
}

async function eventContext(workspace, fileKey, nodeId, eventId) {
  const state = await getState(workspace, fileKey, nodeId)
  await ensureSessionStorage(workspace, fileKey, nodeId)
  const events = await readJsonl(path.join(sessionDir(workspace, fileKey, nodeId), 'events.jsonl'))
  const event = events.find((item) => item.id === eventId)
  if (!event) throw new Error(`Event not found: ${eventId}`)

  const snapshot = await readSnapshot(workspace, fileKey, nodeId, event.snapshotId || state.latestSnapshotId)
  const groupsData = Array.isArray(snapshot?.groupsData)
    ? snapshot.groupsData
    : await readJson(path.join(d2cDir(workspace, fileKey, nodeId), 'groupsData.json'), [])
  const groupIndices = eventGroupIndices(event)
  const groups = groupIndices.length ? groupsData.filter((group) => groupIndices.includes(Number(group.groupIndex))) : []
  const annotationIds = eventAnnotationIds(event)
  const canvasAnnotations = Array.isArray(snapshot?.canvasAnnotations)
    ? snapshot.canvasAnnotations
    : Array.isArray(event?.payload?.canvasAnnotations)
      ? event.payload.canvasAnnotations
      : []
  const payloadChangedCanvasAnnotations = Array.isArray(event?.payload?.changedCanvasAnnotations) ? event.payload.changedCanvasAnnotations : []
  const payloadChangedById = new Map(payloadChangedCanvasAnnotations.map((annotation) => [String(annotation?.id || ''), annotation]).filter(([id]) => id))
  const changedCanvasAnnotations = annotationIds.length
    ? annotationIds
        .map((id) => payloadChangedById.get(id) || canvasAnnotations.find((annotation) => String(annotation?.id || '') === id))
        .filter(Boolean)
    : payloadChangedCanvasAnnotations
  const chunks = await listChunks(workspace, fileKey, nodeId)

  return {
    state,
    event,
    snapshot: snapshot
      ? {
          snapshotId: snapshot.snapshotId,
          version: snapshot.version,
          createdAt: snapshot.createdAt,
          groupCount: Array.isArray(snapshot.groupsData) ? snapshot.groupsData.length : 0,
          annotationCount: Array.isArray(snapshot.canvasAnnotations) ? snapshot.canvasAnnotations.length : 0,
        }
      : null,
    changedGroupIndices: groupIndices,
    groups,
    changedAnnotationIds: annotationIds,
    changedCanvasAnnotations,
    canvasAnnotations,
    d2cDir: d2cDir(workspace, fileKey, nodeId),
    chunks,
  }
}

async function eventBrief(workspace, args, agentId) {
  const selected = await resolveSession(workspace, args)
  const status = await workflowStatus(
    workspace,
    {
      ...args,
      'file-key': selected.fileKey,
      'node-id': selected.nodeId,
    },
    agentId,
  )
  const eventId = args['event-id'] ? String(args['event-id']) : status.pendingEvents[0]?.id
  if (!eventId) {
    return {
      ...status,
      eventBrief: null,
      repairBrief: null,
      message: 'No pending human events for this agent.',
    }
  }

  const maxChars = Number(args['max-chars'] || 6000)
  const maxChunks = Number(args['max-chunks'] || 8)
  const context = await eventContext(workspace, selected.fileKey, selected.nodeId, eventId)
  const root = d2cDir(workspace, selected.fileKey, selected.nodeId)
  const absoluteHtml = await readTextPreview(path.join(root, 'absolute.html'), maxChars)
  const screenshots = await screenshotInventory(workspace, selected.fileKey, selected.nodeId)
  const relatedGroupScreenshots = await groupScreenshots(workspace, selected.fileKey, selected.nodeId, context.groups)
  const chunks = await chunkPreviews(workspace, selected.fileKey, selected.nodeId, maxChars, maxChunks)
  const defaultBaseline = screenshots.pageScreenshot?.path || path.join(root, 'screenshots', 'index.png')
  const implementationScreenshot = await implementationScreenshotTarget(
    workspace,
    {
      ...args,
      'file-key': selected.fileKey,
      'node-id': selected.nodeId,
      label: `implementation_${eventId}`,
      'event-id': eventId,
    },
  )
  const visualCompareCommand = [
    'node',
    shellQuote(scriptPath()),
    'visual-compare',
    '--workspace',
    shellQuote(workspace),
    '--file-key',
    shellQuote(selected.fileKey),
    ...(selected.nodeId ? ['--node-id', shellQuote(selected.nodeId)] : []),
    '--baseline',
    shellQuote(defaultBaseline),
    '--candidate',
    shellQuote('<local implementation screenshot path>'),
    '--event-id',
    shellQuote(eventId),
    '--label',
    shellQuote('figma-vs-implementation'),
  ].join(' ')
  const claimEventCommand = [
    'node',
    shellQuote(scriptPath()),
    'claim-event',
    '--workspace',
    shellQuote(workspace),
    '--file-key',
    shellQuote(selected.fileKey),
    ...(selected.nodeId ? ['--node-id', shellQuote(selected.nodeId)] : []),
    '--agent-id',
    shellQuote(agentId),
    '--event-ids',
    shellQuote(eventId),
    '--summary',
    shellQuote('<what Codex started handling>'),
  ].join(' ')
  const completeEventCommand = [
    'node',
    shellQuote(scriptPath()),
    'complete-event',
    '--workspace',
    shellQuote(workspace),
    '--file-key',
    shellQuote(selected.fileKey),
    ...(selected.nodeId ? ['--node-id', shellQuote(selected.nodeId)] : []),
    '--agent-id',
    shellQuote(agentId),
    '--event-ids',
    shellQuote(eventId),
    '--summary',
    shellQuote('<what Codex changed>'),
    '--files',
    shellQuote('<comma-separated changed files>'),
    '--checks',
    shellQuote('<comma-separated checks run>'),
    '--diff-summary',
    shellQuote('<user-facing visual/code diff summary>'),
    '--visual-diffs-json',
    shellQuote('<optional JSON array of visual/style diffs>'),
  ].join(' ')

  const brief = {
    workspace,
    selected: status.selected,
    interceptorUrl: status.interceptorUrl,
    devInterceptorUrl: status.devInterceptorUrl,
    preferredInterceptorUrl: status.preferredInterceptorUrl,
    pendingEvents: status.pendingEvents,
    eventBrief: {
      event: context.event,
      snapshot: context.snapshot,
      changedGroupIndices: context.changedGroupIndices,
      groups: context.groups,
      changedAnnotationIds: context.changedAnnotationIds,
      changedCanvasAnnotations: context.changedCanvasAnnotations,
      canvasAnnotations: context.canvasAnnotations,
      d2cDir: root,
      absoluteHtml,
      screenshots,
      groupScreenshots: relatedGroupScreenshots,
      chunks,
      implementationScreenshot,
      instructions: [
        'Start from eventBrief.event, eventBrief.changedCanvasAnnotations, and eventBrief.groups. Do not rescan unrelated historical annotations unless this event requires it.',
        'Compare the group screenshot/page screenshot, absolute.html, and chunk previews against the target implementation.',
        'Keep the Codex in-app browser on the Sloth interceptor. When visual evidence matters, capture the local implementation with headless/local tooling to eventBrief.implementationScreenshot.screenshotPath, then run eventBrief.implementationScreenshot.commands.visualCompare.',
        'Edit the local implementation, run the narrowest useful checks, then write an agent result and acknowledge the handled event.',
      ],
      commands: {
        claimEvent: claimEventCommand,
        visualCompare: visualCompareCommand,
        completeEvent: completeEventCommand,
      },
    },
  }
  return {
    ...brief,
    repairBrief: brief.eventBrief,
  }
}

async function repairBrief(workspace, args, agentId) {
  return eventBrief(workspace, args, agentId)
}

async function annotationWorkflow(workspace, args, agentId) {
  const brief = await eventBrief(workspace, args, agentId)
  const event = brief.eventBrief?.event
  if (!event) {
    return {
      ...brief,
      mode: 'idle',
      message: 'No pending annotation event for this agent.',
    }
  }

  const changedAnnotations = Array.isArray(brief.eventBrief.changedCanvasAnnotations) ? brief.eventBrief.changedCanvasAnnotations : []
  const implementationAnnotations = changedAnnotations.filter((annotation) => annotation?.target === 'implementation')
  return {
    ...brief,
    mode: 'handle-annotation',
    annotationWorkflow: {
      eventId: event.id,
      eventType: event.type,
      surface: typeof event.target?.surface === 'string' ? event.target.surface : event.payload?.surface || 'unknown',
      implementationAnnotationCount: implementationAnnotations.length,
      instructions: [
        'Claim this event before long-running work.',
        'Handle only eventBrief.changedCanvasAnnotations for this event. When target is implementation, treat coordinates as relative to the generated preview pane.',
        'Edit the local implementation until the submitted annotations are satisfied.',
        'Run the narrowest useful checks. For visual work, capture the generated preview and run design-diff or visual-compare.',
        'Finish with complete-event so the interceptor can switch from Agent 生成中 to 已修改完成.',
      ],
      commands: brief.eventBrief.commands,
    },
  }
}

async function designDiff(workspace, args, agentId) {
  const selected = await resolveSession(workspace, args)
  const status = await workflowStatus(
    workspace,
    {
      ...args,
      'file-key': selected.fileKey,
      'node-id': selected.nodeId,
    },
    agentId,
  )
  const root = d2cDir(workspace, selected.fileKey, selected.nodeId)
  const screenshots = await screenshotInventory(workspace, selected.fileKey, selected.nodeId)
  const baseline = args.baseline && args.baseline !== true ? path.resolve(workspace, String(args.baseline)) : screenshots.pageScreenshot?.path || path.join(root, 'screenshots', 'index.png')
  const target = await implementationScreenshotTarget(workspace, {
    ...args,
    'file-key': selected.fileKey,
    'node-id': selected.nodeId,
    label: args.label && args.label !== true ? String(args.label) : 'design_diff',
  })

  if (args.candidate && args.candidate !== true) {
    const comparison = await visualCompare(workspace, {
      ...args,
      'file-key': selected.fileKey,
      'node-id': selected.nodeId,
      baseline,
      candidate: String(args.candidate),
      label: args.label && args.label !== true ? String(args.label) : 'design-diff',
    })
    return {
      mode: 'compared',
      selected: status.selected,
      state: status.state,
      comparison,
    }
  }

  return {
    mode: 'needs-candidate-screenshot',
    selected: status.selected,
    state: status.state,
    implementationUrl: status.state.implementationUrl,
    baseline,
    implementationScreenshot: target,
    instructions: [
      'Do not open implementationScreenshot.implementationUrl in the Codex in-app browser; keep the in-app browser on the Sloth interceptor.',
      'Capture implementationScreenshot.implementationUrl with headless/local screenshot tooling and save it to implementationScreenshot.screenshotPath.',
      'Run implementationScreenshot.commands.visualCompare or call design-diff again with --candidate <screenshotPath>.',
      'Use the diff image and mismatch ratio to edit the generated implementation, then repeat until the generated preview sufficiently matches the design.',
      'When this command is part of a pending annotation event, pass the visualDiffs JSON to complete-event.',
    ],
    commands: {
      captureTarget: target,
      compareAfterCapture: commandString([
        'node',
        scriptPath(),
        'design-diff',
        '--workspace',
        workspace,
        '--file-key',
        selected.fileKey,
        ...(selected.nodeId ? ['--node-id', selected.nodeId] : []),
        '--candidate',
        target.screenshotPath,
        '--label',
        args.label && args.label !== true ? String(args.label) : 'design-diff',
      ]),
    },
  }
}

async function workflowHandoff(workspace, args, agentId) {
  const status = await workflowStatus(workspace, args, agentId)
  const fileKey = status.selected.fileKey
  const nodeId = status.selected.nodeId
  const baseArgs = [
    '--workspace',
    workspace,
    '--file-key',
    fileKey,
    ...(nodeId ? ['--node-id', nodeId] : []),
    '--agent-id',
    agentId,
  ]
  const portArgs = [
    ...(args.port && args.port !== true ? ['--port', String(args.port)] : []),
    ...(args['dev-port'] && args['dev-port'] !== true ? ['--dev-port', String(args['dev-port'])] : []),
  ]
  const firstPending = status.pendingEvents[0]
  const firstBrief = firstPending
    ? (await eventBrief(
        workspace,
        {
          ...args,
          'file-key': fileKey,
          'node-id': nodeId,
          'event-id': firstPending.id,
        },
        agentId,
      )).eventBrief
    : null
  const phase = status.workflowPhase?.phase || 'design_prepare'
  const shouldStartDevInterceptor = phase === 'design_prepare' && status.devMode && !status.devInterceptorUrl
  const submittedGroupCount =
    firstBrief && Array.isArray(firstBrief.groups)
      ? firstBrief.groups.length
      : firstBrief?.snapshot?.groupCount || 0
  const initialChunkStatus = summarizeChunkGeneration(status.chunks, submittedGroupCount)
  const generateChunksCommand = commandString([
    'node',
    scriptPath(),
    'ensure-initial-chunks',
    ...baseArgs,
    '--framework',
    String(args.framework || 'react'),
    ...(args.local === true || args.local === 'true' ? ['--local'] : []),
    '--prefer-repo-cli',
  ])
  const rawSlothD2cCommand = commandString(['sloth', ...buildSlothD2cArgs(fileKey, nodeId, String(args.framework || 'react'), args)])
  const rawSlothD2cDevFallbackCommand = commandString([
    'node',
    path.resolve(process.cwd(), 'apps', 'd2c-mcp', 'cli', 'run.js'),
    ...buildSlothD2cArgs(fileKey, nodeId, String(args.framework || 'react'), args),
  ])
  const recommendedActionByPhase = {
    design_prepare: shouldStartDevInterceptor
      ? 'Start the Sloth workflow dev launcher, rerun workflow-handoff, then open the returned interceptor URL in the Codex in-app browser and end this Codex turn. Use shell open/system default browser/Chrome only if the Codex in-app browser is unavailable or control fails.'
      : 'Open the interceptor in the Codex in-app browser, confirm it is visible, then end this Codex turn. Use shell open/system default browser/Chrome only if the Codex in-app browser is unavailable or control fails. Do not run wait-next-event, D2C, or implementationUrl detection in this phase. The user will return after submitting the first workflow.',
    initial_generation_requested: initialChunkStatus.needsSlothD2c
      ? 'Before writing implementation code, run the sloth d2c atomic command to generate submitted group chunks/prompts. Do not hand-write the initial implementation from screenshots while chunks are missing. After chunks/codeAggregation/finalGenerate exist, claim the workflow.submitted event, consume the chunks, start the target app preview, write implementationUrl, keep or reopen the Sloth interceptor in the Codex in-app browser, then complete the event.'
      : 'Claim the workflow.submitted event, consume the existing Sloth D2C chunks/prompts to generate the initial code, start the target app preview, write implementationUrl, keep or reopen the Sloth interceptor in the Codex in-app browser, then complete the workflow.submitted event. Do not navigate the in-app browser directly to the target preview URL.',
    initial_generating: 'Continue the first generation path until a reachable implementation preview URL is available, then write implementationUrl so the interceptor can enter loop mode. Keep the Codex in-app browser on the Sloth interceptor.',
    implementation_loop: 'Open the interceptor loop page and wait for the user to save generated-preview annotations.',
    implementation_annotations_requested: 'Handle the returned generated-preview annotation eventBrief, edit code, run checks, then run complete-event.',
    design_diff_requested: 'Handle the returned design diff eventBrief, compare the design and implementation, edit code, run checks, then run complete-event.',
    legacy_repair_requested: 'Handle the returned legacy repair eventBrief, edit code, run checks, then run complete-event.',
  }

  return {
    ...status,
    nextEvent: firstPending || null,
    eventBrief: firstBrief,
    repairBrief: firstBrief,
    initialGeneration: {
      chunkStatus: initialChunkStatus,
      mustRunSlothD2cBeforeCoding: phase === 'initial_generation_requested' && initialChunkStatus.needsSlothD2c,
    },
    stopCondition:
      phase === 'design_prepare'
        ? 'Stop after opening the interceptor. Resume only when the user asks Codex to continue after submitting the first workflow.'
        : undefined,
    recommendedAction:
      recommendedActionByPhase[phase] ||
      (firstPending
        ? 'Handle the returned eventBrief, edit code, run checks, then run complete-event.'
        : 'Open the interceptor URL in the Codex in-app browser, let the user annotate, then run wait-next-event.'),
    commands: {
      openUrl: shouldStartDevInterceptor ? null : status.preferredInterceptorUrl || status.devInterceptorUrl || status.interceptorUrl,
      fallbackOpenUrl: status.interceptorUrl,
      startWorkflowDev: status.devMode
        ? commandString([
            'node',
            path.join(path.dirname(scriptPath()), 'start-workflow-dev.mjs'),
            '--workspace',
            workspace,
            '--file-key',
            fileKey,
            ...(nodeId ? ['--node-id', nodeId] : []),
          ])
        : null,
      waitNextEvent: commandString([
        'node',
        scriptPath(),
        'wait-next-event',
        ...baseArgs,
        ...portArgs,
        '--timeout-ms',
        String(args['timeout-ms'] || 300000),
        '--poll-ms',
        String(args['poll-ms'] || 2000),
      ]),
      nextEventContext: commandString(['node', scriptPath(), 'next-event-context', ...baseArgs]),
      eventBrief: commandString(['node', scriptPath(), 'event-brief', ...baseArgs]),
      initialGenerationBrief: commandString(['node', scriptPath(), 'event-brief', ...baseArgs]),
      generateChunks: generateChunksCommand,
      rawSlothD2c: rawSlothD2cCommand,
      rawSlothD2cDevFallback: rawSlothD2cDevFallbackCommand,
      annotationBrief: commandString(['node', scriptPath(), 'annotation-brief', ...baseArgs]),
      annotationWorkflow: commandString(['node', scriptPath(), 'annotation-workflow', ...baseArgs]),
      repairBrief: commandString(['node', scriptPath(), 'repair-brief', ...baseArgs]),
      implementationScreenshotTarget: commandString([
        'node',
        scriptPath(),
        'implementation-screenshot-target',
        ...baseArgs,
        '--label',
        'implementation',
      ]),
      detectImplementationUrl: commandString([
        'node',
        scriptPath(),
        'detect-implementation-url',
        ...baseArgs,
        '--write',
      ]),
      setImplementationUrl: commandString([
        'node',
        scriptPath(),
        'set-implementation-url',
        ...baseArgs,
        '--url',
        '<local implementation URL>',
      ]),
      claimEventTemplate: commandString([
        'node',
        scriptPath(),
        'claim-event',
        ...baseArgs,
        '--event-ids',
        '<event-id>',
        '--summary',
        '<what Codex started handling>',
      ]),
      visualCompareTemplate: commandString([
        'node',
        scriptPath(),
        'visual-compare',
        ...baseArgs,
        '--candidate',
        '<local implementation screenshot path>',
        '--label',
        'figma-vs-implementation',
      ]),
      designDiff: commandString(['node', scriptPath(), 'design-diff', ...baseArgs, '--label', 'design-diff']),
      completeEventTemplate: commandString([
        'node',
        scriptPath(),
        'complete-event',
        ...baseArgs,
        '--event-ids',
        '<event-id>',
        '--summary',
        '<what Codex changed>',
        '--files',
        '<comma-separated changed files>',
        '--checks',
        '<comma-separated checks run>',
        '--diff-summary',
        '<user-facing visual/code diff summary>',
        '--visual-diffs-json',
        '<optional JSON array of visual/style diffs>',
      ]),
    },
  }
}

async function workflowGuide(workspace, args, agentId) {
  const handoff = await workflowHandoff(workspace, args, agentId)
  const hasPendingEvent = Boolean(handoff.nextEvent)
  const phase = handoff.workflowPhase?.phase || 'design_prepare'
  const isFirstRunWaiting = phase === 'design_prepare'
  const isInitialGeneration = phase === 'initial_generation_requested' || phase === 'initial_generating'
  const isLoopWaiting = phase === 'implementation_loop'
  const needsDevInterceptor = isFirstRunWaiting && !handoff.commands.openUrl
  const needsInitialChunks = Boolean(handoff.initialGeneration?.mustRunSlothD2cBeforeCoding)
  return {
    workspace,
    selected: handoff.selected,
    state: handoff.state,
    workflowPhase: handoff.workflowPhase,
    pendingEvents: handoff.pendingEvents,
    allPendingEvents: handoff.allPendingEvents,
    mode: hasPendingEvent ? 'handle-pending-event' : phase,
    guide: [
      {
        step: 'open-interceptor',
        status: 'ready',
        action: needsDevInterceptor
          ? 'Start the Sloth workflow dev launcher, rerun workflow-handoff, then open the returned interceptor URL in the Codex in-app browser. Use shell open/system default browser/Chrome only if the Codex in-app browser is unavailable or control fails.'
          : isInitialGeneration
          ? 'Keep the existing Sloth interceptor open while Codex performs the first generation.'
          : 'Open the existing Sloth interceptor in the Codex in-app browser. Use shell open/system default browser/Chrome only if the Codex in-app browser is unavailable or control fails.',
        url: handoff.commands.openUrl,
        command: needsDevInterceptor ? handoff.commands.startWorkflowDev : null,
        doneWhen: needsDevInterceptor
          ? 'workflow-handoff returns commands.openUrl.'
          : 'The browser shows Sloth D2C 工作台 and the header session version matches this state.',
      },
      {
        step: 'wait-or-handle-event',
        status: hasPendingEvent ? 'ready' : isFirstRunWaiting ? 'return-to-user' : 'waiting',
        action: hasPendingEvent
          ? phase === 'initial_generation_requested'
            ? needsInitialChunks
              ? 'Run sloth d2c first to generate chunks/prompts for the submitted groups, then claim the workflow.submitted event and generate the first implementation from those chunks.'
              : 'Claim the workflow.submitted event, then generate the first implementation from existing Sloth D2C chunks/prompts.'
            : 'Claim the returned pending event, then handle the eventBrief.'
          : isFirstRunWaiting
            ? 'Do not poll here. End the turn after opening the interceptor; the user will submit the first workflow and ask Codex to continue.'
            : isLoopWaiting
              ? 'Wait specifically for annotation.submitted from generated-preview annotations.'
              : 'Wait for the next actionable workflow event.',
        command: hasPendingEvent
          ? needsInitialChunks
            ? handoff.commands.generateChunks
            : handoff.eventBrief?.commands?.claimEvent || handoff.commands.claimEventTemplate
          : isFirstRunWaiting
            ? null
            : handoff.commands.waitNextEvent,
        doneWhen: hasPendingEvent
          ? 'The interceptor timeline shows Codex is handling the event.'
          : isFirstRunWaiting
            ? 'The user can see the first-run interceptor and Codex has reported that it is waiting for a later continuation.'
            : 'wait-next-event returns timedOut=false with nextEvent and eventBrief.',
      },
      {
        step: 'inspect-event',
        status: hasPendingEvent ? 'pending-work' : isFirstRunWaiting ? 'not-started-until-user-submit' : 'blocked-until-event',
        action: phase === 'initial_generation_requested'
          ? needsInitialChunks
            ? 'Do not inspect app code yet. First run sloth d2c and verify chunks/codeAggregation/finalGenerate exist. Then consume those generated prompts/chunks to create the initial implementation.'
            : 'Use the submitted groups, annotations, screenshots, and Sloth-generated chunks/prompts to create the initial implementation. Do not write implementationUrl until the target app preview is reachable. Keep the Codex in-app browser on the Sloth interceptor; do not navigate it to the target preview.'
          : isFirstRunWaiting
            ? 'No code inspection yet. The first actionable context appears after workflow.submitted.'
            : 'Inspect the event brief, compare visuals when useful, edit code, and run checks.',
        command: hasPendingEvent ? handoff.commands.eventBrief : isFirstRunWaiting ? null : handoff.commands.eventBrief,
        doneWhen: phase === 'initial_generation_requested'
          ? 'Initial code exists, the target app preview is running, implementationUrl has been written, and the Sloth interceptor is still the visible Codex browser surface.'
          : isFirstRunWaiting
            ? 'The user submits the first workflow and asks Codex to continue.'
          : hasPendingEvent
            ? 'Code changes and checks for nextEvent are complete.'
            : 'A pending event exists.',
      },
      {
        step: 'complete-event',
        status: hasPendingEvent ? 'pending-work' : isFirstRunWaiting ? 'not-started-until-user-submit' : 'blocked-until-event',
        action: isFirstRunWaiting
          ? 'Do not complete anything yet; no human workflow event has been submitted.'
          : 'Write an agent.result event and acknowledge only the handled human event ids.',
        command: hasPendingEvent
          ? handoff.eventBrief?.commands?.completeEvent || handoff.commands.completeEventTemplate
          : isFirstRunWaiting
            ? null
            : handoff.commands.completeEventTemplate,
        doneWhen: isFirstRunWaiting
          ? 'No completion action is needed in design_prepare.'
          : 'complete-event returns remainingPendingCount. Continue the loop if it is greater than 0.',
      },
      {
        step: 'loop',
        status: 'ready',
        action: 'Run workflow-handoff again after complete-event to either pick up the next event or return to waiting.',
        command: commandString([
          'node',
          scriptPath(),
          'workflow-handoff',
          '--workspace',
          workspace,
          '--file-key',
          handoff.selected.fileKey,
          ...(handoff.selected.nodeId ? ['--node-id', handoff.selected.nodeId] : []),
          '--agent-id',
          agentId,
          ...(args.port && args.port !== true ? ['--port', String(args.port)] : []),
          ...(args['dev-port'] && args['dev-port'] !== true ? ['--dev-port', String(args['dev-port'])] : []),
        ]),
        doneWhen: 'There are no pending events and the user is not waiting for an agent response.',
      },
    ],
    handoff,
  }
}

async function waitNextEvent(workspace, args, agentId) {
  const timeoutMs = Number(args['timeout-ms'] || 300000)
  const pollMs = Number(args['poll-ms'] || 2000)
  const startedAt = Date.now()
  let polls = 0
  let latestStatus = null

  while (true) {
    polls += 1
    latestStatus = await workflowStatus(workspace, args, agentId)
    const nextEvent = latestStatus.pendingEvents[0]
    if (nextEvent) {
      const brief = await eventBrief(
        workspace,
        {
          ...args,
          'file-key': latestStatus.selected.fileKey,
          'node-id': latestStatus.selected.nodeId,
          'event-id': nextEvent.id,
        },
        agentId,
      )
      return {
        ...latestStatus,
        timedOut: false,
        polls,
        waitedMs: Date.now() - startedAt,
        nextEvent,
        eventBrief: brief.eventBrief,
        repairBrief: brief.eventBrief,
      }
    }

    if (timeoutMs >= 0 && Date.now() - startedAt >= timeoutMs) {
      return {
        ...(latestStatus || {}),
        timedOut: true,
        polls,
        waitedMs: Date.now() - startedAt,
        nextEvent: null,
        eventBrief: null,
        repairBrief: null,
        message: 'No pending human events before timeout.',
      }
    }

    await sleep(Math.max(pollMs, 250))
  }
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

async function main() {
  const { command, args } = parseArgs(process.argv.slice(2))
  const workspace = workspaceOf(args)
  const agentId = String(args['agent-id'] || 'codex')

  if (command === 'sessions') {
    printJson(await findD2cSessions(workspace))
    return
  }

  if (command === 'workflow-status') {
    printJson(await workflowStatus(workspace, args, agentId))
    return
  }

  if (command === 'workflow-handoff') {
    printJson(await workflowHandoff(workspace, args, agentId))
    return
  }

  if (command === 'workflow-guide') {
    printJson(await workflowGuide(workspace, args, agentId))
    return
  }

  if (command === 'interceptor-url') {
    const selected = await resolveSession(workspace, args)
    process.stdout.write(
      `${buildInterceptorUrl({
        host: String(args.host || 'localhost'),
        port: String(args.port || '3100'),
        fileKey: selected.fileKey,
        nodeId: selected.nodeId,
        token: args.token && args.token !== true ? String(args.token) : undefined,
        mode: String(args.mode || 'create'),
        supportSampling: String(args['support-sampling'] || '1'),
        supportRoots: String(args['support-roots'] || '1'),
        dataSource: interceptorDataSource(args),
      })}\n`,
    )
    return
  }

  if (command === 'next-event-context') {
    printJson(await nextEventContext(workspace, args, agentId))
    return
  }

  if (command === 'event-brief' || command === 'annotation-brief' || command === 'repair-brief') {
    printJson(await eventBrief(workspace, args, agentId))
    return
  }

  if (command === 'annotation-workflow') {
    printJson(await annotationWorkflow(workspace, args, agentId))
    return
  }

  if (command === 'design-diff') {
    printJson(await designDiff(workspace, args, agentId))
    return
  }

  if (command === 'visual-compare') {
    printJson(await visualCompare(workspace, args))
    return
  }

  if (command === 'implementation-screenshot-target') {
    printJson(await implementationScreenshotTarget(workspace, args))
    return
  }

  if (command === 'set-implementation-url') {
    printJson(await setImplementationUrl(workspace, args))
    return
  }

  if (command === 'detect-implementation-url') {
    printJson(await detectImplementationUrl(workspace, args))
    return
  }

  if (command === 'clear-implementation-url') {
    printJson(await clearImplementationUrl(workspace, args))
    return
  }

  if (command === 'wait-next-event') {
    printJson(await waitNextEvent(workspace, args, agentId))
    return
  }

  if (command === 'state') {
    printJson(await getState(workspace, requireArg(args, 'file-key'), args['node-id'] ? String(args['node-id']) : undefined))
    return
  }

  if (command === 'pending-events') {
    const fileKey = requireArg(args, 'file-key')
    const nodeId = args['node-id'] ? String(args['node-id']) : undefined
    printJson(await getPendingEvents(workspace, fileKey, nodeId, agentId, args.source ? String(args.source) : 'human'))
    return
  }

  if (command === 'ack-events') {
    const eventIds = optionalList(args, 'event-ids')
    if (!eventIds.length) throw new Error('Missing required --event-ids')
    printJson(await ackEvents(workspace, requireArg(args, 'file-key'), args['node-id'] ? String(args['node-id']) : undefined, agentId, eventIds))
    return
  }

  if (command === 'complete-event') {
    printJson(await completeEvent(workspace, requireArg(args, 'file-key'), args['node-id'] ? String(args['node-id']) : undefined, agentId, args))
    return
  }

  if (command === 'claim-event') {
    printJson(await claimEvent(workspace, requireArg(args, 'file-key'), args['node-id'] ? String(args['node-id']) : undefined, agentId, args))
    return
  }

  if (command === 'append-agent-event') {
    const payload = args['payload-json'] ? JSON.parse(String(args['payload-json'])) : {}
    printJson(await appendAgentEvent(workspace, requireArg(args, 'file-key'), args['node-id'] ? String(args['node-id']) : undefined, requireArg(args, 'type'), payload))
    return
  }

  if (command === 'event-context') {
    printJson(
      await eventContext(
        workspace,
        requireArg(args, 'file-key'),
        args['node-id'] ? String(args['node-id']) : undefined,
        requireArg(args, 'event-id'),
      ),
    )
    return
  }

  if (command === 'ensure-initial-chunks') {
    printJson(await ensureInitialChunks(workspace, args, agentId))
    return
  }

  if (command === 'd2c-dir') {
    process.stdout.write(`${d2cDir(workspace, requireArg(args, 'file-key'), args['node-id'] ? String(args['node-id']) : undefined)}\n`)
    return
  }

  if (command === 'seed-figma-session') {
    printJson(await seedFigmaSession(workspace, args))
    return
  }

  throw new Error(`Unknown command: ${command || '(empty)'}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
