#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFile, spawn } from 'node:child_process'
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

function loopDir(workspace, fileKey, nodeId) {
  return path.join(d2cDir(workspace, fileKey, nodeId), 'loop')
}

function createWorkflowToken(args = {}) {
  if (args.token && args.token !== true) return String(args.token)
  return `sloth-d2c-${randomUUID()}`
}

function isCodexAppEnvironment(env = process.env) {
  if (env.SLOTH_DISABLE_CODEX_TOKEN_BRIDGE === '1') return false
  return (
    env.CODEX_SHELL === '1' ||
    Boolean(env.CODEX_THREAD_ID) ||
    env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE === 'Codex Desktop' ||
    env.__CFBundleIdentifier === 'com.openai.codex'
  )
}

function d2cDir(workspace, fileKey, nodeId) {
  return path.join(workspace, '.sloth', cleanPart(fileKey, 'file'), cleanPart(nodeId, 'root'))
}

function isWorkbenchFileKey(fileKey) {
  return cleanPart(fileKey, 'file') === '__workbench__'
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

function visibleAgentArgs(agentId) {
  return agentId && agentId !== 'codex' ? ['--agent-id', agentId] : []
}

function visibleShellAgentArgs(agentId) {
  return visibleAgentArgs(agentId).map(shellQuote)
}

function normalizeUrl(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  if (/^https?:\/\//i.test(raw)) return raw
  return `http://${raw}`
}

function comparableUrl(value) {
  const normalized = normalizeUrl(value)
  if (!normalized) return ''
  try {
    const url = new URL(normalized)
    url.hash = ''
    if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/+$/, '')
    return url.toString().replace(/\/$/, '').toLowerCase()
  } catch {
    return normalized.replace(/\/+$/, '').toLowerCase()
  }
}

function codexBrowserOpenContract({ phase, interceptorMode, url, urlSource = 'commands.openUrl', afterOpen, visible = true }) {
  if (!url || interceptorMode === 'silent') return null
  return {
    enabled: true,
    surface: 'codex-in-app-browser',
    skill: 'browser:control-in-app-browser',
    target: 'iab',
    action: 'navigate',
    url,
    urlSource,
    visible,
    keepFor: 'sloth-interceptor',
    afterOpen,
    constraints: [
      'Keep the Codex in-app browser on the Sloth interceptor.',
      'Do not open the generated implementation preview in this browser surface.',
      phase === 'design_prepare'
        ? 'Stop after the interceptor is visible; do not submit or generate for the user.'
        : 'Use this surface only for the Sloth workflow shell and annotation loop.',
    ],
  }
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
  await fs.mkdir(loopDir(workspace, fileKey, nodeId), { recursive: true })
  await fs.appendFile(path.join(loopDir(workspace, fileKey, nodeId), 'events.jsonl'), `${JSON.stringify(event)}\n`, 'utf8')
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
  const targetLoopDir = loopDir(workspace, fileKey, nodeId)
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
  await fs.mkdir(path.join(targetLoopDir, 'snapshots'), { recursive: true })
  await fs.writeFile(path.join(targetD2cDir, 'screenshots', 'index.png'), imageBytes)
  await fs.writeFile(path.join(targetD2cDir, 'absolute.html'), screenshotBackedHtml({ dataUrl, width, height, fileKey, nodeId, sourceUrl: screenshotUrl }), 'utf8')
  await writeJson(path.join(targetD2cDir, 'groupsData.json'), groupsData)
  await fs.writeFile(
    path.join(targetD2cDir, 'chunks', 'figma-mcp-seed.md'),
    `# Figma MCP seed\n\n${note}\n\n- fileKey: ${fileKey}\n- nodeId: ${nodeId || 'root'}\n- screenshot: screenshots/index.png\n- size: ${width}x${height}\n- groups: ${groupsData.length}\n`,
    'utf8',
  )
  await writeJson(path.join(targetLoopDir, 'snapshots', 'v0001.json'), snapshot)
  await writeJson(path.join(targetLoopDir, 'state.json'), state)
  await fs.writeFile(path.join(targetLoopDir, 'events.jsonl'), '', 'utf8')
  await appendEvent(workspace, fileKey, nodeId, event)

  return {
    state,
    event,
    d2cDir: targetD2cDir,
    loopDir: targetLoopDir,
    groupsData,
    files: {
      absoluteHtml: path.join(targetD2cDir, 'absolute.html'),
      groupsData: path.join(targetD2cDir, 'groupsData.json'),
      screenshot: path.join(targetD2cDir, 'screenshots', 'index.png'),
      snapshot: path.join(targetLoopDir, 'snapshots', 'v0001.json'),
      state: path.join(targetLoopDir, 'state.json'),
    },
  }
}

function workbenchHtml({ fileKey, nodeId, implementationUrl }) {
  const title = `Sloth Workbench ${fileKey}/${nodeId || 'root'}`
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
  </head>
  <body style="margin:0;font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f6f8fa;color:#1f2937;">
    <main data-id="workbench-root" data-name="Sloth Workbench" style="box-sizing:border-box;min-height:720px;padding:48px;">
      <section data-id="workbench-session" data-name="Temporary Workbench Session" style="max-width:720px;border:1px solid #d0d7de;background:#fff;border-radius:8px;padding:24px;">
        <h1 style="margin:0 0 12px;font-size:24px;">Sloth Workbench</h1>
        <p style="margin:0 0 10px;line-height:1.6;">This temporary session was opened without a bound Figma design.</p>
        <p style="margin:0;line-height:1.6;">Implementation URL: ${implementationUrl || 'not connected'}</p>
      </section>
    </main>
  </body>
</html>
`
}

function workbenchNodeId(args) {
  if (args.session && args.session !== true) return String(args.session)
  if (args['node-id'] && args['node-id'] !== true) return String(args['node-id'])
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)
  return `tmp-${stamp}-${Math.random().toString(16).slice(2, 8)}`
}

async function seedWorkbenchSession(workspace, args, implementationUrl = '') {
  const fileKey = args['workbench-file-key'] && args['workbench-file-key'] !== true ? String(args['workbench-file-key']) : '__workbench__'
  const nodeId = workbenchNodeId(args)
  const now = new Date().toISOString()
  const targetD2cDir = d2cDir(workspace, fileKey, nodeId)
  const targetLoopDir = loopDir(workspace, fileKey, nodeId)
  const snapshot = {
    snapshotId: 'v0001',
    version: 1,
    fileKey,
    nodeId,
    kind: 'workbench',
    groupsData: [],
    canvasAnnotations: [],
    createdAt: now,
    source: {
      kind: 'workbench',
      reason: 'No matching Sloth D2C design session was found for the implementation.',
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
    workbench: {
      temporary: true,
      reason: snapshot.source.reason,
    },
  }
  const event = {
    id: `evt_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    sessionId: sessionId(fileKey, nodeId),
    version: 1,
    snapshotId: 'v0001',
    type: 'workbench.opened',
    source: 'agent',
    payload: {
      summary: snapshot.source.reason,
      implementationUrl: implementationUrl || undefined,
    },
    createdAt: now,
  }

  await fs.mkdir(path.join(targetD2cDir, 'chunks'), { recursive: true })
  await fs.mkdir(path.join(targetLoopDir, 'snapshots'), { recursive: true })
  await fs.writeFile(path.join(targetD2cDir, 'absolute.html'), workbenchHtml({ fileKey, nodeId, implementationUrl }), 'utf8')
  await writeJson(path.join(targetD2cDir, 'groupsData.json'), [])
  await fs.writeFile(
    path.join(targetD2cDir, 'chunks', 'workbench.md'),
    `# Sloth Workbench\n\nTemporary session for prompt, component mapping, and implementation annotation workflows.\n\n- fileKey: ${fileKey}\n- nodeId: ${nodeId}\n- implementationUrl: ${implementationUrl || 'not connected'}\n`,
    'utf8',
  )
  await writeJson(path.join(targetLoopDir, 'snapshots', 'v0001.json'), snapshot)
  await writeJson(path.join(targetLoopDir, 'state.json'), state)
  await fs.writeFile(path.join(targetLoopDir, 'events.jsonl'), '', 'utf8')
  await appendEvent(workspace, fileKey, nodeId, event)

  return {
    fileKey,
    nodeId,
    state,
    event,
    d2cDir: targetD2cDir,
    loopDir: targetLoopDir,
    files: {
      absoluteHtml: path.join(targetD2cDir, 'absolute.html'),
      groupsData: path.join(targetD2cDir, 'groupsData.json'),
      state: path.join(targetLoopDir, 'state.json'),
      snapshot: path.join(targetLoopDir, 'snapshots', 'v0001.json'),
    },
  }
}

async function resolveImplementationSession(workspace, args, implementationUrl = '') {
  const sessions = await findD2cSessions(workspace)
  const targetComparableUrl = comparableUrl(implementationUrl)
  const candidates = []

  for (const session of sessions) {
    const state = await getState(workspace, session.fileKey, session.nodeId)
    const stateComparableUrl = comparableUrl(state.implementationUrl)
    let score = 0
    const reasons = []
    if (targetComparableUrl && stateComparableUrl && targetComparableUrl === stateComparableUrl) {
      score += 100
      reasons.push('implementationUrl matched existing loop state')
    } else if (targetComparableUrl) {
      continue
    } else if (!targetComparableUrl && state.implementationUrl) {
      score += 40
      reasons.push('session already has an implementationUrl')
    }
    if (session.hasWorkflowState) {
      score += 10
      reasons.push('loop state exists')
    }
    if (session.hasGroupsData) {
      score += 5
      reasons.push('groupsData exists')
    }
    if (session.hasChunks) {
      score += 5
      reasons.push('chunks directory exists')
    }
    if (isWorkbenchFileKey(session.fileKey)) {
      score -= 30
      reasons.push('temporary workbench session')
    }
    if (score <= 0) continue
    candidates.push({
      ...session,
      score,
      confidence: score >= 90 ? 'high' : score >= 50 ? 'medium' : 'low',
      reason: reasons.join('; '),
      state,
      workbench: isWorkbenchFileKey(session.fileKey) || Boolean(state.workbench?.temporary),
    })
  }

  candidates.sort((a, b) => b.score - a.score || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
  const selected = candidates[0] || null
  if (!selected) {
    return {
      mode: 'unresolved',
      confidence: 'none',
      candidates,
      reason: targetComparableUrl
        ? 'No local Sloth D2C session matched the implementation URL.'
        : 'No implementation URL was provided or detected, and no usable Sloth session was selected.',
    }
  }

  return {
    mode: selected.workbench ? 'resolved-workbench-session' : 'resolved-design-session',
    confidence: selected.confidence,
    fileKey: selected.fileKey,
    nodeId: selected.nodeId,
    reason: selected.reason,
    selected,
    candidates,
  }
}

async function detectStandaloneImplementationUrl(args) {
  const candidates = implementationUrlCandidates(args, {})
  for (const url of candidates) {
    const probe = await probeImplementationUrl(url, Number(args['timeout-ms'] || 300))
    if (probe.reachable) {
      return {
        url: probe.url,
        probe,
        detected: true,
      }
    }
  }
  return {
    url: '',
    probe: null,
    detected: false,
  }
}

function interceptorOpenUrlForSession(args, fileKey, nodeId) {
  const workflowToken = createWorkflowToken(args)
  return buildInterceptorUrl({
    host: String(args.host || 'localhost'),
    port: String(args.port || '3100'),
    fileKey,
    nodeId,
    token: workflowToken,
    mode: String(args.mode || 'create'),
    supportSampling: String(args['support-sampling'] || '1'),
    supportRoots: String(args['support-roots'] || '1'),
    dataSource: String(args['data-source'] || 'local'),
    workspace: args.workspace,
  })
}

function askUserIntentResponse(workspace, resolution) {
  return {
    ok: false,
    mode: 'ask-user-intent',
    action: 'ask_user_intent',
    workspace,
    resolution,
    message:
      'Could not infer a Sloth design session or implementation page. Ask whether the user wants to convert code from a design or open the interceptor for an existing implementation page.',
    question:
      '你是要转代码，还是打开拦截页做标注/调提示词？转代码需要 Figma 链接或 Figma 插件里的 fileKey/nodeId；打开拦截页需要项目目录和要标注的页面 URL。',
    options: [
      {
        id: 'convert-code',
        label: '转代码',
        needs: ['Figma 链接，或 fileKey + nodeId', '目标项目目录'],
      },
      {
        id: 'open-interceptor',
        label: '打开拦截页',
        needs: ['目标项目目录', '要标注/调试的页面 URL'],
      },
    ],
  }
}

async function openInterceptor(workspace, args, agentId) {
  const explicitUrl = args.url && args.url !== true ? normalizeUrl(args.url) : ''
  const explicitFileKey = args['file-key'] && args['file-key'] !== true ? String(args['file-key']) : ''
  const explicitNodeId = args['node-id'] && args['node-id'] !== true ? String(args['node-id']) : undefined
  let detectedUrl = { url: explicitUrl, detected: false, probe: null }
  let implementationUrl = explicitUrl
  let resolution = null
  let fileKey
  let nodeId
  let seededWorkbench = null
  let implementationWrite = null

  if (!explicitUrl && !explicitFileKey) {
    resolution = await resolveImplementationSession(workspace, args, '')
    if (resolution.mode !== 'unresolved') {
      implementationUrl = resolution.selected?.state?.implementationUrl || ''
      detectedUrl = { url: implementationUrl, detected: false, probe: null }
    } else {
      detectedUrl = await detectStandaloneImplementationUrl(args)
      implementationUrl = detectedUrl.url
    }
  }

  if (explicitFileKey) {
    fileKey = explicitFileKey
    nodeId = explicitNodeId
    resolution = {
      mode: isWorkbenchFileKey(fileKey) ? 'explicit-workbench-session' : 'explicit-session',
      confidence: 'explicit',
      fileKey,
      nodeId,
      reason: 'User supplied fileKey/nodeId.',
    }
  } else {
    if (!resolution || resolution.mode === 'unresolved') {
      resolution = await resolveImplementationSession(workspace, args, implementationUrl)
    }
    if (resolution.mode === 'unresolved') {
      if (!implementationUrl) {
        return askUserIntentResponse(workspace, resolution)
      }
      const workbenchFileKey = args['workbench-file-key'] && args['workbench-file-key'] !== true ? String(args['workbench-file-key']) : '__workbench__'
      const requestedWorkbenchNodeId = args.session && args.session !== true ? String(args.session) : ''
      if (requestedWorkbenchNodeId && (await pathExists(d2cDir(workspace, workbenchFileKey, requestedWorkbenchNodeId)))) {
        fileKey = workbenchFileKey
        nodeId = requestedWorkbenchNodeId
        resolution = {
          mode: 'resolved-workbench-session',
          confidence: 'explicit',
          fileKey,
          nodeId,
          reason: 'Requested workbench session already exists.',
        }
      } else {
        seededWorkbench = await seedWorkbenchSession(workspace, args, implementationUrl)
        fileKey = seededWorkbench.fileKey
        nodeId = seededWorkbench.nodeId
        resolution = {
          mode: 'temporary-workbench',
          confidence: 'none',
          fileKey,
          nodeId,
          reason:
            'No matching Sloth D2C design session was found. The interceptor is opened as a temporary workbench; the implementation may have been converted by another path.',
          unresolvedReason: resolution.reason,
        }
      }
    } else {
      fileKey = resolution.fileKey
      nodeId = resolution.nodeId
    }
  }

  if (implementationUrl) {
    const state = await getState(workspace, fileKey, nodeId)
    if (comparableUrl(state.implementationUrl) !== comparableUrl(implementationUrl)) {
      implementationWrite = await setImplementationUrl(workspace, {
        ...args,
        'file-key': fileKey,
        'node-id': nodeId,
        url: implementationUrl,
        summary:
          resolution.mode === 'temporary-workbench'
            ? 'Temporary workbench implementation preview connected.'
            : 'Implementation preview connected by open-interceptor.',
      })
    }
  }

  const state = await getState(workspace, fileKey, nodeId)
  const openUrl = interceptorOpenUrlForSession(args, fileKey, nodeId)
  const phase = state.implementationUrl ? 'implementation_loop' : 'workbench'
  const codexTokenBridge =
    openUrl && isCodexAppEnvironment() && !(args.token && args.token !== true)
      ? await ensureCodexTokenBridge({
          workspace,
          fileKey,
          nodeId,
          host: String(args.host || 'localhost'),
          port: String(args.port || '3100'),
          token: new URL(openUrl).searchParams.get('token'),
          agentId,
        })
      : {
          enabled: false,
          status: args.token && args.token !== true ? 'explicit-token' : isCodexAppEnvironment() ? 'no-open-url' : 'not-codex-app',
        }

  return {
    ok: true,
    mode: 'open-interceptor',
    action: 'open_codex_browser_recommended',
    workspace,
    selected: {
      fileKey,
      nodeId,
      sessionId: sessionId(fileKey, nodeId),
      workbench: resolution.mode.includes('workbench') || isWorkbenchFileKey(fileKey),
    },
    resolution,
    implementation: {
      url: state.implementationUrl || '',
      detected: detectedUrl.detected,
      probe: detectedUrl.probe,
      wrote: Boolean(implementationWrite),
    },
    seededWorkbench,
    state,
    interceptorUrl: openUrl,
    codexBrowserOpen: codexBrowserOpenContract({
      phase,
      interceptorMode: 'interactive',
      url: openUrl,
      urlSource: 'open-interceptor.interceptorUrl',
      afterOpen: state.implementationUrl ? 'wait-for-user-annotation' : 'workbench-open',
    }),
    codexTokenBridge,
    recommendedAction: state.implementationUrl
      ? 'Open codexBrowserOpen.url in the Codex in-app browser. The interceptor can be used for implementation annotations, prompt tuning, and component mapping.'
      : 'Open codexBrowserOpen.url in the Codex in-app browser. No implementation URL is connected yet; use set-implementation-url when a preview URL is available.',
    stopCondition:
      'If the user asked to open or operate the Sloth interceptor, continue until codexBrowserOpen.url is opened. If the user only asked to prepare or inspect, return the interceptor context and next command.',
    constraints: ['Do not open the implementation URL in the Codex in-app browser when the Sloth interceptor should stay visible.'],
    commands: {
      setImplementationUrl: commandString([
        'node',
        scriptPath(),
        'set-implementation-url',
        '--workspace',
        workspace,
        '--file-key',
        fileKey,
        ...(nodeId ? ['--node-id', nodeId] : []),
        ...visibleAgentArgs(agentId),
        '--url',
        '<local implementation URL>',
      ]),
      workflowHandoff: commandString([
        'node',
        scriptPath(),
        'workflow-handoff',
        '--workspace',
        workspace,
        '--file-key',
        fileKey,
        ...(nodeId ? ['--node-id', nodeId] : []),
        ...visibleAgentArgs(agentId),
      ]),
      waitNextEvent: commandString([
        'node',
        scriptPath(),
        'wait-next-event',
        '--workspace',
        workspace,
        '--file-key',
        fileKey,
        ...(nodeId ? ['--node-id', nodeId] : []),
        ...visibleAgentArgs(agentId),
      ]),
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
      const statePath = path.join(loopDir(workspace, fileKey, nodeId), 'state.json')
      const key = sessionId(fileKey, nodeId)
      const dirStat = await fs.stat(dir).catch(() => null)
      sessionsByKey.set(key, {
        sessionId: key,
        fileKey,
        nodeId,
        dir,
        hasGroupsData: await pathExists(path.join(dir, 'groupsData.json')),
        hasChunks: await pathExists(path.join(dir, 'chunks')),
        hasWorkflowState: await pathExists(statePath),
        updatedAt: dirStat?.mtime?.toISOString?.(),
      })
    }
  }

  return Array.from(sessionsByKey.values()).sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
}

async function getState(workspace, fileKey, nodeId) {
  const dir = loopDir(workspace, fileKey, nodeId)
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
  await writeJson(path.join(loopDir(workspace, state.fileKey, state.nodeId), 'state.json'), state)
}

async function getPendingEvents(workspace, fileKey, nodeId, agentId, source = 'human') {
  const state = await getState(workspace, fileKey, nodeId)
  const progress = state.agents?.[agentId] || {
    processedUntilVersion: 0,
    processedEventIds: [],
  }
  const processed = new Set(progress.processedEventIds || [])
  const events = await readJsonl(path.join(loopDir(workspace, fileKey, nodeId), 'events.jsonl'))
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
    throw new Error('No Sloth D2C workflows found. Run sloth d2c first or pass --file-key and --node-id.')
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

function shouldSkipInterceptor(args = {}) {
  return args.silent === true || args.silent === 'true'
}

function interceptorDataSource(args = {}) {
  return shouldUseLocalDesignData(args) ? 'local' : 'restful'
}

function buildInterceptorUrl({ host = 'localhost', port = '3100', fileKey, nodeId, token, mode = 'create', supportSampling = '1', supportRoots = '1', dataSource = 'restful', workspace }) {
  const url = new URL(`http://${host}:${port}/auth-page`)
  url.searchParams.set('token', token)
  url.searchParams.set('fileKey', fileKey)
  if (nodeId) url.searchParams.set('nodeId', nodeId)
  url.searchParams.set('mode', mode)
  url.searchParams.set('supportSampling', supportSampling)
  url.searchParams.set('supportRoots', supportRoots)
  url.searchParams.set('dataSource', dataSource)
  if (workspace) url.searchParams.set('workspaceRoot', path.resolve(workspace))
  return url.toString()
}

async function validateMcpToken({ host, port, token, timeoutMs = 700 }) {
  if (!token) return { valid: false, checked: false, reason: 'missing-token' }
  try {
    const url = new URL(`http://${host}:${port}/validateToken`)
    url.searchParams.set('token', token)
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' },
    })
    if (!response.ok) return { valid: false, checked: true, status: response.status }
    const result = await response.json()
    return { valid: Boolean(result?.valid), checked: true, status: response.status }
  } catch (error) {
    return {
      valid: false,
      checked: false,
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}

async function ensureCodexTokenBridge({ workspace, host, port, token, agentId }) {
  const validation = await validateMcpToken({ host, port, token })
  if (validation.valid) {
    return {
      enabled: true,
      status: 'already-valid',
      token,
      validation,
    }
  }
  if (validation.checked === false && validation.reason) {
    return {
      enabled: true,
      status: 'unavailable',
      token,
      validation,
    }
  }

  const socketPort = Number(port) + 1
  const childSource = String.raw`
const net = require('node:net');
const token = process.env.SLOTH_CODEX_TOKEN;
const host = process.env.SLOTH_CODEX_HOST || 'localhost';
const socketPort = Number(process.env.SLOTH_CODEX_SOCKET_PORT || 3101);
const extra = JSON.parse(process.env.SLOTH_CODEX_EXTRA || '{}');

function finish(code) {
  process.exit(code);
}

const socket = net.createConnection({ host, port: socketPort }, () => {
  socket.write(JSON.stringify({ type: 'register-token', token, extra, timestamp: Date.now() }) + '\n');
});

socket.setEncoding('utf8');
let buffer = '';
socket.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split('\n');
  buffer = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const message = JSON.parse(line);
      if (message.type === 'submit-response' && message.token === token) finish(0);
    } catch {}
  }
});
socket.on('error', (error) => {
  finish(1);
});
socket.on('close', () => {
  finish(0);
});
setInterval(() => {
  try { socket.write(JSON.stringify({ type: 'ping', timestamp: Date.now() }) + '\n'); } catch {}
}, 30000);
`
  const child = spawn(process.execPath, ['-e', childSource], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      SLOTH_CODEX_TOKEN: token,
      SLOTH_CODEX_HOST: host,
      SLOTH_CODEX_SOCKET_PORT: String(socketPort),
      SLOTH_CODEX_EXTRA: JSON.stringify({
        workspaceRoot: workspace,
        source: 'codex-app-sloth-workflow',
        agentId,
      }),
    },
  })
  child.unref()
  return {
    enabled: true,
    status: 'started',
    token,
    pid: child.pid,
    validation,
  }
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
  const events = await readJsonl(path.join(loopDir(workspace, fileKey, nodeId), 'events.jsonl'))
  const actionablePendingEvents = pending.events.filter(isActionableWorkflowEvent)
  const workflowPhase = deriveWorkflowPhase(state, events, actionablePendingEvents)
  const chunks = await listChunks(workspace, fileKey, nodeId)
  const workflowToken = createWorkflowToken(args)
  const interceptorUrl = buildInterceptorUrl({
    host: String(args.host || 'localhost'),
    port: String(args.port || '3100'),
    fileKey,
    nodeId,
    token: workflowToken,
    mode: String(args.mode || 'create'),
    supportSampling: String(args['support-sampling'] || '1'),
    supportRoots: String(args['support-roots'] || '1'),
    dataSource: interceptorDataSource(args),
    workspace,
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
          token: workflowToken,
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
  const events = await readJsonl(path.join(loopDir(workspace, fileKey, nodeId), 'events.jsonl'))
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
  await writeJson(path.join(loopDir(workspace, fileKey, nodeId), 'state.json'), nextState)
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
  await fs.mkdir(loopDir(workspace, fileKey, nodeId), { recursive: true })
  await fs.appendFile(path.join(loopDir(workspace, fileKey, nodeId), 'events.jsonl'), `${JSON.stringify(event)}\n`, 'utf8')
  const nextState = {
    ...state,
    updatedAt: event.createdAt,
  }
  await writeJson(path.join(loopDir(workspace, fileKey, nodeId), 'state.json'), nextState)
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

function buildSlothD2cHandoffArgs(fileKey, nodeId, framework = 'react', args = {}) {
  return [
    'd2c',
    '--file-key',
    fileKey,
    ...(nodeId ? ['--node-id', nodeId] : []),
    '--framework',
    framework || 'react',
    ...(shouldUseLocalDesignData(args) ? ['--local'] : []),
    '--json',
  ]
}

function previewOutput(value, maxChars = 6000) {
  const raw = String(value || '')
  if (raw.length <= maxChars) return raw
  return `${raw.slice(0, maxChars)}\n...<truncated ${raw.length - maxChars} chars>`
}

function parseJsonCommandOutput(stdout) {
  const raw = String(stdout || '').trim()
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {}

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1].trim())
    } catch {}
  }

  const objectStart = raw.indexOf('{')
  const objectEnd = raw.lastIndexOf('}')
  if (objectStart >= 0 && objectEnd > objectStart) {
    try {
      return JSON.parse(raw.slice(objectStart, objectEnd + 1))
    } catch {}
  }

  return null
}

const SLOTH_CLI_INSTALL = {
  pnpm: 'pnpm install -g sloth-d2c-mcp --registry=https://registry.npmjs.org/',
  npm: 'npm install -g sloth-d2c-mcp --registry=https://registry.npmjs.org/',
}

async function resolveSlothCliStatus() {
  try {
    await execFileAsync('sloth', ['--version'], { timeout: 5000 })
    return { available: true }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      return { available: true, warning: error?.message || String(error) }
    }
  }

  return {
    available: false,
    install: { ...SLOTH_CLI_INSTALL },
    verifyCommand: 'sloth --version',
    message:
      'Sloth CLI 未安装。先运行 commands.installSlothPnpm（有 pnpm 时）或 commands.installSlothNpm，再运行 commands.verifySloth，然后重新执行 workflow-handoff。',
  }
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
  const outputDir = resolveWorkspacePath(workspace, args['output-dir']) || path.join(d2cDir(workspace, fileKey, nodeId), 'screenshots', 'diff')
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
  const outputDir = resolveWorkspacePath(workspace, args['output-dir']) || path.join(d2cDir(workspace, fileKey, nodeId), 'screenshots', 'implementation')
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
  return readJson(path.join(loopDir(workspace, fileKey, nodeId), 'snapshots', `${snapshotId}.json`), null)
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
  const events = await readJsonl(path.join(loopDir(workspace, fileKey, nodeId), 'events.jsonl'))
  const event = events.find((item) => item.id === eventId)
  if (!event) throw new Error(`Event not found: ${eventId}`)

  const groupIndices = eventGroupIndices(event)
  const annotationIds = eventAnnotationIds(event)
  const payloadChangedCanvasAnnotations = Array.isArray(event?.payload?.changedCanvasAnnotations) ? event.payload.changedCanvasAnnotations : []
  const needsSnapshotForAnnotations = annotationIds.length > 0 && payloadChangedCanvasAnnotations.length === 0
  const needsSnapshot = groupIndices.length > 0 || needsSnapshotForAnnotations
  const snapshot = needsSnapshot ? await readSnapshot(workspace, fileKey, nodeId, event.snapshotId || state.latestSnapshotId) : null
  const groupsData = groupIndices.length
    ? Array.isArray(snapshot?.groupsData)
      ? snapshot.groupsData
      : await readJson(path.join(d2cDir(workspace, fileKey, nodeId), 'groupsData.json'), [])
    : []
  const groups = groupIndices.length ? groupsData.filter((group) => groupIndices.includes(Number(group.groupIndex))) : []
  const canvasAnnotations = needsSnapshotForAnnotations
    ? Array.isArray(snapshot?.canvasAnnotations)
      ? snapshot.canvasAnnotations
      : Array.isArray(event?.payload?.canvasAnnotations)
        ? event.payload.canvasAnnotations
        : []
    : []
  const payloadChangedById = new Map(payloadChangedCanvasAnnotations.map((annotation) => [String(annotation?.id || ''), annotation]).filter(([id]) => id))
  const changedCanvasAnnotations = payloadChangedCanvasAnnotations.length
    ? annotationIds.length
      ? annotationIds.map((id) => payloadChangedById.get(id)).filter(Boolean)
      : payloadChangedCanvasAnnotations
    : annotationIds.length
      ? annotationIds.map((id) => canvasAnnotations.find((annotation) => String(annotation?.id || '') === id)).filter(Boolean)
      : []
  const chunks = await listChunks(workspace, fileKey, nodeId)

  return {
    state,
    event,
    snapshot: snapshot
      ? {
          snapshotId: snapshot.snapshotId,
          version: snapshot.version,
          createdAt: snapshot.createdAt,
          kind: snapshot.kind,
          groupCount: Array.isArray(snapshot.groupsData) ? snapshot.groupsData.length : snapshot.groupCount || 0,
          annotationCount: Array.isArray(snapshot.canvasAnnotations) ? snapshot.canvasAnnotations.length : snapshot.canvasAnnotationCount || 0,
        }
      : null,
    changedGroupIndices: groupIndices,
    groups,
    changedAnnotationIds: annotationIds,
    changedCanvasAnnotations,
    canvasAnnotationCount: Array.isArray(canvasAnnotations) ? canvasAnnotations.length : 0,
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
    ...visibleShellAgentArgs(agentId),
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
    ...visibleShellAgentArgs(agentId),
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
      canvasAnnotationCount: context.canvasAnnotationCount,
      d2cDir: root,
      absoluteHtml,
      screenshots,
      groupScreenshots: relatedGroupScreenshots,
      chunks,
      implementationScreenshot,
      instructions: [
        'Start from eventBrief.event, eventBrief.changedCanvasAnnotations, and eventBrief.groups. Do not rescan unrelated historical annotations unless this event requires it.',
        'Use the shortest useful repair path. Do not capture screenshots or run visual-compare unless the event explicitly asks for visual fidelity or the code change cannot be checked otherwise.',
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
        'For small annotation fixes, skip claim-event and handle the event directly; use claim-event only before genuinely long-running work.',
        'Handle only eventBrief.changedCanvasAnnotations for this event. When target is implementation, treat coordinates as relative to the generated preview pane.',
        'Edit the local implementation until the submitted annotations are satisfied.',
        'Run one narrow useful check. Do not capture screenshots or run design-diff/visual-compare for ordinary interaction, copy, spacing, or style fixes unless the annotation explicitly requires it.',
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
  const slothCli = await resolveSlothCliStatus()
  const fileKey = status.selected.fileKey
  const nodeId = status.selected.nodeId
  const baseArgs = [
    '--workspace',
    workspace,
    '--file-key',
    fileKey,
    ...(nodeId ? ['--node-id', nodeId] : []),
    ...visibleAgentArgs(agentId),
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
  const skipInterceptor = shouldSkipInterceptor(args)
  const shouldStartDevInterceptor = phase === 'design_prepare' && status.devMode && !status.devInterceptorUrl && !skipInterceptor
  const openUrl = shouldStartDevInterceptor ? null : status.preferredInterceptorUrl || status.devInterceptorUrl || status.interceptorUrl
  const explicitToken = args.token && args.token !== true ? String(args.token) : ''
  const shouldBridgeOpenUrl = phase !== 'design_prepare' && openUrl && isCodexAppEnvironment() && !explicitToken
  const codexTokenBridge =
    shouldBridgeOpenUrl
      ? await ensureCodexTokenBridge({
          workspace,
          fileKey,
          nodeId,
          host: String(args.host || 'localhost'),
          port: String(args.port || '3100'),
          token: new URL(openUrl).searchParams.get('token'),
          agentId,
        })
      : {
          enabled: false,
          status: explicitToken
            ? 'explicit-token'
            : phase === 'design_prepare'
              ? 'handled-by-prepare-first-run'
              : isCodexAppEnvironment()
                ? 'no-open-url'
                : 'not-codex-app',
        }
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
  const prepareFirstRunCommand = commandString([
    'sloth',
    ...buildSlothD2cHandoffArgs(fileKey, nodeId, String(args.framework || 'react'), args),
  ])
  const rawSlothD2cCommand = commandString([
    'sloth',
    ...buildSlothD2cArgs(fileKey, nodeId, String(args.framework || 'react'), args),
  ])
  const rawSlothD2cDevFallbackCommand = commandString([
    'node',
    path.resolve(process.cwd(), 'apps', 'd2c-mcp', 'cli', 'run.js'),
    ...buildSlothD2cArgs(fileKey, nodeId, String(args.framework || 'react'), args),
  ])
  const recommendedActionByPhase = {
    design_prepare: skipInterceptor
      ? 'Run commands.rawSlothD2c (or commands.generateChunks when chunks are incomplete) to fetch design data and generate chunk prompts silently. Do not open the interceptor or wait for workflow.submitted. After chunks/codeAggregation/finalGenerate exist, continue directly to first implementation generation in the same turn.'
      : shouldStartDevInterceptor
      ? 'Start the Sloth workflow dev launcher, rerun workflow-handoff, then run commands.prepareFirstRun. Open the returned codexHandoff.interceptorUrl in the Codex in-app browser and end this Codex turn. Do not click Submit/Generate or trigger the form for the user. Use shell open/system default browser/Chrome only if the Codex in-app browser is unavailable or control fails.'
      : 'Run commands.prepareFirstRun first. It runs sloth d2c in Codex handoff mode to prepare REST/local design data without opening Chrome or blocking for submit. Then open the returned codexHandoff.interceptorUrl in the Codex in-app browser, confirm it is visible, and end this Codex turn. Do not inspect controls and submit on the user’s behalf.',
    initial_generation_requested: skipInterceptor
      ? initialChunkStatus.needsSlothD2c
        ? 'Before writing implementation code, run commands.rawSlothD2c or commands.generateChunks to refresh chunk prompts. Do not open the interceptor. After chunks/codeAggregation/finalGenerate exist, follow the chunk prompts in order (group chunks, then codeAggregation.md, then finalGenerate.md), create real project components/styles/assets, start the target app preview, and write implementationUrl if loop mode is still needed later. Do not deliver by embedding absolute.html, raw HTML, iframe, srcDoc, dangerouslySetInnerHTML, or a scaled static wrapper.'
        : 'Follow the existing Sloth D2C chunk prompts in order (group chunks, then codeAggregation.md, then finalGenerate.md) to generate real project components/styles/assets, start the target app preview, and write implementationUrl if loop mode is still needed later. Do not open the interceptor during first generation. Do not deliver by embedding absolute.html, raw HTML, iframe, srcDoc, dangerouslySetInnerHTML, or a scaled static wrapper.'
      : initialChunkStatus.needsSlothD2c
      ? 'Before writing implementation code, run the sloth d2c atomic command to generate submitted group chunks/prompts. Do not hand-write the initial implementation from screenshots while chunks are missing. After chunks/codeAggregation/finalGenerate exist, claim the workflow.submitted event, follow the chunk prompts in order (group chunks, then codeAggregation.md, then finalGenerate.md), create real project components/styles/assets, start the target app preview, write implementationUrl, keep or reopen the Sloth interceptor in the Codex in-app browser, then complete the event. Do not deliver by embedding absolute.html, raw HTML, iframe, srcDoc, dangerouslySetInnerHTML, or a scaled static wrapper.'
      : 'Claim the workflow.submitted event, follow the existing Sloth D2C chunk prompts in order (group chunks, then codeAggregation.md, then finalGenerate.md) to generate real project components/styles/assets, start the target app preview, write implementationUrl, keep or reopen the Sloth interceptor in the Codex in-app browser, then complete the workflow.submitted event. Do not navigate the in-app browser directly to the target preview URL. Do not deliver by embedding absolute.html, raw HTML, iframe, srcDoc, dangerouslySetInnerHTML, or a scaled static wrapper.',
    initial_generating: skipInterceptor
      ? 'Continue the silent first generation path until a reachable implementation preview URL is available, then write implementationUrl if loop mode is still needed later. Do not open the interceptor during first generation.'
      : 'Continue the first generation path until a reachable implementation preview URL is available, then write implementationUrl so the interceptor can enter loop mode. Keep the Codex in-app browser on the Sloth interceptor.',
    implementation_loop: 'Open the interceptor loop page and wait for the user to save generated-preview annotations.',
    implementation_annotations_requested: 'Handle the returned generated-preview annotation eventBrief, edit code, run checks, then run complete-event.',
    design_diff_requested: 'Handle the returned design diff eventBrief, compare the design and implementation, edit code, run checks, then run complete-event.',
    legacy_repair_requested: 'Handle the returned legacy repair eventBrief, edit code, run checks, then run complete-event.',
  }
  const phaseRecommendedAction =
    recommendedActionByPhase[phase] ||
    (firstPending
      ? 'Handle the returned eventBrief, edit code, run checks, then run complete-event.'
      : 'Open the interceptor URL in the Codex in-app browser, let the user annotate, then run wait-next-event.')
  const codexBrowserOpen = codexBrowserOpenContract({
    phase,
    interceptorMode: skipInterceptor ? 'silent' : 'interactive',
    url: openUrl,
    urlSource: phase === 'design_prepare' ? 'commands.prepareFirstRun.codexHandoff.interceptorUrl' : 'commands.openUrl',
    afterOpen:
      phase === 'design_prepare'
        ? 'return-to-user'
        : firstPending
          ? 'keep-open-while-handling-event'
          : 'wait-for-user-annotation',
  })

  return {
    ...status,
    slothCli,
    interceptorMode: skipInterceptor ? 'silent' : 'interactive',
    nextEvent: firstPending || null,
    eventBrief: firstBrief,
    repairBrief: firstBrief,
    initialGeneration: {
      chunkStatus: initialChunkStatus,
      mustRunSlothD2cBeforeCoding: phase === 'initial_generation_requested' && initialChunkStatus.needsSlothD2c,
    },
    codexBrowserOpen,
    codexTokenBridge,
    stopCondition: !slothCli.available
      ? 'Install Sloth CLI, verify with commands.verifySloth, then rerun workflow-handoff.'
      : phase === 'design_prepare'
        ? skipInterceptor
          ? 'Do not open the interceptor. Stop only after chunks/codeAggregation/finalGenerate exist and first implementation generation has started or completed.'
          : 'Stop after commands.prepareFirstRun returns a codexHandoff.interceptorUrl and that URL is opened in the Codex in-app browser. Do not click Submit/Generate, do not use DOM selectors or coordinates to submit, and do not start chunks/code generation. Resume only when the user asks Codex to continue after submitting the first workflow.'
        : undefined,
    recommendedAction: slothCli.available ? phaseRecommendedAction : slothCli.message,
    commands: {
      openUrl,
      fallbackOpenUrl: status.interceptorUrl,
      installSlothPnpm: SLOTH_CLI_INSTALL.pnpm,
      installSlothNpm: SLOTH_CLI_INSTALL.npm,
      verifySloth: slothCli.verifyCommand || 'sloth --version',
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
      prepareFirstRun: skipInterceptor ? null : prepareFirstRunCommand,
      firstRun: skipInterceptor ? rawSlothD2cCommand : prepareFirstRunCommand,
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

async function prepareInterceptor(workspace, args, agentId) {
  const handoff = await workflowHandoff(workspace, args, agentId)
  const phase = handoff.workflowPhase?.phase || 'design_prepare'

  if (handoff.slothCli?.available === false) {
    return {
      ok: false,
      mode: 'install-sloth-cli',
      action: 'install_sloth_cli',
      selected: handoff.selected,
      slothCli: handoff.slothCli,
      command: handoff.commands.installSlothPnpm,
      stopCondition: handoff.stopCondition,
      message: handoff.slothCli.message,
    }
  }

  if (handoff.interceptorMode === 'silent') {
    return {
      ok: false,
      mode: 'silent-first-run',
      action: 'run_silent_first_generation',
      selected: handoff.selected,
      command: handoff.commands.firstRun,
      stopCondition: 'Silent mode does not open the Sloth interceptor.',
      message: 'Silent mode should run first generation directly; prepare-interceptor is only for the interactive Codex browser path.',
    }
  }

  if (phase !== 'design_prepare') {
    return {
      ok: true,
      mode: phase,
      action: handoff.nextEvent ? 'handle_pending_event' : 'continue_existing_workflow',
      selected: handoff.selected,
      workflowPhase: handoff.workflowPhase,
      nextEvent: handoff.nextEvent,
      eventBrief: handoff.eventBrief,
      interceptorUrl: handoff.commands.openUrl,
      codexBrowserOpen: handoff.codexBrowserOpen,
      stopCondition: 'Do not run first-run preparation again; continue from the returned workflow phase.',
      handoff,
    }
  }

  if (handoff.commands.startWorkflowDev && !handoff.commands.openUrl) {
    return {
      ok: false,
      mode: 'start-workflow-dev',
      action: 'start_workflow_dev_then_retry',
      selected: handoff.selected,
      command: handoff.commands.startWorkflowDev,
      stopCondition: 'Start the workflow dev interceptor, then rerun prepare-interceptor.',
      message: 'No Sloth workflow dev interceptor is available yet.',
    }
  }

  const fileKey = handoff.selected.fileKey
  const nodeId = handoff.selected.nodeId
  const framework = String(args.framework || 'react')
  const d2cArgs = buildSlothD2cHandoffArgs(fileKey, nodeId, framework, args)
  const command = commandString(['sloth', ...d2cArgs])
  const env = { ...process.env, SLOTH_WORKSPACE_ROOT: workspace }
  let run

  try {
    run = await execFileAsync('sloth', d2cArgs, {
      cwd: workspace,
      env,
      maxBuffer: 30 * 1024 * 1024,
    })
  } catch (error) {
    return {
      ok: false,
      mode: 'prepare-interceptor',
      action: 'fix_prepare_first_run_failure',
      selected: handoff.selected,
      command,
      exitCode: error?.code,
      stdoutPreview: previewOutput(error?.stdout),
      stderrPreview: previewOutput(error?.stderr || error?.message),
      message: 'Sloth first-run preparation failed.',
    }
  }

  const parsed = parseJsonCommandOutput(run.stdout)
  const codexHandoff = parsed?.codexHandoff || null
  const interceptorUrl = codexHandoff?.interceptorUrl || parsed?.interceptorUrl || ''
  if (!interceptorUrl) {
    return {
      ok: false,
      mode: 'prepare-interceptor',
      action: 'inspect_prepare_first_run_output',
      selected: handoff.selected,
      command,
      stdoutPreview: previewOutput(run.stdout),
      stderrPreview: previewOutput(run.stderr),
      message: 'Sloth first-run preparation did not return codexHandoff.interceptorUrl.',
    }
  }

  return {
    ok: true,
    mode: 'prepare-interceptor',
    action: 'open_codex_browser_and_stop',
    selected: handoff.selected,
    workflowPhase: handoff.workflowPhase,
    command,
    interceptorUrl,
    codexHandoff: {
      prepared: codexHandoff?.prepared,
      reason: codexHandoff?.reason,
      d2cDir: codexHandoff?.d2cDir,
      copiedFiles: codexHandoff?.copiedFiles,
      bridge: codexHandoff?.bridge,
    },
    codexBrowserOpen: codexBrowserOpenContract({
      phase,
      interceptorMode: 'interactive',
      url: interceptorUrl,
      urlSource: 'prepare-interceptor.codexHandoff.interceptorUrl',
      afterOpen: 'return-to-user',
    }),
    stopCondition:
      'Open codexBrowserOpen.url in the Codex in-app browser, confirm the Sloth interceptor is visible, then stop for the user to submit grouping/config.',
    forbidden: ['submit_interceptor', 'generate_code', 'poll_event', 'write_implementation_url'],
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
  const needsSlothCliInstall = handoff.slothCli?.available === false
  const skipInterceptor = handoff.interceptorMode === 'silent'
  return {
    workspace,
    selected: handoff.selected,
    state: handoff.state,
    workflowPhase: handoff.workflowPhase,
    pendingEvents: handoff.pendingEvents,
    allPendingEvents: handoff.allPendingEvents,
    slothCli: handoff.slothCli,
    interceptorMode: handoff.interceptorMode,
    codexBrowserOpen: handoff.codexBrowserOpen,
    mode: needsSlothCliInstall ? 'install-sloth-cli' : skipInterceptor && isFirstRunWaiting ? 'silent-first-run' : hasPendingEvent ? 'handle-pending-event' : phase,
    guide: [
      ...(needsSlothCliInstall
        ? [
            {
              step: 'install-sloth-cli',
              status: 'ready',
              action: handoff.recommendedAction,
              command: handoff.commands.installSlothPnpm,
              doneWhen: 'commands.verifySloth succeeds, then workflow-handoff returns slothCli.available=true.',
            },
          ]
        : []),
      {
        step: skipInterceptor && isFirstRunWaiting ? 'generate-chunks-silently' : isFirstRunWaiting ? 'prepare-first-run' : 'open-interceptor',
        status: needsSlothCliInstall ? 'blocked' : 'ready',
        action: skipInterceptor && isFirstRunWaiting
          ? 'Run commands.firstRun to generate chunks/prompts silently, then continue directly to first implementation generation. Do not open the interceptor or wait for workflow.submitted.'
          : needsDevInterceptor
          ? 'Start the Sloth workflow dev launcher, rerun workflow-handoff, then run commands.prepareFirstRun. Open the returned codexHandoff.interceptorUrl in the Codex in-app browser, then stop for the user. Do not click Submit/Generate or trigger the form. Use shell open/system default browser/Chrome only if the Codex in-app browser is unavailable or control fails.'
          : isInitialGeneration
          ? skipInterceptor
            ? 'Generate the first implementation directly from chunks/prompts. Do not open the interceptor during first generation.'
            : 'Keep the existing Sloth interceptor open while Codex performs the first generation.'
          : 'Run commands.prepareFirstRun to prepare design data, then open the returned codexHandoff.interceptorUrl in the Codex in-app browser, then stop for the user. Do not click Submit/Generate or trigger the form. Use shell open/system default browser/Chrome only if the Codex in-app browser is unavailable or control fails.',
        url: skipInterceptor && isFirstRunWaiting ? null : handoff.commands.openUrl,
        codexBrowserOpen: handoff.codexBrowserOpen,
        command: skipInterceptor && isFirstRunWaiting
          ? handoff.commands.firstRun
          : isFirstRunWaiting
            ? needsDevInterceptor
              ? handoff.commands.startWorkflowDev
              : handoff.commands.prepareFirstRun
            : null,
        doneWhen: skipInterceptor && isFirstRunWaiting
          ? 'commands.firstRun returns ok=true with chunksDir, and first implementation generation has started or completed without opening the interceptor.'
          : needsDevInterceptor
          ? 'workflow-handoff returns commands.openUrl.'
          : isFirstRunWaiting
            ? 'commands.prepareFirstRun returns ok=true with codexHandoff.interceptorUrl, and that URL is open in the Codex in-app browser.'
            : 'The browser shows Sloth D2C 工作台 and the header session version matches this state.',
      },
      {
        step: 'wait-or-handle-event',
        status: hasPendingEvent ? 'ready' : isFirstRunWaiting ? 'return-to-user' : 'waiting',
        action: hasPendingEvent
          ? phase === 'initial_generation_requested'
            ? needsInitialChunks
              ? 'Run sloth d2c first to generate chunks/prompts for the submitted groups, then claim the workflow.submitted event and generate the first implementation by following those prompts in order: group chunks, codeAggregation.md, then finalGenerate.md. Output real project components/styles/assets. Do not wrap absolute.html or raw HTML.'
              : 'Claim the workflow.submitted event, then generate the first implementation by following existing Sloth D2C prompts in order: group chunks, codeAggregation.md, then finalGenerate.md. Output real project components/styles/assets. Do not wrap absolute.html or raw HTML.'
            : 'Claim the returned pending event, then handle the eventBrief.'
          : isFirstRunWaiting
            ? skipInterceptor
              ? 'Continue first implementation generation from chunks/prompts in the same turn. Do not open the interceptor.'
              : 'Do not poll here. End the turn after opening the interceptor; the user will submit the first workflow and ask Codex to continue.'
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
            ? skipInterceptor
              ? 'Initial code exists as real project components/styles/assets, chunks were consumed, and the interceptor was not opened during first generation.'
              : 'The user can see the first-run interceptor and Codex has reported that it is waiting for a later continuation.'
            : 'wait-next-event returns timedOut=false with nextEvent and eventBrief.',
      },
      {
        step: 'inspect-event',
        status: hasPendingEvent ? 'pending-work' : isFirstRunWaiting ? 'not-started-until-user-submit' : 'blocked-until-event',
        action: phase === 'initial_generation_requested'
          ? needsInitialChunks
            ? 'Do not inspect app code yet. First run sloth d2c and verify chunks/codeAggregation/finalGenerate exist. Then follow those generated prompts/chunks in order to create the initial implementation as normal project code. absolute.html is only a reference; do not embed it.'
            : 'Use the submitted groups, annotations, screenshots, and Sloth-generated chunks/prompts in order to create the initial implementation as normal project code. Do not write implementationUrl until the target app preview is reachable. Keep the Codex in-app browser on the Sloth interceptor; do not navigate it to the target preview. absolute.html is only a reference; do not embed it.'
          : isFirstRunWaiting
            ? 'No code inspection yet. The first actionable context appears after workflow.submitted.'
            : 'Inspect the event brief, edit code, run one narrow useful check, and avoid visual diff unless explicitly needed.',
        command: hasPendingEvent ? handoff.commands.eventBrief : isFirstRunWaiting ? null : handoff.commands.eventBrief,
        doneWhen: phase === 'initial_generation_requested'
          ? 'Initial code exists as real project components/styles/assets, it is not an absolute.html/raw HTML wrapper, the target app preview is running, implementationUrl has been written, and the Sloth interceptor is still the visible Codex browser surface.'
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
          ...visibleAgentArgs(agentId),
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

  if (command === 'prepare-interceptor') {
    printJson(await prepareInterceptor(workspace, args, agentId))
    return
  }

  if (command === 'open-interceptor') {
    printJson(await openInterceptor(workspace, args, agentId))
    return
  }

  if (command === 'workflow-guide') {
    printJson(await workflowGuide(workspace, args, agentId))
    return
  }

  if (command === 'interceptor-url') {
    const selected = await resolveSession(workspace, args)
    const workflowToken = createWorkflowToken(args)
    process.stdout.write(
      `${buildInterceptorUrl({
        host: String(args.host || 'localhost'),
        port: String(args.port || '3100'),
        fileKey: selected.fileKey,
        nodeId: selected.nodeId,
        token: workflowToken,
        mode: String(args.mode || 'create'),
        supportSampling: String(args['support-sampling'] || '1'),
        supportRoots: String(args['support-roots'] || '1'),
        dataSource: interceptorDataSource(args),
        workspace,
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
