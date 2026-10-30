// Download to disk via the browser Blob path. Copy into a standalone
// ArrayBuffer to satisfy TS's BlobPart ArrayBufferLike constraint (TS 5.7+).

export function saveBlob(bytes: Uint8Array, name: string, mimeType: string | null): void {
  const copy = new Uint8Array(bytes.length)
  copy.set(bytes)
  const blob = new Blob([copy], { type: mimeType ?? 'application/octet-stream' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}
