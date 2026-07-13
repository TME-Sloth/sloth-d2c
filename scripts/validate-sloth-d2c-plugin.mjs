#!/usr/bin/env node
import { promises as fs } from 'node:fs'
import path from 'node:path'

const pluginRoot = path.resolve('plugins/sloth-d2c')
const requiredFiles = [
  '.codex-plugin/plugin.json',
  'scripts/sloth-d2c-state.mjs',
  'scripts/start-workflow-dev.mjs',
  'scripts/test-sloth-d2c-state.mjs',
  'skills/sloth-d2c-workflow/SKILL.md',
  'skills/sloth-d2c-work/SKILL.md',
  'skills/sloth-d2c-design-diff/SKILL.md',
  'skills/sloth-d2c-components/SKILL.md',
]

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function readJson(relativePath) {
  return JSON.parse(await fs.readFile(path.join(pluginRoot, relativePath), 'utf8'))
}

async function main() {
  for (const relativePath of requiredFiles) {
    const filePath = path.join(pluginRoot, relativePath)
    const stat = await fs.stat(filePath).catch(() => null)
    assert(stat?.isFile(), `Missing required plugin file: ${relativePath}`)
  }

  const manifest = await readJson('.codex-plugin/plugin.json')
  assert(manifest.name === 'sloth-d2c', 'plugin.json name must be sloth-d2c')
  assert(typeof manifest.version === 'string' && manifest.version, 'plugin.json version is required')
  assert(manifest.skills === './skills/', 'plugin.json skills must point to ./skills/')
  assert(manifest.interface?.displayName === 'Sloth D2C', 'plugin displayName must be Sloth D2C')

  const skillDirs = await fs.readdir(path.join(pluginRoot, 'skills'), { withFileTypes: true })
  for (const entry of skillDirs) {
    if (!entry.isDirectory()) continue
    const skillRoot = path.join(pluginRoot, 'skills', entry.name)
    const skillPath = path.join(skillRoot, 'SKILL.md')
    const content = await fs.readFile(skillPath, 'utf8')
    assert(content.startsWith('---\n'), `${entry.name}/SKILL.md must start with frontmatter`)
    assert(content.includes('description:'), `${entry.name}/SKILL.md must include a description`)
    assert(!content.includes('~/plugins/sloth-d2c'), `${entry.name}/SKILL.md must not hardcode ~/plugins/sloth-d2c`)

    const metadataPath = path.join(skillRoot, 'agents/openai.yaml')
    const metadata = await fs.readFile(metadataPath, 'utf8').catch(() => null)
    assert(metadata, `${entry.name}/agents/openai.yaml is required for skill interface metadata`)

    for (const iconField of ['icon_small', 'icon_large']) {
      const match = metadata.match(new RegExp(`^\\s*${iconField}:\\s*["']([^"']+)["']\\s*$`, 'm'))
      assert(match, `${entry.name}/agents/openai.yaml must define ${iconField}`)

      const iconPath = path.resolve(skillRoot, match[1])
      const iconStat = await fs.stat(iconPath).catch(() => null)
      assert(iconStat?.isFile(), `${entry.name}/${match[1]} referenced by ${iconField} must exist`)
    }
  }

  console.log(`Sloth D2C plugin validation passed: ${pluginRoot}`)
}

main().catch((error) => {
  console.error(error.message || error)
  process.exit(1)
})
