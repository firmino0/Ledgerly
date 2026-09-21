import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Path of a file in the data folder (project data/, or LEDGERLY_DATA_DIR so tests never touch real data). */
export const dataPath = (name: string) =>
  process.env.LEDGERLY_DATA_DIR ? join(process.env.LEDGERLY_DATA_DIR, name) : fileURLToPath(new URL(`../data/${name}`, import.meta.url))

export function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

/** Atomic write (temp file + rename) so a crash mid-write never leaves a half-written state file. */
export function writeJson(file: string, value: unknown): void {
  if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2))
  renameSync(tmp, file)
}

/** Bumped whenever balances change (a trade executes), so cached views know to refresh. */
let version = 0
export const bumpVersion = () => ++version
export const getVersion = () => version
