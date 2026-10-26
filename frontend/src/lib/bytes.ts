// Byte and hash utilities (browser-native, no Node Buffer dependency).

export const toHex = (bytes: Uint8Array): string => {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

export const fromHex = (hex: string): Uint8Array => {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

export const concatBytes = (parts: Uint8Array[]): Uint8Array => {
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

export const sha256Hex = async (data: ArrayBuffer | Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', data as BufferSource)
  return toHex(new Uint8Array(digest))
}

export const formatAi3 = (shannons: bigint): string => {
  const ai3 = Number(shannons) / 1e18
  return ai3 >= 0.01 ? ai3.toFixed(4) : ai3.toPrecision(4)
}

export const formatBytes = (n: number): string => {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`
  return `${(n / 1024 / 1024).toFixed(2)} MiB`
}
