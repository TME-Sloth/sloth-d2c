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

function sessionDir(workspace, fileKey, nodeId) {
  return path.join(d2cDir(workspace, fileKey, nodeId), 'session')
}

function legacySessionDir(workspace, fileKey, nodeId) {
  return path.join(workspace, '.sloth', 'sessions', sessionId(fileKey, nodeId))
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
  const targetSessionDir = sessionDir(workspace, fileKey, nodeId)
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
  await writeJson(path.join(targetSessionDir, 'state.json'), {
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
  await writeJson(path.join(targetSessionDir, 'snapshots', 'v0002.json'), {
    snapshotId: 'v0002',
    version: 2,
    fileKey,
    nodeId,
    groupsData: [],
    canvasAnnotations,
    createdAt: now,
  })
  await fs.writeFile(
    path.join(targetSessionDir, 'events.jsonl'),
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
  const id = sessionId(fileKey, nodeId)
  const now = '2026-06-22T00:00:00.000Z'
  const targetD2cDir = d2cDir(workspace, fileKey, nodeId)
  const targetSessionDir = sessionDir(workspace, fileKey, nodeId)

  await fs.mkdir(path.join(targetD2cDir, 'chunks'), { recursive: true })
  await fs.writeFile(path.join(targetD2cDir, 'absolute.html'), '<html><body>first run</body></html>\n', 'utf8')
  await writeJson(path.join(targetD2cDir, 'groupsData.json'), [])
  await writeJson(path.join(targetSessionDir, 'state.json'), {
    sessionId: id,
    fileKey,
    nodeId,
    currentVersion: 1,
    createdAt: now,
    updatedAt: now,
    latestSnapshotId: 'v0001',
    agents: {},
  })
  await writeJson(path.join(targetSessionDir, 'snapshots', 'v0001.json'), {
    snapshotId: 'v0001',
    version: 1,
    fileKey,
    nodeId,
    groupsData: [],
    canvasAnnotations: [],
    createdAt: now,
  })
  await fs.writeFile(
    path.join(targetSessionDir, 'events.jsonl'),
    `${JSON.stringify({
      id: 'evt_saved',
      sessionId: id,
      version: 1,
      snapshotId: 'v0001',
      type: 'annotation.saved',
      source: 'human',
      payload: {
        summary: '保存首轮标注',
        intent: 'review',
      },
      createdAt: now,
    })}\n`,
    'utf8',
  )

  return { workspace, fileKey, nodeId }
}

async function createSubmittedWorkspace() {
  const { workspace, fileKey, nodeId } = await createDesignPrepareWorkspace()
  const id = sessionId(fileKey, nodeId)
  const now = '2026-06-22T00:01:00.000Z'
  await fs.appendFile(
    path.join(sessionDir(workspace, fileKey, nodeId), 'events.jsonl'),
    `${JSON.stringify({
      id: 'evt_workflow',
      sessionId: id,
      version: 2,
      snapshotId: 'v0002',
      type: 'workflow.submitted',
      source: 'human',
      payload: {
        summary: '提交首轮生成',
        intent: 'generate',
      },
      createdAt: now,
    })}\n`,
    'utf8',
  )
  return { workspace, fileKey, nodeId }
}

async function createSubmittedNoGroupChunksCompleteWorkspace() {
  const submitted = await createSubmittedWorkspace()
  const chunkDir = path.join(d2cDir(submitted.workspace, submitted.fileKey, submitted.nodeId), 'chunks')
  await fs.writeFile(path.join(chunkDir, 'codeAggregation.md'), '# aggregate prompt\n', 'utf8')
  await fs.writeFile(path.join(chunkDir, 'finalGenerate.md'), '# final prompt\n', 'utf8')
  return submitted
}

async function createLegacyWorkspace() {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'sloth-d2c-legacy-session-'))
  const fileKey = 'legacyFile'
  const nodeId = 'node_1'
  const id = sessionId(fileKey, nodeId)
  const now = '2026-06-22T00:00:00.000Z'
  const targetD2cDir = d2cDir(workspace, fileKey, nodeId)
  const targetLegacySessionDir = legacySessionDir(workspace, fileKey, nodeId)

  await fs.mkdir(path.join(targetD2cDir, 'chunks'), { recursive: true })
  await fs.writeFile(path.join(targetD2cDir, 'absolute.html'), '<html><body>legacy</body></html>\n', 'utf8')
  await fs.writeFile(path.join(targetD2cDir, 'chunks', 'chunk.md'), '# legacy chunk\n', 'utf8')
  await writeJson(path.join(targetD2cDir, 'groupsData.json'), [])
  await writeJson(path.join(targetLegacySessionDir, 'state.json'), {
    sessionId: id,
    fileKey,
    nodeId,
    currentVersion: 1,
    createdAt: now,
    updatedAt: now,
    latestSnapshotId: 'v0001',
    agents: {},
  })
  await writeJson(path.join(targetLegacySessionDir, 'snapshots', 'v0001.json'), {
    snapshotId: 'v0001',
    version: 1,
    fileKey,
    nodeId,
    groupsData: [],
    canvasAnnotations: [],
    createdAt: now,
  })
  await fs.writeFile(
    path.join(targetLegacySessionDir, 'events.jsonl'),
    `${JSON.stringify({
      id: 'evt_workflow_legacy',
      sessionId: id,
      version: 1,
      snapshotId: 'v0001',
      type: 'workflow.submitted',
      source: 'human',
      payload: {
        summary: '旧目录首轮提交',
        intent: 'generate',
      },
      createdAt: now,
    })}\n`,
    'utf8',
  )

  return { workspace, fileKey, nodeId }
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

    process.stdout.write('sloth-d2c-state tests passed\n')
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    await fs.rm(workspace, { recursive: true, force: true })
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
    assert.equal(defaultHandoff.allPendingEvents.length, 1)
    assert.match(defaultHandoff.recommendedAction, /Open the interceptor/)
    assert.match(defaultHandoff.recommendedAction, /Use shell open\/system default browser\/Chrome only if the Codex in-app browser is unavailable or control fails/)
    assert.match(defaultHandoff.commands.openUrl, /localhost:3100\/auth-page/)
    assert.equal(defaultHandoff.commands.startWorkflowDev, null)
    assert.deepEqual(defaultHandoff.warnings, [])

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
      assert.equal(codexHandoff.codexTokenBridge.enabled, true)
      assert.equal(codexHandoff.codexTokenBridge.status, 'started')
      assert.equal(codexHandoff.codexTokenBridge.token, `sloth-d2c-${sessionId(designPrepare.fileKey, designPrepare.nodeId)}`)
      await waitFor(() => tokenBridgeServers.registrations.length > 0)
      assert.equal(tokenBridgeServers.registrations.length, 1)
      assert.equal(tokenBridgeServers.registrations[0].token, codexHandoff.codexTokenBridge.token)
      assert.equal(tokenBridgeServers.registrations[0].extra.workspaceRoot, designPrepare.workspace)
      assert.equal(tokenBridgeServers.registrations[0].extra.source, 'codex-app-sloth-workflow')
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
    assert.equal(handoff.allPendingEvents.length, 1)
    assert.match(handoff.recommendedAction, /Start the Sloth workflow dev launcher/)
    assert.match(handoff.recommendedAction, /Use shell open\/system default browser\/Chrome only if the Codex in-app browser is unavailable or control fails/)
    assert.equal(handoff.commands.openUrl, null)
    assert.match(handoff.commands.startWorkflowDev, /start-workflow-dev\.mjs/)
    assert.match(handoff.stopCondition, /Stop after opening the interceptor/)
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
    const waitStep = guide.guide.find((step) => step.step === 'wait-or-handle-event')
    assert.equal(waitStep.status, 'return-to-user')
    assert.equal(waitStep.command, null)
  } finally {
    await fs.rm(designPrepare.workspace, { recursive: true, force: true })
  }

  const submitted = await createSubmittedWorkspace()
  try {
    const handoff = await runCli([
      'workflow-handoff',
      '--workspace',
      submitted.workspace,
      '--file-key',
      submitted.fileKey,
      '--node-id',
      submitted.nodeId,
      '--agent-id',
      'codex',
    ])
    assert.equal(handoff.workflowPhase.phase, 'initial_generation_requested')
    assert.equal(handoff.nextEvent.id, 'evt_workflow')
    assert.equal(handoff.initialGeneration.mustRunSlothD2cBeforeCoding, true)
    assert.equal(handoff.initialGeneration.chunkStatus.needsSlothD2c, true)
    assert.match(handoff.recommendedAction, /sloth d2c atomic command/)
    assert.match(handoff.commands.generateChunks, /ensure-initial-chunks/)
    assert.match(handoff.commands.generateChunks, /--prefer-repo-cli/)
    assert.match(handoff.commands.rawSlothD2c, /sloth.*d2c/)
    assert.match(handoff.commands.rawSlothD2cDevFallback, /run\.js.*d2c/)
    assert.doesNotMatch(handoff.commands.rawSlothD2c, /--local/)
    assert.match(handoff.commands.rawSlothD2c, /--silent/)
    const guide = await runCli([
      'workflow-guide',
      '--workspace',
      submitted.workspace,
      '--file-key',
      submitted.fileKey,
      '--node-id',
      submitted.nodeId,
      '--agent-id',
      'codex',
    ])
    const waitStep = guide.guide.find((step) => step.step === 'wait-or-handle-event')
    assert.equal(waitStep.command, handoff.commands.generateChunks)

    const localHandoff = await runCli([
      'workflow-handoff',
      '--workspace',
      submitted.workspace,
      '--file-key',
      submitted.fileKey,
      '--node-id',
      submitted.nodeId,
      '--agent-id',
      'codex',
      '--local',
    ])
    assert.match(localHandoff.commands.generateChunks, /--local/)
    assert.match(localHandoff.commands.rawSlothD2c, /--local/)
  } finally {
    await fs.rm(submitted.workspace, { recursive: true, force: true })
  }

  const noGroupComplete = await createSubmittedNoGroupChunksCompleteWorkspace()
  try {
    const handoff = await runCli([
      'workflow-handoff',
      '--workspace',
      noGroupComplete.workspace,
      '--file-key',
      noGroupComplete.fileKey,
      '--node-id',
      noGroupComplete.nodeId,
      '--agent-id',
      'codex',
    ])
    assert.equal(handoff.workflowPhase.phase, 'initial_generation_requested')
    assert.equal(handoff.initialGeneration.chunkStatus.expectedGroupCount, 0)
    assert.equal(handoff.initialGeneration.chunkStatus.groupChunkCount, 0)
    assert.equal(handoff.initialGeneration.chunkStatus.hasCodeAggregation, true)
    assert.equal(handoff.initialGeneration.chunkStatus.hasFinalGenerate, true)
    assert.equal(handoff.initialGeneration.chunkStatus.needsSlothD2c, false)
    assert.equal(handoff.initialGeneration.mustRunSlothD2cBeforeCoding, false)
  } finally {
    await fs.rm(noGroupComplete.workspace, { recursive: true, force: true })
  }

  const legacy = await createLegacyWorkspace()
  try {
    const handoff = await runCli([
      'workflow-handoff',
      '--workspace',
      legacy.workspace,
      '--file-key',
      legacy.fileKey,
      '--node-id',
      legacy.nodeId,
      '--agent-id',
      'codex',
    ])
    assert.equal(handoff.workflowPhase.phase, 'initial_generation_requested')
    assert.equal(handoff.nextEvent.id, 'evt_workflow_legacy')
    assert.equal(await fs.stat(path.join(sessionDir(legacy.workspace, legacy.fileKey, legacy.nodeId), 'state.json')).then(() => true), true)
  } finally {
    await fs.rm(legacy.workspace, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
