import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { BackupError, sha256File, WindowsAtomicFileSwitch } from '../../../src/main/backup'

describe('WindowsAtomicFileSwitch', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(resolve(tmpdir(), 'todo-switch-'))
  })
  afterEach(async () => rm(root, { recursive: true, force: true }))

  it('moves only the expected source into an absent destination', async () => {
    const source = resolve(root, 'source')
    const destination = resolve(root, 'destination')
    await writeFile(source, 'A')
    await new WindowsAtomicFileSwitch().moveExpectedFile({
      sourcePath: source,
      destinationPath: destination,
      expectedSourceSha256: await sha256File(source),
    })
    await expect(readFile(destination, 'utf8')).resolves.toBe('A')
    await expect(readFile(source)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('recognizes a completed rename even when Windows reports an error', async () => {
    const source = resolve(root, 'source')
    const destination = resolve(root, 'destination')
    await writeFile(source, 'A')
    const switcher = new WindowsAtomicFileSwitch({
      async rename(left, right) {
        await rename(left, right)
        throw new Error('simulated late I/O error')
      },
    })
    await expect(
      switcher.moveExpectedFile({
        sourcePath: source,
        destinationPath: destination,
        expectedSourceSha256: await sha256File(source),
      }),
    ).resolves.toBeUndefined()
  })

  it('never overwrites an existing destination', async () => {
    const source = resolve(root, 'source')
    const destination = resolve(root, 'destination')
    await writeFile(source, 'A')
    await writeFile(destination, 'B')
    await expect(
      new WindowsAtomicFileSwitch().moveExpectedFile({
        sourcePath: source,
        destinationPath: destination,
        expectedSourceSha256: await sha256File(source),
      }),
    ).rejects.toBeInstanceOf(BackupError)
    await expect(readFile(destination, 'utf8')).resolves.toBe('B')
  })
})
