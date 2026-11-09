// Release consistency check: package and kernel versions must match, and every
// version bump/tag must have a matching CHANGELOG section.
// Usage: node scripts/check-release.mjs
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const problems = []

const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
const packageVersion = String(pkg.version ?? '')

const cargo = await fs.readFile(path.join(root, 'kernel', 'Cargo.toml'), 'utf8')
const kernelVersion = cargo.match(/^\s*version\s*=\s*"([^"]+)"/m)?.[1] ?? ''

if (!packageVersion) problems.push('package.json has no version')
if (!kernelVersion) problems.push('kernel/Cargo.toml has no [package] version')
if (packageVersion && kernelVersion && packageVersion !== kernelVersion) {
  problems.push(`version mismatch: package.json=${packageVersion} kernel/Cargo.toml=${kernelVersion}`)
}

const changelogPath = path.join(root, 'CHANGELOG.md')
let changelog = ''
try {
  changelog = await fs.readFile(changelogPath, 'utf8')
} catch {
  problems.push('CHANGELOG.md is missing')
}
if (changelog) {
  const heading = new RegExp(`^## \\[${packageVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]`, 'm')
  if (!heading.test(changelog)) problems.push(`CHANGELOG.md has no "## [${packageVersion}]" section`)
  if (!/^#\s+Changelog/m.test(changelog)) problems.push('CHANGELOG.md has no "# Changelog" heading')
  if (!/Release\/tag policy/i.test(changelog)) problems.push('CHANGELOG.md has no release/tag policy note')
}

if (problems.length > 0) {
  console.error('release check: FAIL')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log(`release check: PASS (package=kernel=${packageVersion}, changelog section present)`)
