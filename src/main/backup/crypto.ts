import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'

const SHA256_PATTERN = /^[a-f0-9]{64}$/u

export function isSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256_PATTERN.test(value)
}

export function sha256Bytes(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const input = createReadStream(filePath)
    input.on('data', (chunk: Buffer) => hash.update(chunk))
    input.once('error', reject)
    input.once('end', resolve)
  })
  return hash.digest('hex')
}

/** Stable JSON used only for trusted metadata/checksums, never arbitrary cyclic data. */
export function stableJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value))
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue)
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) {
      result[key] = sortJsonValue(record[key])
    }
    return result
  }
  return value
}
