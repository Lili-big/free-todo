import { BackupError, canonicalDomainDigest } from '../../../src/main/backup'

describe('canonicalDomainDigest', () => {
  it('is independent of row and object-property order', () => {
    const first = canonicalDomainDigest({
      tables: [
        {
          name: 'tasks',
          primaryKey: ['id'],
          columns: ['id', 'title', 'done'],
          rows: [
            { id: '2', title: 'second', done: false },
            { id: '1', title: 'first', done: true },
          ],
        },
      ],
    })
    const second = canonicalDomainDigest({
      tables: [
        {
          name: 'tasks',
          primaryKey: ['id'],
          columns: ['id', 'title', 'done'],
          rows: [
            { done: true, title: 'first', id: '1' },
            { title: 'second', id: '2', done: false },
          ],
        },
      ],
    })
    expect(second).toBe(first)
  })

  it('changes when a migratable value changes', () => {
    const digest = (title: string): string =>
      canonicalDomainDigest({
        tables: [
          {
            name: 'tasks',
            primaryKey: ['id'],
            columns: ['id', 'title'],
            rows: [{ id: '1', title }],
          },
        ],
      })
    expect(digest('甲')).not.toBe(digest('乙'))
  })

  it('rejects physical metadata tables and data_epoch', () => {
    expect(() =>
      canonicalDomainDigest({
        tables: [{ name: 'database_meta', primaryKey: ['id'], columns: ['id'], rows: [] }],
      }),
    ).toThrow(BackupError)
    expect(() =>
      canonicalDomainDigest({
        tables: [
          {
            name: 'settings',
            primaryKey: ['id'],
            columns: ['id', 'data_epoch'],
            rows: [],
          },
        ],
      }),
    ).toThrow('data_epoch')
  })
})
