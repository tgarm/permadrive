/** Read-only preflight: a late result cannot advance a stopped workflow. */
export async function resumeRead<T>(phase: string, label: string, action: () => Promise<T>, report: (message: string) => void, timeoutMessage: string, timeoutMs = 60_000): Promise<T> {
  const start = Date.now()
  report(label)
  console.info(`[PermaDrive save] ${phase}: start`)
  const heartbeat = setInterval(() => {
    console.info(`[PermaDrive save] ${phase}: waiting ${Math.floor((Date.now() - start) / 1000)}s`)
  }, 15_000)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([Promise.resolve().then(action), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} — ${timeoutMessage}`)), timeoutMs)
    })])
    console.info(`[PermaDrive save] ${phase}: complete (${Date.now() - start}ms)`)
    return result
  } catch (error) {
    console.warn(`[PermaDrive save] ${phase}: stopped`, error instanceof Error ? error.message : 'Unknown error')
    throw error
  } finally { clearTimeout(timer); clearInterval(heartbeat) }
}
