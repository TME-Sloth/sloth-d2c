#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sloth-d2c-state.mjs')

function cleanPart(value, fallback = 'root') {
  return String(value || fallback).replace(/[^a-zA-Z0-9\u4e00-\u9fff\u3400-\u4dbf-_]/g, '_')
}

function sessionId(fileKey, nodeId) {
  return `${cleanPart(fileKey, 'file')}_${cleanPart(nodeId, 'root')}`
}

function d2cDir(workspace, fileKey, nodeId) {
  return path.join(workspace, '.sloth', cleanPart(fileKey), cleanPart(nodeId))
}

function loopDir(workspace, fileKey, nodeId) {
  return path.join(d2cDir(workspace, fileKey, nodeId), 'loop')
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function runCli(args, options = {}) {
  const { stdout } = await execFileAsync(process.execPath, [scriptPath, ...args], {
    maxBuffer: 10 * 1024 * 1024,
    ...options,
    env: {
      ...process.env,
      SLOTH_DISABLE_CODEX_TOKEN_BRIDGE: '1',
      ...(options.env || {}),
    },
  })
  return JSON.parse(stdout)
}

async function createTokenBridgeServers() {
  const registrations = []
  const sockets = new Set()
  const base = 43000 + Math.floor(Math.random() * 1000)

  for (let offset = 0; offset < 100; offset += 2) {
    const port = base + offset
    const httpServer = http.createServer((req, res) => {
      if (req.url?.startsWith('/validateToken')) {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ valid: false }))
        return
      }
      res.end('ok')
    })
    const socketServer = net.createServer((socket) => {
      sockets.add(socket)
      socket.setEncoding('utf8')
      socket.write(JSON.stringify({ type: 'welcome' }) + '\n')
      let buffer = ''
      socket.on('data', (chunk) => {
        buffer += chunk
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''
        for (const line of lines) {
          if (!line.trim()) continue
          const message = JSON.parse(line)
          if (message.type === 'register-token') {
            registrations.push(message)
            socket.write(JSON.stringify({ type: 'token-registered', token: message.token }) + '\n')
          }
        }
      })
      socket.on('close', () => sockets.delete(socket))
    })

    try {
      await new Promise((resolve, reject) => {
        httpServer.once('error', reject)
        httpServer.listen(port, resolve)
      })
      await new Promise((resolve, reject) => {
        socketServer.once('error', reject)
        socketServer.listen(port + 1, resolve)
      })
      return {
        port,
        registrations,
        close: async () => {
          for (const socket of sockets) socket.destroy()
          await Promise.all([
            new Promise((resolve, reject) => httpServer.close((error) => (error ? reject(error) : resolve()))),
            new Promise((resolve, reject) => socketServer.close((error) => (error ? reject(error) : resolve()))),
          ])
        },
      }
    } catch {
      await Promise.allSettled([
        new Promise((resolve) => httpServer.close(() => resolve())),
        new Promise((resolve) => socketServer.close(() => resolve())),
      ])
    }
  }

  throw new Error('Unable to allocate adjacent test ports')
}

async function waitFor(predicate, timeoutMs = 2000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const value = predicate()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return predicate()
}

async function createWorkspace() {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'sloth-d2c-state-'))
  const fileKey = 'testFile'
  const nodeId = 'node_1'
  const id = sessionId(fileKey, nodeId)
  const now = '2026-06-22T00:00:00.000Z'
  const targetD2cDir = d2cDir(workspace, fileKey, nodeId)
  const targetLoopDir = loopDir(workspace, fileKey, nodeId)
  const canvasAnnotations = [
    {
      id: 'anno_old',
      text: '旧标注不应成为本次处理目标',
      x1: 10,
      y1: 10,
      x2: 20,
      y2: 20,
      createdAt: now,
    },
    {
      id: 'anno_new',
      text: '只处理本次新增画布标注',
      x1: 30,
      y1: 30,
      x2: 40,
      y2: 40,
      createdAt: now,
    },
  ]

  await fs.mkdir(path.join(targetD2cDir, 'chunks'), { recursive: true })
  await fs.mkdir(path.join(targetD2cDir, 'screenshots'), { recursive: true })
  await fs.writeFile(path.join(targetD2cDir, 'absolute.html'), '<html><body>test</body></html>\n', 'utf8')
  await fs.writeFile(path.join(targetD2cDir, 'chunks', 'chunk.md'), '# chunk\n', 'utf8')
  await writeJson(path.join(targetD2cDir, 'groupsData.json'), [])
  await writeJson(path.join(targetLoopDir, 'state.json'), {
    sessionId: id,
    fileKey,
    nodeId,
    currentVersion: 2,
    createdAt: now,
    updatedAt: now,
    latestSnapshotId: 'v0002',
    agents: {
      codex: {
        processedUntilVersion: 1,
        processedEventIds: ['evt_seed'],
        updatedAt: now,
      },
    },
    implementationUrl: 'http://127.0.0.1:9999/',
  })
  await writeJson(path.join(targetLoopDir, 'snapshots', 'v0002.json'), {
    snapshotId: 'v0002',
    version: 2,
    fileKey,
    nodeId,
    groupsData: [],
    canvasAnnotations,
    createdAt: now,
  })
  await fs.writeFile(
    path.join(targetLoopDir, 'events.jsonl'),
    `${JSON.stringify({
      id: 'evt_annotation',
      sessionId: id,
      version: 2,
      snapshotId: 'v0002',
      type: 'annotation.submitted',
      source: 'human',
      target: {
        surface: 'implementation',
        groupIndices: [],
        annotationIds: ['anno_new'],
      },
      payload: {
        summary: '提交 1 条生成稿标注',
        surface: 'implementation',
        canvasAnnotations,
        changedCanvasAnnotations: [{ ...canvasAnnotations[1], changeType: 'created' }],
        changedAnnotationIds: ['anno_new'],
        intent: 'annotation-fix',
      },
      createdAt: now,
    })}\n`,
    'utf8',
  )

  return { workspace, fileKey, nodeId }
}

async function createDesignPrepareWorkspace() {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'sloth-d2c-design-prepare-'))
  const fileKey = 'firstRunFile'
  const nodeId = 'node_1'
  const targetD2cDir = d2cDir(workspace, fileKey, nodeId)

  await fs.mkdir(path.join(targetD2cDir, 'chunks'), { recursive: true })
  await fs.writeFile(path.join(targetD2cDir, 'absolute.html'), '<html><body>first run</body></html>\n', 'utf8')
  await writeJson(path.join(targetD2cDir, 'groupsData.json'), [])

  return { workspace, fileKey, nodeId }
}

async function createEmptyWorkspace() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'sloth-d2c-empty-'))
}

async function createFakeSlothBin() {
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sloth-d2c-fake-bin-'))
  const slothPath = path.join(binDir, 'sloth')
  await fs.writeFile(
    slothPath,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('sloth-test 1.0.0');
  process.exit(0);
}
if (args[0] !== 'd2c') {
  console.error('unexpected command: ' + args.join(' '));
  process.exit(2);
}
function valueOf(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : '';
}
const fileKey = valueOf('--file-key');
const nodeId = valueOf('--node-id');
console.log(JSON.stringify({
  codexHandoff: {
    enabled: true,
    prepared: true,
    token: 'sloth-d2c-test-token',
    interceptorUrl: 'http://localhost:3100/auth-page?token=sloth-d2c-test-token&fileKey=' + encodeURIComponent(fileKey) + '&nodeId=' + encodeURIComponent(nodeId) + '&mode=create',
    d2cDir: process.env.SLOTH_WORKSPACE_ROOT + '/.sloth/' + fileKey + '/' + nodeId,
    copiedFiles: ['absolute.html', 'groupsData.json'],
    bridge: { pid: 12345, socketPort: 3101 },
    nextAction: 'open_in_codex_browser'
  },
  content: [{ type: 'text', text: 'Codex handoff ready' }]
}));
`,
    'utf8',
  )
  await fs.chmod(slothPath, 0o755)
  return binDir
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address()))
  })
}

async function main() {
  const { workspace, fileKey, nodeId } = await createWorkspace()
  const server = http.createServer((_, response) => {
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end('<!doctype html><title>Sloth D2C 转码</title><div id="root"></div>')
  })
  const address = await listen(server)

  try {
    const handoff = await runCli([
      'workflow-handoff',
      '--workspace',
      workspace,
      '--file-key',
      fileKey,
      '--node-id',
      nodeId,
      '--agent-id',
      'codex',
      '--dev-port',
      String(address.port),
    ])
    assert.equal(handoff.commands.openUrl, handoff.preferredInterceptorUrl)
    assert.match(handoff.commands.openUrl, new RegExp(`127\\.0\\.0\\.1:${address.port}`))
    assert.equal(handoff.workflowPhase.phase, 'implementation_annotations_requested')
    assert.equal(handoff.nextEvent.id, 'evt_annotation')
    assert.equal(handoff.eventBrief.changedCanvasAnnotations.length, 1)
    assert.equal(handoff.eventBrief.changedCanvasAnnotations[0].id, 'anno_new')
    assert.equal(handoff.eventBrief.groups.length, 0)
    assert.equal(handoff.eventBrief.snapshot, null)
    assert.equal(handoff.eventBrief.canvasAnnotations, undefined)
    assert.equal(handoff.eventBrief.canvasAnnotationCount, 0)

    const brief = await runCli([
      'annotation-brief',
      '--workspace',
      workspace,
      '--file-key',
      fileKey,
      '--node-id',
      nodeId,
      '--agent-id',
      'codex',
    ])
    assert.equal(brief.eventBrief.changedCanvasAnnotations.length, 1)
    assert.equal(brief.eventBrief.changedCanvasAnnotations[0].text, '只处理本次新增画布标注')
    assert.equal(brief.eventBrief.snapshot, null)
    assert.equal(brief.eventBrief.canvasAnnotations, undefined)
    assert.equal(brief.eventBrief.canvasAnnotationCount, 0)
    assert.equal(brief.repairBrief.changedCanvasAnnotations[0].id, brief.eventBrief.changedCanvasAnnotations[0].id)

    const complete = await runCli([
      'complete-event',
      '--workspace',
      workspace,
      '--file-key',
      fileKey,
      '--node-id',
      nodeId,
      '--agent-id',
      'codex',
      '--event-ids',
      'evt_annotation',
      '--summary',
      'handled',
    ])
    assert.equal(complete.remainingPendingCount, 0)
    assert.deepEqual(complete.acknowledgedEventIds, ['evt_annotation'])
    assert.equal(complete.state.agents.codex.processedUntilVersion, 2)

    const screenshotTarget = await runCli([
      'implementation-screenshot-target',
      '--workspace',
      workspace,
      '--file-key',
      fileKey,
      '--node-id',
      nodeId,
      '--agent-id',
      'codex',
      '--label',
      'preview_check',
    ])
    assert.equal(screenshotTarget.screenshotPath, path.join(d2cDir(workspace, fileKey, nodeId), 'screenshots', 'implementation', 'preview_check.png'))
    await assert.rejects(fs.stat(path.join(loopDir(workspace, fileKey, nodeId), 'implementation-screenshots')), /ENOENT/)

    const autoResolvedOpen = await runCli([
      'open-interceptor',
      '--workspace',
      workspace,
      '--agent-id',
      'codex',
      '--url',
      'http://127.0.0.1:9999/',
      '--port',
      String(address.port),
    ])
    assert.equal(autoResolvedOpen.ok, true)
    assert.equal(autoResolvedOpen.action, 'open_codex_browser_recommended')
    assert.equal(autoResolvedOpen.resolution.mode, 'resolved-design-session')
    assert.equal(autoResolvedOpen.resolution.confidence, 'high')
    assert.equal(autoResolvedOpen.selected.fileKey, fileKey)
    assert.equal(autoResolvedOpen.selected.nodeId, nodeId)
    assert.equal(autoResolvedOpen.selected.workbench, false)
    assert.equal(autoResolvedOpen.implementation.wrote, false)
    assert.doesNotMatch(autoResolvedOpen.commands.workflowHandoff, /--agent-id/)
    assert.doesNotMatch(autoResolvedOpen.commands.waitNextEvent, /--agent-id/)
    assert.match(autoResolvedOpen.stopCondition, /If the user asked to open/)

    const resolvedOpen = await runCli([
      'open-interceptor',
      '--workspace',
      workspace,
      '--file-key',
      fileKey,
      '--node-id',
      nodeId,
      '--agent-id',
      'codex',
      '--url',
      'http://127.0.0.1:9999/',
      '--port',
      String(address.port),
    ])
    assert.equal(resolvedOpen.ok, true)
    assert.equal(resolvedOpen.resolution.mode, 'explicit-session')
    assert.equal(resolvedOpen.selected.fileKey, fileKey)
    assert.equal(resolvedOpen.selected.workbench, false)
    assert.equal(resolvedOpen.implementation.wrote, false)
    assert.match(resolvedOpen.interceptorUrl, new RegExp(`127\\.0\\.0\\.1:${address.port}|localhost:${address.port}`))
    assert.equal(resolvedOpen.codexBrowserOpen.url, resolvedOpen.interceptorUrl)

    const implementationUrl = `http://127.0.0.1:${address.port}/preview`
    const workbenchOpen = await runCli([
      'open-interceptor',
      '--workspace',
      workspace,
      '--agent-id',
      'codex',
      '--url',
      implementationUrl,
      '--session',
      'prompt-lab',
      '--port',
      String(address.port),
    ])
    assert.equal(workbenchOpen.ok, true)
    assert.equal(workbenchOpen.resolution.mode, 'temporary-workbench')
    assert.equal(workbenchOpen.selected.fileKey, '__workbench__')
    assert.equal(workbenchOpen.selected.nodeId, 'prompt-lab')
    assert.equal(workbenchOpen.selected.workbench, true)
    assert.equal(workbenchOpen.implementation.url, implementationUrl)
    assert.equal(workbenchOpen.implementation.wrote, true)
    assert.doesNotMatch(workbenchOpen.commands.setImplementationUrl, /--agent-id/)
    assert.doesNotMatch(workbenchOpen.commands.workflowHandoff, /--agent-id/)
    assert.match(workbenchOpen.seededWorkbench.files.absoluteHtml, /\.sloth\/__workbench__\/prompt-lab\/absolute\.html$/)
    await fs.stat(path.join(d2cDir(workspace, '__workbench__', 'prompt-lab'), 'absolute.html'))
    await fs.stat(path.join(loopDir(workspace, '__workbench__', 'prompt-lab'), 'state.json'))

    const reopenedWorkbench = await runCli([
      'open-interceptor',
      '--workspace',
      workspace,
      '--agent-id',
      'codex',
      '--url',
      implementationUrl,
      '--port',
      String(address.port),
    ])
    assert.equal(reopenedWorkbench.resolution.mode, 'resolved-workbench-session')
    assert.equal(reopenedWorkbench.selected.fileKey, '__workbench__')
    assert.equal(reopenedWorkbench.selected.nodeId, 'prompt-lab')
    assert.equal(reopenedWorkbench.implementation.wrote, false)

    process.stdout.write('sloth-d2c-state tests passed\n')
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    await fs.rm(workspace, { recursive: true, force: true })
  }

  const emptyWorkspace = await createEmptyWorkspace()
  try {
    const unresolvedOpen = await runCli([
      'open-interceptor',
      '--workspace',
      emptyWorkspace,
      '--agent-id',
      'codex',
      '--ports',
      '9',
      '--timeout-ms',
      '10',
    ])
    assert.equal(unresolvedOpen.ok, false)
    assert.equal(unresolvedOpen.action, 'ask_user_intent')
    assert.match(unresolvedOpen.question, /转代码/)
    assert.match(unresolvedOpen.question, /页面 URL/)
    assert.deepEqual(unresolvedOpen.options.map((option) => option.id), ['convert-code', 'open-interceptor'])
    await assert.rejects(fs.stat(path.join(emptyWorkspace, '.sloth')), /ENOENT/)
  } finally {
    await fs.rm(emptyWorkspace, { recursive: true, force: true })
  }

  const designPrepare = await createDesignPrepareWorkspace()
  try {
    const defaultHandoff = await runCli([
      'workflow-handoff',
      '--workspace',
      designPrepare.workspace,
      '--file-key',
      designPrepare.fileKey,
      '--node-id',
      designPrepare.nodeId,
      '--agent-id',
      'codex',
    ])
	    assert.equal(defaultHandoff.workflowPhase.phase, 'design_prepare')
	    assert.equal(defaultHandoff.nextEvent, null)
	    assert.equal(defaultHandoff.pendingEvents.length, 0)
	    assert.equal(defaultHandoff.allPendingEvents.length, 0)
	    assert.match(defaultHandoff.recommendedAction, /Run commands\.prepareFirstRun first/)
	    assert.match(defaultHandoff.recommendedAction, /without opening Chrome or blocking for submit/)
	    assert.equal(defaultHandoff.slothCli.available, true)
	    assert.match(defaultHandoff.commands.openUrl, /localhost:3100\/auth-page/)
	    assert.match(defaultHandoff.commands.openUrl, /supportSampling=1/)
	    assert.match(defaultHandoff.commands.openUrl, /useBySkills=1/)
	    assert.equal(defaultHandoff.commands.startWorkflowDev, null)
	    assert.match(defaultHandoff.commands.prepareFirstRun, /sloth.*d2c/)
	    assert.doesNotMatch(defaultHandoff.commands.prepareFirstRun, /SLOTH_CODEX_HANDOFF/)
	    assert.doesNotMatch(defaultHandoff.commands.prepareFirstRun, /CODEX_SHELL=1/)
	    assert.doesNotMatch(defaultHandoff.commands.prepareFirstRun, /--no-open/)
	    assert.doesNotMatch(defaultHandoff.commands.prepareFirstRun, /--silent/)
	    assert.doesNotMatch(defaultHandoff.commands.waitNextEvent, /--agent-id/)
	    assert.doesNotMatch(defaultHandoff.commands.setImplementationUrl, /--agent-id/)
	    assert.equal(defaultHandoff.codexBrowserOpen.enabled, true)
	    assert.equal(defaultHandoff.codexBrowserOpen.skill, 'browser:control-in-app-browser')
	    assert.equal(defaultHandoff.codexBrowserOpen.target, 'iab')
	    assert.equal(defaultHandoff.codexBrowserOpen.urlSource, 'commands.prepareFirstRun.codexHandoff.interceptorUrl')
	    assert.equal(defaultHandoff.codexBrowserOpen.afterOpen, 'return-to-user')
	    assert.match(defaultHandoff.commands.rawSlothD2c, /sloth.*d2c/)
	    assert.match(defaultHandoff.commands.rawSlothD2c, /--silent/)
	    assert.deepEqual(defaultHandoff.warnings, [])
	    const fakeSlothBin = await createFakeSlothBin()
	    const prepared = await runCli(
	      [
	        'prepare-interceptor',
	        '--workspace',
	        designPrepare.workspace,
	        '--file-key',
	        designPrepare.fileKey,
	        '--node-id',
	        designPrepare.nodeId,
	        '--agent-id',
	        'codex',
	      ],
	      {
	        env: {
	          PATH: `${fakeSlothBin}${path.delimiter}${process.env.PATH}`,
	          CODEX_SHELL: '1',
	        },
	      },
	    )
	    assert.equal(prepared.ok, true)
	    assert.equal(prepared.action, 'open_codex_browser_and_stop')
	    assert.match(prepared.command, /sloth.*d2c/)
	    assert.equal(prepared.interceptorUrl, `http://localhost:3100/auth-page?token=sloth-d2c-test-token&fileKey=${designPrepare.fileKey}&nodeId=${designPrepare.nodeId}&mode=create`)
	    assert.equal(prepared.codexBrowserOpen.url, prepared.interceptorUrl)
	    assert.equal(prepared.codexBrowserOpen.urlSource, 'prepare-interceptor.codexHandoff.interceptorUrl')
	    assert.deepEqual(prepared.forbidden, ['submit_interceptor', 'generate_code', 'poll_event', 'write_implementation_url'])
	    const defaultGuide = await runCli([
	      'workflow-guide',
	      '--workspace',
	      designPrepare.workspace,
	      '--file-key',
	      designPrepare.fileKey,
	      '--node-id',
	      designPrepare.nodeId,
	      '--agent-id',
	      'codex',
	    ])
	    assert.equal(defaultGuide.guide[0].step, 'prepare-first-run')
	    assert.equal(defaultGuide.guide[0].command, defaultHandoff.commands.prepareFirstRun)
	    assert.equal(defaultGuide.codexBrowserOpen.enabled, true)
	    assert.equal(defaultGuide.codexBrowserOpen.skill, defaultHandoff.codexBrowserOpen.skill)
	    assert.equal(defaultGuide.codexBrowserOpen.target, defaultHandoff.codexBrowserOpen.target)
	    assert.equal(defaultGuide.codexBrowserOpen.urlSource, defaultHandoff.codexBrowserOpen.urlSource)
	    assert.equal(defaultGuide.guide[0].codexBrowserOpen.enabled, true)
	    assert.equal(defaultGuide.guide[0].codexBrowserOpen.skill, defaultHandoff.codexBrowserOpen.skill)
	    assert.match(defaultGuide.guide[0].codexBrowserOpen.url, /localhost:3100\/auth-page/)
	    const silentHandoff = await runCli([
	      'workflow-handoff',
	      '--workspace',
	      designPrepare.workspace,
	      '--file-key',
	      designPrepare.fileKey,
	      '--node-id',
	      designPrepare.nodeId,
	      '--agent-id',
	      'codex',
	      '--silent',
	    ])
	    assert.equal(silentHandoff.interceptorMode, 'silent')
	    assert.equal(silentHandoff.commands.prepareFirstRun, null)
	    assert.match(silentHandoff.commands.firstRun, /sloth.*d2c/)
	    assert.match(silentHandoff.commands.firstRun, /--silent/)
	    assert.equal(silentHandoff.codexBrowserOpen, null)
	    assert.match(silentHandoff.recommendedAction, /Do not open the interceptor/)
	    const silentGuide = await runCli([
	      'workflow-guide',
	      '--workspace',
	      designPrepare.workspace,
	      '--file-key',
	      designPrepare.fileKey,
	      '--node-id',
	      designPrepare.nodeId,
	      '--agent-id',
	      'codex',
	      '--silent',
	    ])
	    assert.equal(silentGuide.mode, 'silent-first-run')
	    assert.equal(silentGuide.guide[0].step, 'generate-chunks-silently')
	    assert.equal(silentGuide.guide[0].command, silentHandoff.commands.firstRun)
	    const defaultToken = new URL(defaultHandoff.commands.openUrl).searchParams.get('token')
    assert.match(defaultToken, /^sloth-d2c-[0-9a-f-]{36}$/)

    const repeatedHandoff = await runCli([
      'workflow-handoff',
      '--workspace',
      designPrepare.workspace,
      '--file-key',
      designPrepare.fileKey,
      '--node-id',
      designPrepare.nodeId,
      '--agent-id',
      'codex',
    ])
    assert.notEqual(new URL(repeatedHandoff.commands.openUrl).searchParams.get('token'), defaultToken)
    await assert.rejects(
      fs.stat(path.join(loopDir(designPrepare.workspace, designPrepare.fileKey, designPrepare.nodeId), 'loop-token.json')),
      /ENOENT/,
    )

    const otherDesignPrepare = await createDesignPrepareWorkspace()
    try {
      const otherHandoff = await runCli([
        'workflow-handoff',
        '--workspace',
        otherDesignPrepare.workspace,
        '--file-key',
        otherDesignPrepare.fileKey,
        '--node-id',
        otherDesignPrepare.nodeId,
        '--agent-id',
        'codex',
      ])
      assert.notEqual(new URL(otherHandoff.commands.openUrl).searchParams.get('token'), defaultToken)
    } finally {
      await fs.rm(otherDesignPrepare.workspace, { recursive: true, force: true })
    }

    const tokenBridgeServers = await createTokenBridgeServers()
    try {
      const codexHandoff = await runCli(
        [
          'workflow-handoff',
          '--workspace',
          designPrepare.workspace,
          '--file-key',
          designPrepare.fileKey,
          '--node-id',
          designPrepare.nodeId,
          '--agent-id',
          'codex',
          '--port',
          String(tokenBridgeServers.port),
        ],
        {
          env: {
            SLOTH_DISABLE_CODEX_TOKEN_BRIDGE: '0',
            CODEX_SHELL: '1',
            CODEX_THREAD_ID: 'test-thread',
          },
        },
	      )
	      assert.equal(codexHandoff.codexTokenBridge.enabled, false)
	      assert.equal(codexHandoff.codexTokenBridge.status, 'handled-by-prepare-first-run')
	      assert.equal(tokenBridgeServers.registrations.length, 0)
	      const bridgeLoopDir = loopDir(designPrepare.workspace, designPrepare.fileKey, designPrepare.nodeId)
	      await assert.rejects(fs.stat(path.join(bridgeLoopDir, 'codex-token-bridge.json')), /ENOENT/)
	      await assert.rejects(fs.stat(path.join(bridgeLoopDir, 'codex-token-bridge.log')), /ENOENT/)
    } finally {
      await tokenBridgeServers.close()
    }

    const handoff = await runCli([
      'workflow-handoff',
      '--workspace',
      designPrepare.workspace,
      '--file-key',
      designPrepare.fileKey,
      '--node-id',
      designPrepare.nodeId,
      '--agent-id',
      'codex',
      '--dev-port',
      '59999',
    ])
	    assert.equal(handoff.workflowPhase.phase, 'design_prepare')
	    assert.equal(handoff.nextEvent, null)
	    assert.equal(handoff.pendingEvents.length, 0)
	    assert.equal(handoff.allPendingEvents.length, 0)
	    assert.match(handoff.recommendedAction, /Start the Sloth workflow dev launcher/)
	    assert.match(handoff.recommendedAction, /commands\.prepareFirstRun/)
	    assert.equal(handoff.commands.openUrl, null)
	    assert.match(handoff.commands.startWorkflowDev, /start-workflow-dev\.mjs/)
	    assert.match(handoff.stopCondition, /commands\.prepareFirstRun/)
	    const guide = await runCli([
      'workflow-guide',
      '--workspace',
      designPrepare.workspace,
      '--file-key',
      designPrepare.fileKey,
      '--node-id',
      designPrepare.nodeId,
      '--agent-id',
      'codex',
      '--dev-port',
      '59999',
	    ])
	    const firstStep = guide.guide[0]
	    assert.equal(firstStep.step, 'prepare-first-run')
	    assert.equal(firstStep.command, handoff.commands.startWorkflowDev)
	    const waitStep = guide.guide.find((step) => step.step === 'wait-or-handle-event')
	    assert.equal(waitStep.status, 'return-to-user')
	    assert.equal(waitStep.command, null)
	  } finally {
	    await fs.rm(designPrepare.workspace, { recursive: true, force: true })
	  }

}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
