#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import http from 'node:http'
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

function workDir(workspace, fileKey, nodeId) {
  return path.join(d2cDir(workspace, fileKey, nodeId), 'work')
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function appendWorkEvent(workspace, fileKey, nodeId, event) {
  await fs.appendFile(path.join(workDir(workspace, fileKey, nodeId), 'events.jsonl'), `${JSON.stringify(event)}\n`, 'utf8')
}

async function runCli(args, options = {}) {
  const { stdout } = await execFileAsync(process.execPath, [scriptPath, ...args], {
    maxBuffer: 10 * 1024 * 1024,
    ...options,
    env: {
      ...process.env,
      ...(options.env || {}),
    },
  })
  return JSON.parse(stdout)
}

function runWorkflowHandoff(workspace, fileKey, nodeId, devPort) {
  return runCli([
    'workflow-handoff',
    '--workspace',
    workspace,
    '--file-key',
    fileKey,
    '--node-id',
    nodeId,
    '--dev-port',
    String(devPort),
  ])
}

function completeTestEvent(workspace, fileKey, nodeId, eventId, summary) {
  return runCli([
    'complete-event',
    '--workspace',
    workspace,
    '--file-key',
    fileKey,
    '--node-id',
    nodeId,
    '--event-ids',
    eventId,
    '--summary',
    summary,
  ])
}

async function createWorkspace() {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'sloth-d2c-state-'))
  const fileKey = 'testFile'
  const nodeId = 'node_1'
  const id = sessionId(fileKey, nodeId)
  const now = '2026-06-22T00:00:00.000Z'
  const targetD2cDir = d2cDir(workspace, fileKey, nodeId)
  const targetWorkDir = workDir(workspace, fileKey, nodeId)
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
  await fs.writeFile(path.join(targetD2cDir, 'screenshots', 'index.png'), 'design baseline\n', 'utf8')
  await fs.writeFile(path.join(targetD2cDir, 'chunks', 'chunk.md'), '# chunk\n', 'utf8')
  await writeJson(path.join(targetD2cDir, 'groupsData.json'), [])
  await writeJson(path.join(targetWorkDir, 'state.json'), {
    workId: id,
    fileKey,
    nodeId,
    currentVersion: 2,
    createdAt: now,
    updatedAt: now,
    latestSnapshotId: 'v0002',
    handledEventIds: ['evt_seed'],
    implementationUrl: 'http://127.0.0.1:9999/',
  })
  await writeJson(path.join(targetWorkDir, 'snapshots', 'v0002.json'), {
    snapshotId: 'v0002',
    version: 2,
    fileKey,
    nodeId,
    groupsData: [],
    canvasAnnotations,
    createdAt: now,
  })
  await fs.writeFile(
    path.join(targetWorkDir, 'events.jsonl'),
    `${JSON.stringify({
      id: 'evt_annotation',
      workId: id,
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
const runId = 'd2c-run-test';
console.log(JSON.stringify({
  ok: true,
  action: 'open_browser_and_wait',
  interceptorUrl: 'http://localhost:3100/auth-page?token=sloth-d2c-test-token&fileKey=' + encodeURIComponent(fileKey) + '&nodeId=' + encodeURIComponent(nodeId) + '&mode=create',
  wait: {
    command: "sloth d2c wait --file-key '" + fileKey + "' --node-id '" + nodeId + "' --run-id '" + runId + "' --json"
  }
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
      '--dev-port',
      String(address.port),
    ])
    assert.equal(handoff.commands.openUrl, handoff.preferredInterceptorUrl)
    assert.match(handoff.commands.openUrl, new RegExp(`127\\.0\\.0\\.1:${address.port}`))
    assert.equal(handoff.state.workId, sessionId(fileKey, nodeId))
    assert.equal(handoff.workflowPhase.phase, 'implementation_annotations_requested')
    assert.equal(handoff.nextEvent.id, 'evt_annotation')
    assert.equal(handoff.eventBrief.changedCanvasAnnotations.length, 1)
    assert.equal(handoff.eventBrief.changedCanvasAnnotations[0].id, 'anno_new')
    assert.equal(handoff.eventBrief.groups.length, 0)
    assert.equal(handoff.eventBrief.snapshot, null)
    assert.equal(handoff.eventBrief.canvasAnnotations, undefined)
    assert.equal(handoff.eventBrief.canvasAnnotationCount, 0)

    const brief = await runCli([
      'event-brief',
      '--workspace',
      workspace,
      '--file-key',
      fileKey,
      '--node-id',
      nodeId,
    ])
    assert.equal(brief.eventBrief.changedCanvasAnnotations.length, 1)
    assert.equal(brief.eventBrief.changedCanvasAnnotations[0].text, '只处理本次新增画布标注')
    assert.equal(brief.eventBrief.snapshot, null)
    assert.equal(brief.eventBrief.canvasAnnotations, undefined)
    assert.equal(brief.eventBrief.canvasAnnotationCount, 0)

    const complete = await runCli([
      'complete-event',
      '--workspace',
      workspace,
      '--file-key',
      fileKey,
      '--node-id',
      nodeId,
      '--event-ids',
      'evt_annotation',
      '--summary',
      'handled',
    ])
    assert.equal(complete.remainingPendingCount, 0)
    assert.deepEqual(complete.acknowledgedEventIds, ['evt_annotation'])
    assert.deepEqual(complete.state.handledEventIds, ['evt_seed', 'evt_annotation'])

    const autoResolvedOpen = await runCli([
      'open-interceptor',
      '--workspace',
      workspace,
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
    assert.match(autoResolvedOpen.stopCondition, /If the user asked to open/)

    const resolvedOpen = await runCli([
      'open-interceptor',
      '--workspace',
      workspace,
      '--file-key',
      fileKey,
      '--node-id',
      nodeId,
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
    assert.match(workbenchOpen.seededWorkbench.files.absoluteHtml, /\.sloth\/__workbench__\/prompt-lab\/absolute\.html$/)
    await fs.stat(path.join(d2cDir(workspace, '__workbench__', 'prompt-lab'), 'absolute.html'))
    await fs.stat(path.join(workDir(workspace, '__workbench__', 'prompt-lab'), 'state.json'))

    const reopenedWorkbench = await runCli([
      'open-interceptor',
      '--workspace',
      workspace,
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
    ])
	    assert.equal(defaultHandoff.workflowPhase.phase, 'design_prepare')
	    assert.equal(defaultHandoff.state.workId, sessionId(designPrepare.fileKey, designPrepare.nodeId))
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
	    assert.equal(defaultHandoff.codexBrowserOpen.enabled, true)
	    assert.equal(defaultHandoff.codexBrowserOpen.skill, 'browser:control-in-app-browser')
	    assert.equal(defaultHandoff.codexBrowserOpen.target, 'iab')
	    assert.equal(defaultHandoff.codexBrowserOpen.urlSource, 'commands.prepareFirstRun.interceptorUrl')
	    assert.equal(defaultHandoff.codexBrowserOpen.afterOpen, 'wait-for-sloth-event')
	    const cliEnvironmentHandoff = await runCli(
	      [
	        'workflow-handoff',
	        '--workspace',
	        designPrepare.workspace,
	        '--file-key',
	        designPrepare.fileKey,
	        '--node-id',
	        designPrepare.nodeId,
	      ],
	      { env: { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'Codex CLI' } },
	    )
	    assert.equal(new URL(cliEnvironmentHandoff.commands.openUrl).searchParams.get('codexApp'), null)
	    const appEnvironmentHandoff = await runCli(
	      [
	        'workflow-handoff',
	        '--workspace',
	        designPrepare.workspace,
	        '--file-key',
	        designPrepare.fileKey,
	        '--node-id',
	        designPrepare.nodeId,
	      ],
	      { env: { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'Codex Desktop' } },
	    )
	    assert.equal(new URL(appEnvironmentHandoff.commands.openUrl).searchParams.get('codexApp'), '1')
	    assert.match(defaultHandoff.commands.generateChunks, /ensure-initial-chunks/)
	    assert.doesNotMatch(defaultHandoff.commands.generateChunks, /--auto-grouping/)
	    assert.deepEqual(Object.keys(defaultHandoff.commands).sort(), [
	      'annotationWorkflow',
	      'eventBrief',
	      'generateChunks',
	      'installSlothNpm',
	      'installSlothPnpm',
	      'openUrl',
	      'prepareFirstRun',
	      'setImplementationUrl',
	      'startWorkflowDev',
	      'verifySloth',
	      'waitNextEvent',
	    ].sort())
	    assert.equal(defaultHandoff.repairBrief, undefined)
	    assert.deepEqual(defaultHandoff.warnings, [])
	    const autoGroupingHandoff = await runCli([
	      'workflow-handoff',
	      '--workspace',
	      designPrepare.workspace,
	      '--file-key',
	      designPrepare.fileKey,
	      '--node-id',
	      designPrepare.nodeId,
	      '--auto-grouping',
	    ])
	    assert.match(autoGroupingHandoff.commands.generateChunks, /--auto-grouping/)
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
	      ],
	      {
	        env: {
	          PATH: `${fakeSlothBin}${path.delimiter}${process.env.PATH}`,
	          CODEX_SHELL: '1',
	        },
	      },
	    )
	    assert.equal(prepared.ok, true)
	    assert.equal(prepared.action, 'open_browser_and_wait')
	    assert.match(prepared.command, /sloth.*d2c/)
	    assert.equal(prepared.interceptorUrl, `http://localhost:3100/auth-page?token=sloth-d2c-test-token&fileKey=${designPrepare.fileKey}&nodeId=${designPrepare.nodeId}&mode=create`)
	    assert.equal(prepared.codexBrowserOpen.url, prepared.interceptorUrl)
	    assert.equal(prepared.codexBrowserOpen.urlSource, 'prepare-interceptor.interceptorUrl')
	    assert.match(prepared.wait.command, /sloth d2c wait/)
	    assert.deepEqual(Object.keys(prepared.wait), ['command'])
	    assert.equal('listenerStatus' in prepared, false)
	    assert.equal('pollTargets' in prepared, false)
	    assert.equal('pollPolicy' in prepared, false)
	    assert.match(prepared.stopCondition, /no business timeout/)
	    assert.equal('prepared' in prepared, false)
	    assert.equal('reason' in prepared, false)
	    assert.equal('handoffPaths' in prepared, false)
	    assert.equal('forbidden' in prepared, false)
	    assert.equal('commands' in prepared, false)
	    assert.equal('d2cDir' in prepared, false)
	    assert.equal('copiedFiles' in prepared, false)
	    const silentHandoff = await runCli([
	      'workflow-handoff',
	      '--workspace',
	      designPrepare.workspace,
	      '--file-key',
	      designPrepare.fileKey,
	      '--node-id',
	      designPrepare.nodeId,
	      '--silent',
	    ])
	    assert.equal(silentHandoff.interceptorMode, 'silent')
	    assert.equal(silentHandoff.commands.prepareFirstRun, null)
	    assert.match(silentHandoff.commands.generateChunks, /ensure-initial-chunks/)
	    assert.equal(silentHandoff.codexBrowserOpen, null)
	    assert.match(silentHandoff.recommendedAction, /Do not open the interceptor/)
	    const submittedFirstRun = await createDesignPrepareWorkspace()
	    try {
	      const submittedChunksDir = path.join(d2cDir(submittedFirstRun.workspace, submittedFirstRun.fileKey, submittedFirstRun.nodeId), 'chunks')
	      await fs.mkdir(submittedChunksDir, { recursive: true })
	      await Promise.all([
	        fs.writeFile(path.join(submittedChunksDir, '0.md'), '# group 0'),
	        fs.writeFile(path.join(submittedChunksDir, '1.md'), '# group 1'),
	        fs.writeFile(path.join(submittedChunksDir, 'codeAggregation.md'), '# aggregation'),
	        fs.writeFile(path.join(submittedChunksDir, 'finalGenerate.md'), '# final'),
	      ])
	      await writeJson(path.join(d2cDir(submittedFirstRun.workspace, submittedFirstRun.fileKey, submittedFirstRun.nodeId), 'submission.json'), {
	        status: 'submitted',
	        groupCount: 2,
	      })
	      const submittedHandoff = await runCli([
	        'workflow-handoff',
	        '--workspace',
	        submittedFirstRun.workspace,
	        '--file-key',
	        submittedFirstRun.fileKey,
	        '--node-id',
	        submittedFirstRun.nodeId,
	      ])
	      assert.equal(submittedHandoff.workflowPhase.phase, 'initial_generation_requested')
	      assert.equal(submittedHandoff.workflowPhase.waitingFor, 'codex-initial-generation')
	      assert.equal(submittedHandoff.nextEvent, null)
	      assert.equal(submittedHandoff.pendingEvents.length, 0)
	      assert.equal(submittedHandoff.submission.groupCount, 2)
	      assert.match(submittedHandoff.submission.path, /submission\.json$/)
	      assert.match(submittedHandoff.recommendedAction, /submission\.json/)
	      assert.equal(submittedHandoff.initialGeneration.mustRunSlothD2cBeforeCoding, false)
	      await assert.rejects(fs.stat(workDir(submittedFirstRun.workspace, submittedFirstRun.fileKey, submittedFirstRun.nodeId)), /ENOENT/)
	    } finally {
	      await fs.rm(submittedFirstRun.workspace, { recursive: true, force: true })
	    }
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
    ])
    assert.notEqual(new URL(repeatedHandoff.commands.openUrl).searchParams.get('token'), defaultToken)
    await assert.rejects(
      fs.stat(path.join(workDir(designPrepare.workspace, designPrepare.fileKey, designPrepare.nodeId), 'work-token.json')),
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
      ])
      assert.notEqual(new URL(otherHandoff.commands.openUrl).searchParams.get('token'), defaultToken)
    } finally {
      await fs.rm(otherDesignPrepare.workspace, { recursive: true, force: true })
    }

    const handoff = await runCli([
      'workflow-handoff',
      '--workspace',
      designPrepare.workspace,
      '--file-key',
      designPrepare.fileKey,
      '--node-id',
      designPrepare.nodeId,
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
	    assert.match(handoff.stopCondition, /blocking wait\.command/)
	    assert.match(handoff.stopCondition, /no business timeout/)
	  } finally {
	    await fs.rm(designPrepare.workspace, { recursive: true, force: true })
	  }

  const invalidWork = await createDesignPrepareWorkspace()
  try {
    await writeJson(path.join(workDir(invalidWork.workspace, invalidWork.fileKey, invalidWork.nodeId), 'state.json'), {
      fileKey: invalidWork.fileKey,
      nodeId: invalidWork.nodeId,
      currentVersion: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      handledEventIds: [],
    })
    await assert.rejects(
      runCli([
        'workflow-handoff',
        '--workspace',
        invalidWork.workspace,
        '--file-key',
        invalidWork.fileKey,
        '--node-id',
        invalidWork.nodeId,
      ]),
      /Invalid work state: missing workId/,
    )
  } finally {
    await fs.rm(invalidWork.workspace, { recursive: true, force: true })
  }

}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
