#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
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

function workDir(workspace, fileKey, nodeId) {
  return path.join(d2cDir(workspace, fileKey, nodeId), 'work')
}

function createWorkflowToken(args = {}) {
  if (args.token && args.token !== true) return String(args.token)
  return `sloth-d2c-${randomUUID()}`
}

function isCodexAppEnvironment(env = process.env) {
  return String(env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE || '')
    .trim()
    .toLowerCase() === 'codex desktop'
}

function d2cDir(workspace, fileKey, nodeId) {
  return path.join(workspace, '.sloth', cleanPart(fileKey, 'file'), cleanPart(nodeId, 'root'))
}

function submissionPath(workspace, fileKey, nodeId) {
  return path.join(d2cDir(workspace, fileKey, nodeId), 'submission.json')
}

async function readSubmission(workspace, fileKey, nodeId) {
  const markerPath = submissionPath(workspace, fileKey, nodeId)
  const marker = await readJson(markerPath, null)
  return marker
    ? {
        ...marker,
        path: markerPath,
      }
    : null
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
        ? 'After the interceptor is visible, run the blocking wait command returned by prepare-interceptor; do not submit or generate for the user.'
        : 'Use this surface only for the Sloth workflow shell and annotation work.',
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

async function appendEvent(workspace, fileKey, nodeId, event) {
  await fs.mkdir(workDir(workspace, fileKey, nodeId), { recursive: true })
  await fs.appendFile(path.join(workDir(workspace, fileKey, nodeId), 'events.jsonl'), `${JSON.stringify(event)}\n`, 'utf8')
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
  const targetWorkDir = workDir(workspace, fileKey, nodeId)
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
    workId: sessionId(fileKey, nodeId),
    fileKey,
    nodeId,
    currentVersion: 1,
    createdAt: now,
    updatedAt: now,
    latestSnapshotId: 'v0001',
    handledEventIds: [],
    workbench: {
      temporary: true,
      reason: snapshot.source.reason,
    },
  }
  const event = {
    id: `evt_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    workId: sessionId(fileKey, nodeId),
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
  await fs.mkdir(path.join(targetWorkDir, 'snapshots'), { recursive: true })
  await fs.writeFile(path.join(targetD2cDir, 'absolute.html'), workbenchHtml({ fileKey, nodeId, implementationUrl }), 'utf8')
  await writeJson(path.join(targetD2cDir, 'groupsData.json'), [])
  await fs.writeFile(
    path.join(targetD2cDir, 'chunks', 'workbench.md'),
    `# Sloth Workbench\n\nTemporary session for prompt, component mapping, and implementation annotation workflows.\n\n- fileKey: ${fileKey}\n- nodeId: ${nodeId}\n- implementationUrl: ${implementationUrl || 'not connected'}\n`,
    'utf8',
  )
  await writeJson(path.join(targetWorkDir, 'snapshots', 'v0001.json'), snapshot)
  await writeJson(path.join(targetWorkDir, 'state.json'), state)
  await fs.writeFile(path.join(targetWorkDir, 'events.jsonl'), '', 'utf8')
  await appendEvent(workspace, fileKey, nodeId, event)

  return {
    fileKey,
    nodeId,
    state,
    event,
    d2cDir: targetD2cDir,
    workDir: targetWorkDir,
    files: {
      absoluteHtml: path.join(targetD2cDir, 'absolute.html'),
      groupsData: path.join(targetD2cDir, 'groupsData.json'),
      state: path.join(targetWorkDir, 'state.json'),
      snapshot: path.join(targetWorkDir, 'snapshots', 'v0001.json'),
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
      reasons.push('implementationUrl matched existing work state')
    } else if (targetComparableUrl) {
      continue
    } else if (!targetComparableUrl && state.implementationUrl) {
      score += 40
      reasons.push('session already has an implementationUrl')
    }
    if (session.hasWorkflowState) {
      score += 10
      reasons.push('work state exists')
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
    useBySkills: workflowUseBySkills(args),
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

async function openInterceptor(workspace, args) {
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
  const phase = state.implementationUrl ? 'implementation_work' : 'workbench'

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
      ]),
    },
  }
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
      const statePath = path.join(workDir(workspace, fileKey, nodeId), 'state.json')
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
  const dir = workDir(workspace, fileKey, nodeId)
  const statePath = path.join(dir, 'state.json')
  const existing = await readJson(statePath, null)
  if (existing) {
    if (!existing.workId) throw new Error(`Invalid work state: missing workId at ${statePath}`)
    if (!Array.isArray(existing.handledEventIds)) throw new Error(`Invalid work state: missing handledEventIds at ${statePath}`)
    return existing
  }
  const createdAt = new Date().toISOString()
  return {
    workId: sessionId(fileKey, nodeId),
    fileKey,
    nodeId,
    currentVersion: 0,
    createdAt,
    updatedAt: createdAt,
    handledEventIds: [],
  }
}

async function saveState(workspace, state) {
  await writeJson(path.join(workDir(workspace, state.fileKey, state.nodeId), 'state.json'), state)
}

async function getPendingEvents(workspace, fileKey, nodeId, source = 'human') {
  const state = await getState(workspace, fileKey, nodeId)
  const handled = new Set(state.handledEventIds)
  const events = await readJsonl(path.join(workDir(workspace, fileKey, nodeId), 'events.jsonl'))
  return {
    state,
    events: events.filter((event) => event.source === source && !handled.has(event.id)),
  }
}

function isActionableWorkflowEvent(event) {
  return ['workflow.submitted', 'annotation.submitted'].includes(event?.type)
}

function deriveWorkflowPhase(state, events, pendingEvents, submission = null) {
  const hasImplementation = Boolean(state?.implementationUrl)
  const hasWorkflowSubmitted = events.some((event) => event.type === 'workflow.submitted')
  const pendingWorkflowSubmit = pendingEvents.find((event) => event.type === 'workflow.submitted')
  const pendingAnnotationSubmit = pendingEvents.find((event) => event.type === 'annotation.submitted')

  if (!hasImplementation) {
    if (pendingWorkflowSubmit) {
      return {
        phase: 'initial_generation_requested',
        waitingFor: 'codex-initial-generation',
        eventId: pendingWorkflowSubmit.id,
        description: 'The user submitted the first-pass design configuration. Codex should generate code before writing implementationUrl.',
      }
    }
    if (submission?.status === 'submitted') {
      return {
        phase: 'initial_generation_requested',
        waitingFor: 'codex-initial-generation',
        submissionPath: submission.path,
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
      waitingFor: 'submission.json',
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

  return {
    phase: 'implementation_work',
    waitingFor: 'annotation.submitted',
    description: 'The generated implementation is connected. Keep the interceptor in work mode and wait for new generated-preview annotations.',
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

function shouldUseAutoGrouping(args = {}) {
  return args['auto-grouping'] === true || args['auto-grouping'] === 'true' || args.autoGrouping === true || args.autoGrouping === 'true'
}

function interceptorDataSource(args = {}) {
  return shouldUseLocalDesignData(args) ? 'local' : 'restful'
}

function workflowUseBySkills(args = {}) {
  return args['use-by-skills'] === undefined ? '1' : String(args['use-by-skills'])
}

function buildInterceptorUrl({ host = 'localhost', port = '3100', fileKey, nodeId, token, mode = 'create', supportSampling = '1', supportRoots = '1', useBySkills = '', dataSource = 'restful', workspace }) {
  const url = new URL(`http://${host}:${port}/auth-page`)
  url.searchParams.set('token', token)
  url.searchParams.set('fileKey', fileKey)
  if (nodeId) url.searchParams.set('nodeId', nodeId)
  url.searchParams.set('mode', mode)
  url.searchParams.set('supportSampling', supportSampling)
  url.searchParams.set('supportRoots', supportRoots)
  if (useBySkills) url.searchParams.set('useBySkills', useBySkills)
  if (isCodexAppEnvironment()) url.searchParams.set('codexApp', '1')
  url.searchParams.set('dataSource', dataSource)
  if (workspace) url.searchParams.set('workspaceRoot', path.resolve(workspace))
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

async function workflowStatus(workspace, args) {
  const selected = await resolveSession(workspace, args)
  const fileKey = selected.fileKey
  const nodeId = selected.nodeId
  const pending = await getPendingEvents(workspace, fileKey, nodeId, args.source ? String(args.source) : 'human')
  const state = await getState(workspace, fileKey, nodeId)
  const events = await readJsonl(path.join(workDir(workspace, fileKey, nodeId), 'events.jsonl'))
  const submission = await readSubmission(workspace, fileKey, nodeId)
  const actionablePendingEvents = pending.events.filter(isActionableWorkflowEvent)
  const workflowPhase = deriveWorkflowPhase(state, events, actionablePendingEvents, submission)
  const chunks = await listChunks(workspace, fileKey, nodeId)
  const autoGrouping = await readAutoGroupingHandoff(workspace, fileKey, nodeId)
  const workflowToken = createWorkflowToken(args)
  const interceptorUrl = buildInterceptorUrl({
    host: String(args.host || 'localhost'),
    port: String(args.port || '3100'),
    fileKey,
    nodeId,
    token: workflowToken,
    mode: String(args.mode || 'create'),
    supportSampling: String(args['support-sampling'] || '1'),
    useBySkills: workflowUseBySkills(args),
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
          useBySkills: workflowUseBySkills(args),
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
    submission,
    workflowPhase,
    pendingEvents: actionablePendingEvents,
    allPendingEvents: pending.events,
    d2cDir: d2cDir(workspace, fileKey, nodeId),
    chunks,
    autoGrouping,
    sessions: selected.sessions,
  }
}

async function ackEvents(workspace, fileKey, nodeId, eventIds) {
  const state = await getState(workspace, fileKey, nodeId)
  const nextState = {
    ...state,
    updatedAt: new Date().toISOString(),
    handledEventIds: Array.from(new Set([...state.handledEventIds, ...eventIds])),
  }
  await writeJson(path.join(workDir(workspace, fileKey, nodeId), 'state.json'), nextState)
  return nextState
}

async function appendAgentEvent(workspace, fileKey, nodeId, type, payload) {
  const state = await getState(workspace, fileKey, nodeId)
  const version = Number(state.currentVersion || 0)
  const event = {
    id: `evt_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    workId: sessionId(fileKey, nodeId),
    version,
    snapshotId: state.latestSnapshotId,
    type,
    source: 'agent',
    payload,
    createdAt: new Date().toISOString(),
  }
  await fs.mkdir(workDir(workspace, fileKey, nodeId), { recursive: true })
  await fs.appendFile(path.join(workDir(workspace, fileKey, nodeId), 'events.jsonl'), `${JSON.stringify(event)}\n`, 'utf8')
  const nextState = {
    ...state,
    updatedAt: event.createdAt,
  }
  await writeJson(path.join(workDir(workspace, fileKey, nodeId), 'state.json'), nextState)
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

async function completeEvent(workspace, fileKey, nodeId, args) {
  const eventIds = optionalList(args, 'event-ids')
  if (!eventIds.length) throw new Error('Missing required --event-ids')
  const before = await getPendingEvents(workspace, fileKey, nodeId)
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
  const state = await ackEvents(workspace, fileKey, nodeId, eventIds)
  const after = await getPendingEvents(workspace, fileKey, nodeId)
  return {
    ...result,
    acknowledgedEventIds: eventIds,
    handledEvents,
    remainingPendingEvents: after.events,
    remainingPendingCount: after.events.length,
    state,
  }
}

async function claimEvent(workspace, fileKey, nodeId, args) {
  const pending = await getPendingEvents(workspace, fileKey, nodeId)
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

async function readAutoGroupingHandoff(workspace, fileKey, nodeId) {
  const dir = d2cDir(workspace, fileKey, nodeId)
  const tasksDir = path.join(dir, 'tasks')
  const groupsDataPath = path.join(dir, 'groupsData.json')
  const groupsData = await readJson(groupsDataPath, [])
  let task = null
  try {
    const entries = await fs.readdir(tasksDir, { withFileTypes: true })
    const taskStats = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.startsWith('subAgentTask-autoGrouping-') && entry.name.endsWith('.md'))
        .map(async (entry) => {
          const taskPath = path.join(tasksDir, entry.name)
          const stat = await fs.stat(taskPath)
          return {
            taskPath,
            taskRelativePath: path.relative(workspace, taskPath),
            mtimeMs: stat.mtimeMs,
          }
        }),
    )
    task = taskStats.sort((a, b) => b.mtimeMs - a.mtimeMs)[0] || null
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const groupsDataExists = Array.isArray(groupsData) && groupsData.length > 0
  let groupsDataFresh = groupsDataExists
  if (groupsDataExists && task?.mtimeMs) {
    try {
      const groupsDataStat = await fs.stat(groupsDataPath)
      groupsDataFresh = groupsDataStat.mtimeMs + 1000 >= task.mtimeMs
    } catch {
      groupsDataFresh = false
    }
  }

  return {
    enabled: Boolean(task),
    requiresAutoGrouping: Boolean(task && !groupsDataFresh),
    taskPath: task?.taskPath || null,
    taskRelativePath: task?.taskRelativePath || null,
    groupsDataPath,
    groupsDataRelativePath: path.relative(workspace, groupsDataPath),
    screenshotPath: null,
    rerunCommand: null,
    groupsDataExists: groupsDataFresh,
    staleGroupsDataExists: groupsDataExists && !groupsDataFresh,
    groupCount: groupsDataFresh ? groupsData.length : 0,
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

function buildSlothD2cArgs(fileKey, nodeId, framework = 'react', args = {}, { silent = true } = {}) {
  return [
    'd2c',
    '--file-key',
    fileKey,
    ...(nodeId ? ['--node-id', nodeId] : []),
    '--framework',
    framework || 'react',
    ...(shouldUseLocalDesignData(args) ? ['--local'] : []),
    ...(shouldUseAutoGrouping(args) ? ['--auto-grouping'] : []),
    ...(silent ? ['--silent'] : []),
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

async function ensureInitialChunks(workspace, args) {
  const selected = await resolveSession(workspace, args)
  const fileKey = selected.fileKey
  const nodeId = selected.nodeId
  const status = await workflowStatus(workspace, {
    ...args,
    'file-key': fileKey,
    'node-id': nodeId,
  })
  const eventId = args['event-id'] ? String(args['event-id']) : status.pendingEvents[0]?.id
  const context = eventId ? await eventContext(workspace, fileKey, nodeId, eventId) : null
  const expectedGroupCount = Array.isArray(context?.groups) && context.groups.length ? context.groups.length : context?.snapshot?.groupCount || 0
  const before = summarizeChunkGeneration(status.chunks, expectedGroupCount)
  const autoGroupingBefore = await readAutoGroupingHandoff(workspace, fileKey, nodeId)
  const force = Boolean(args.force)

  if (!before.needsSlothD2c && !force && !autoGroupingBefore.requiresAutoGrouping) {
    return {
      workspace,
      selected,
      eventId,
      ran: false,
      reason: 'chunks already complete',
      before,
      after: before,
      autoGrouping: autoGroupingBefore,
    }
  }

  const run = await runSlothD2cAtomicCommand(workspace, fileKey, nodeId, String(args.framework || 'react'), args)
  const afterChunks = await listChunks(workspace, fileKey, nodeId)
  const after = summarizeChunkGeneration(afterChunks, expectedGroupCount)
  const autoGroupingAfter = await readAutoGroupingHandoff(workspace, fileKey, nodeId)
  const parsedRunOutput = parseJsonCommandOutput(run.stdout)

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
    autoGrouping: parsedRunOutput?.autoGroupingHandoff || autoGroupingAfter,
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
  return readJson(path.join(workDir(workspace, fileKey, nodeId), 'snapshots', `${snapshotId}.json`), null)
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
  const events = await readJsonl(path.join(workDir(workspace, fileKey, nodeId), 'events.jsonl'))
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

async function eventBrief(workspace, args) {
  const selected = await resolveSession(workspace, args)
  const status = await workflowStatus(workspace, {
    ...args,
    'file-key': selected.fileKey,
    'node-id': selected.nodeId,
  })
  const eventId = args['event-id'] ? String(args['event-id']) : status.pendingEvents[0]?.id
  if (!eventId) {
    return {
      ...status,
      eventBrief: null,
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
  const claimEventCommand = commandString([
    'node',
    scriptPath(),
    'claim-event',
    '--workspace',
    workspace,
    '--file-key',
    selected.fileKey,
    ...(selected.nodeId ? ['--node-id', selected.nodeId] : []),
    '--event-ids',
    eventId,
    '--summary',
    '<what Codex started handling>',
  ])
  const completeEventCommand = commandString([
    'node',
    scriptPath(),
    'complete-event',
    '--workspace',
    workspace,
    '--file-key',
    selected.fileKey,
    ...(selected.nodeId ? ['--node-id', selected.nodeId] : []),
    '--event-ids',
    eventId,
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
  ])

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
      instructions: [
        'Start from eventBrief.event, eventBrief.changedCanvasAnnotations, and eventBrief.groups. Do not rescan unrelated historical annotations unless this event requires it.',
        'Use the shortest useful repair path. Do not capture screenshots unless the event explicitly asks for visual fidelity or the code change cannot be checked otherwise.',
        'Edit the local implementation, run the narrowest useful checks, then write an agent result and acknowledge the handled event.',
      ],
      commands: {
        claimEvent: claimEventCommand,
        completeEvent: completeEventCommand,
      },
    },
  }
  return brief
}

async function annotationWorkflow(workspace, args) {
  const brief = await eventBrief(workspace, args)
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
        'Run one narrow useful check. Do not capture screenshots or use the visual diff skill for ordinary interaction, copy, spacing, or style fixes unless the annotation explicitly requires visual fidelity review.',
        'Finish with complete-event so the interceptor can switch from Agent 生成中 to 已修改完成.',
      ],
      commands: brief.eventBrief.commands,
    },
  }
}

async function workflowHandoff(workspace, args) {
  const status = await workflowStatus(workspace, args)
  const slothCli = await resolveSlothCliStatus()
  const fileKey = status.selected.fileKey
  const nodeId = status.selected.nodeId
  const baseArgs = [
    '--workspace',
    workspace,
    '--file-key',
    fileKey,
    ...(nodeId ? ['--node-id', nodeId] : []),
  ]
  const portArgs = [
    ...(args.port && args.port !== true ? ['--port', String(args.port)] : []),
    ...(args['dev-port'] && args['dev-port'] !== true ? ['--dev-port', String(args['dev-port'])] : []),
  ]
  const focusedEvent =
    status.pendingEvents.find((event) => event.id === status.workflowPhase?.eventId) || status.pendingEvents[0]
  const focusedEventArgs = focusedEvent ? ['--event-id', focusedEvent.id] : []
  const focusedBrief = focusedEvent
    ? (await eventBrief(workspace, {
        ...args,
        'file-key': fileKey,
        'node-id': nodeId,
        'event-id': focusedEvent.id,
      })).eventBrief
    : null
  const phase = status.workflowPhase?.phase || 'design_prepare'
  const skipInterceptor = shouldSkipInterceptor(args)
  const shouldStartDevInterceptor = phase === 'design_prepare' && status.devMode && !status.devInterceptorUrl && !skipInterceptor
  const openUrl = shouldStartDevInterceptor ? null : status.preferredInterceptorUrl || status.devInterceptorUrl || status.interceptorUrl
  const submittedGroupCount =
    focusedBrief && Array.isArray(focusedBrief.groups)
      ? focusedBrief.groups.length
      : focusedBrief?.snapshot?.groupCount || status.submission?.groupCount || 0
  const initialChunkStatus = summarizeChunkGeneration(status.chunks, submittedGroupCount)
  const autoGroupingStatus = status.autoGrouping || { requiresAutoGrouping: false }
  const generateChunksCommand = commandString([
    'node',
    scriptPath(),
    'ensure-initial-chunks',
    ...baseArgs,
    '--framework',
    String(args.framework || 'react'),
    ...(args.local === true || args.local === 'true' ? ['--local'] : []),
    ...(shouldUseAutoGrouping(args) ? ['--auto-grouping'] : []),
    '--prefer-repo-cli',
  ])
  const prepareFirstRunCommand = commandString([
    'sloth',
    ...buildSlothD2cArgs(fileKey, nodeId, String(args.framework || 'react'), args, { silent: false }),
  ])
  const recommendedActionByPhase = {
    design_prepare: skipInterceptor
      ? 'Run commands.generateChunks to fetch design data and generate chunk prompts silently. Do not open the interceptor or wait for submission.json. After codeAggregation.md and finalGenerate.md exist, continue directly to first implementation generation in the same turn; numeric group chunks are optional.'
      : shouldStartDevInterceptor
      ? 'Start the Sloth workflow dev launcher, rerun workflow-handoff, then run commands.prepareFirstRun. Open the returned interceptorUrl in the Codex in-app browser and run the returned wait.command. When action is handle_subagent_task, handle task.path and wait again; continue first generation when action is consume_chunks. Do not click Submit/Generate or trigger the form for the user. Use shell open/system default browser/Chrome only if the Codex in-app browser is unavailable or control fails.'
      : 'Run commands.prepareFirstRun first. It runs sloth d2c in interactive handoff mode to prepare REST/local design data without opening Chrome or blocking for submit. Then open the returned interceptorUrl in the Codex in-app browser and run the returned blocking wait.command. When action is handle_subagent_task, handle task.path and wait again; continue first generation when action is consume_chunks. Do not inspect controls and submit on the user’s behalf.',
    initial_generation_requested: skipInterceptor
      ? initialChunkStatus.needsSlothD2c
        ? 'Before writing implementation code, run commands.generateChunks to refresh chunk prompts. Do not open the interceptor. Follow numeric group chunks when present, then codeAggregation.md and finalGenerate.md, create real project components/styles/assets, start the target app preview, and write implementationUrl if work mode is still needed later. Do not deliver by embedding absolute.html, raw HTML, iframe, srcDoc, dangerouslySetInnerHTML, or a scaled static wrapper.'
        : 'Follow the existing Sloth D2C prompts: numeric group chunks when present, then codeAggregation.md and finalGenerate.md. Generate real project components/styles/assets, start the target app preview, and write implementationUrl if work mode is still needed later. Do not open the interceptor during first generation. Do not deliver by embedding absolute.html, raw HTML, iframe, srcDoc, dangerouslySetInnerHTML, or a scaled static wrapper.'
      : 'Use submission.json as the first-run gate, then follow existing Sloth D2C prompts: numeric group chunks when present, then codeAggregation.md and finalGenerate.md. Generate real project components/styles/assets, start the target app preview, write implementationUrl, and keep or reopen the Sloth interceptor in the Codex in-app browser. Do not navigate the in-app browser directly to the target preview URL. Do not deliver by embedding absolute.html, raw HTML, iframe, srcDoc, dangerouslySetInnerHTML, or a scaled static wrapper.',
    initial_generating: skipInterceptor
      ? 'Continue the silent first generation path until a reachable implementation preview URL is available, then write implementationUrl if work mode is still needed later. Do not open the interceptor during first generation.'
      : 'Continue the first generation path until a reachable implementation preview URL is available, then write implementationUrl so the interceptor can enter work mode. Keep the Codex in-app browser on the Sloth interceptor.',
    implementation_work: 'Open the interceptor work page and wait for the user to save generated-preview annotations.',
    implementation_annotations_requested: 'Handle the returned generated-preview annotation eventBrief, edit code, run checks, then run complete-event.',
  }
  const autoGroupingRecommendedAction = autoGroupingStatus.requiresAutoGrouping
    ? `Before generating chunks or implementation code, dispatch a focused subagent to read ${autoGroupingStatus.taskPath} and write ${autoGroupingStatus.groupsDataPath}. After it validates groupsData.json, rerun ${autoGroupingStatus.rerunCommand || 'commands.generateChunks'} to generate chunks, then follow numeric group chunks when present, codeAggregation.md, and finalGenerate.md. Keep the auto-grouping task body out of the main context except for the final groupsData summary.`
    : null
  const phaseRecommendedAction =
    autoGroupingRecommendedAction ||
    recommendedActionByPhase[phase] ||
    (focusedEvent
      ? 'Handle the returned eventBrief, edit code, run checks, then run complete-event.'
      : 'Open the interceptor URL in the Codex in-app browser, let the user annotate, then run wait-next-event.')
  const codexBrowserOpen = codexBrowserOpenContract({
    phase,
    interceptorMode: skipInterceptor ? 'silent' : 'interactive',
    url: openUrl,
    urlSource: phase === 'design_prepare' ? 'commands.prepareFirstRun.interceptorUrl' : 'commands.openUrl',
    afterOpen:
      phase === 'design_prepare'
        ? 'wait-for-sloth-event'
        : focusedEvent
          ? 'keep-open-while-handling-event'
          : 'wait-for-user-annotation',
  })

  return {
    ...status,
    slothCli,
    interceptorMode: skipInterceptor ? 'silent' : 'interactive',
    nextEvent: focusedEvent || null,
    eventBrief: focusedBrief,
    initialGeneration: {
      chunkStatus: initialChunkStatus,
      autoGrouping: autoGroupingStatus,
      mustRunAutoGroupingBeforeChunks: Boolean(autoGroupingStatus.requiresAutoGrouping),
      mustRunSlothD2cBeforeCoding:
        skipInterceptor && phase === 'initial_generation_requested' && initialChunkStatus.needsSlothD2c && !autoGroupingStatus.requiresAutoGrouping,
    },
    codexBrowserOpen,
    stopCondition: !slothCli.available
      ? 'Install Sloth CLI, verify with commands.verifySloth, then rerun workflow-handoff.'
      : phase === 'design_prepare'
        ? skipInterceptor
          ? 'Do not open the interceptor. Stop only after codeAggregation.md and finalGenerate.md exist and first implementation generation has started or completed.'
          : 'After opening the returned interceptor URL, run the blocking wait.command returned by prepare-interceptor. When action is handle_subagent_task, handle task.path and rerun the command; continue immediately when action is consume_chunks. The wait has no business timeout. Do not click Submit/Generate or use DOM selectors or coordinates to submit.'
        : undefined,
    recommendedAction: slothCli.available ? phaseRecommendedAction : slothCli.message,
    commands: {
      openUrl,
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
      eventBrief: commandString(['node', scriptPath(), 'event-brief', ...baseArgs, ...focusedEventArgs]),
      prepareFirstRun: skipInterceptor ? null : prepareFirstRunCommand,
      generateChunks: generateChunksCommand,
      annotationWorkflow: commandString(['node', scriptPath(), 'annotation-workflow', ...baseArgs, ...focusedEventArgs]),
      setImplementationUrl: commandString([
        'node',
        scriptPath(),
        'set-implementation-url',
        ...baseArgs,
        '--url',
        '<local implementation URL>',
      ]),
    },
  }
}

async function prepareInterceptor(workspace, args) {
  const handoff = await workflowHandoff(workspace, args)
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
      command: handoff.commands.generateChunks,
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
  const d2cArgs = buildSlothD2cArgs(fileKey, nodeId, framework, args, { silent: false })
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
  const interceptorUrl = parsed?.interceptorUrl || ''
  if (parsed?.ok !== true || parsed?.action !== 'open_browser_and_wait' || !interceptorUrl || !parsed?.wait?.command) {
    return {
      ok: false,
      mode: 'prepare-interceptor',
      action: 'inspect_prepare_first_run_output',
      selected: handoff.selected,
      command,
      stdoutPreview: previewOutput(run.stdout),
      stderrPreview: previewOutput(run.stderr),
      message: 'Sloth first-run preparation did not return the unified interceptor handoff fields.',
    }
  }

  return {
    ok: true,
    mode: 'prepare-interceptor',
    action: 'open_browser_and_wait',
    selected: handoff.selected,
    workflowPhase: handoff.workflowPhase,
    command,
    interceptorUrl,
    codexBrowserOpen: codexBrowserOpenContract({
      phase,
      interceptorMode: 'interactive',
      url: interceptorUrl,
      urlSource: 'prepare-interceptor.interceptorUrl',
      afterOpen: 'wait-for-sloth-event',
    }),
    wait: {
      command: parsed.wait.command,
    },
    stopCondition:
      'Run wait.command and keep it active until it returns handle_subagent_task, consume_chunks, or error. After a successful task, delete the task file and run the same command again. There is no business timeout; terminate the command only when voluntarily leaving the wait.',
  }
}

async function waitNextEvent(workspace, args) {
  const timeoutMs = Number(args['timeout-ms'] || 300000)
  const pollMs = Number(args['poll-ms'] || 2000)
  const startedAt = Date.now()
  let polls = 0
  let latestStatus = null

  while (true) {
    polls += 1
    latestStatus = await workflowStatus(workspace, args)
    const nextEvent = latestStatus.pendingEvents[0]
    if (nextEvent) {
      const brief = await eventBrief(workspace, {
        ...args,
        'file-key': latestStatus.selected.fileKey,
        'node-id': latestStatus.selected.nodeId,
        'event-id': nextEvent.id,
      })
      return {
        ...latestStatus,
        timedOut: false,
        polls,
        waitedMs: Date.now() - startedAt,
        nextEvent,
        eventBrief: brief.eventBrief,
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

  if (command === 'workflow-handoff') {
    printJson(await workflowHandoff(workspace, args))
    return
  }

  if (command === 'prepare-interceptor') {
    printJson(await prepareInterceptor(workspace, args))
    return
  }

  if (command === 'open-interceptor') {
    printJson(await openInterceptor(workspace, args))
    return
  }

  if (command === 'event-brief') {
    printJson(await eventBrief(workspace, args))
    return
  }

  if (command === 'annotation-workflow') {
    printJson(await annotationWorkflow(workspace, args))
    return
  }

  if (command === 'set-implementation-url') {
    printJson(await setImplementationUrl(workspace, args))
    return
  }

  if (command === 'wait-next-event') {
    printJson(await waitNextEvent(workspace, args))
    return
  }

  if (command === 'complete-event') {
    printJson(await completeEvent(workspace, requireArg(args, 'file-key'), args['node-id'] ? String(args['node-id']) : undefined, args))
    return
  }

  if (command === 'claim-event') {
    printJson(await claimEvent(workspace, requireArg(args, 'file-key'), args['node-id'] ? String(args['node-id']) : undefined, args))
    return
  }

  if (command === 'ensure-initial-chunks') {
    printJson(await ensureInitialChunks(workspace, args))
    return
  }

  throw new Error(`Unknown command: ${command || '(empty)'}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
