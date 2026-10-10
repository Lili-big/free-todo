import { parseBackupManifest, serializeBackupManifest } from '../../../src/main/backup'
import { compatibility, manifest } from './helpers'

describe('backup manifest', () => {
  it('round trips a strict V1 manifest', () => {
    const expected = manifest('c'.repeat(64), 123)
    expect(parseBackupManifest(serializeBackupManifest(expected), compatibility())).toEqual(expected)
  })

  it('rejects unknown machine-specific metadata', () => {
    const value = { ...manifest('c'.repeat(64), 123), sourceAbsolutePath: 'C:\\Users\\name' }
    expect(() =>
      parseBackupManifest(Buffer.from(JSON.stringify(value)), compatibility()),
    ).toThrow('unknown fields')
  })

  it('rejects higher and unpublished schema versions', () => {
    const value = { ...manifest('c'.repeat(64), 123), schemaVersion: 2 }
    expect(() =>
      parseBackupManifest(Buffer.from(JSON.stringify(value)), compatibility()),
    ).toThrow('not supported')
  })
})
