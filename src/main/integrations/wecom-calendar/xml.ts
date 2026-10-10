const XML_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'"
}

export function decodeXmlText(value: string): string {
  const withoutCdata = value.trim().startsWith('<![CDATA[') && value.trim().endsWith(']]>')
    ? value.trim().slice(9, -3)
    : value
  return withoutCdata.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, token: string) => {
    if (token.startsWith('#x')) return String.fromCodePoint(Number.parseInt(token.slice(2), 16))
    if (token.startsWith('#')) return String.fromCodePoint(Number.parseInt(token.slice(1), 10))
    return XML_ENTITIES[token.toLowerCase()] ?? entity
  })
}

function escapedName(localName: string): string {
  return localName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function elementContents(xml: string, localName: string): string[] {
  const name = escapedName(localName)
  const expression = new RegExp(
    `<(?:[A-Za-z_][\\w.-]*:)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z_][\\w.-]*:)?${name}\\s*>`,
    'gi'
  )
  return [...xml.matchAll(expression)].map((match) => match[1] ?? '')
}

export function hasElement(xml: string, localName: string): boolean {
  const name = escapedName(localName)
  return new RegExp(`<(?:[A-Za-z_][\\w.-]*:)?${name}(?:\\s|/|>)`, 'i').test(xml)
}

export function firstDecodedElement(xml: string, localName: string): string | null {
  const content = elementContents(xml, localName)[0]
  return content === undefined ? null : decodeXmlText(content).trim()
}

export function propertyHref(xml: string, propertyName: string): string | null {
  const property = elementContents(xml, propertyName)[0]
  if (property === undefined) return null
  return firstDecodedElement(property, 'href')
}
