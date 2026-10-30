// On-chain private messages: conversation list (grouped by counterparty) +
// detail + compose-by-address + reply + unread badges. Content is end-to-end
// encrypted; who talks to whom, when, and ciphertext length are public (noted
// at the top). On mount: ensureAnnounced (idempotent) + syncMessages (getLogs
// cursor), plus a quiet 30s poll while open. Received plaintext is cached in
// IndexedDB; the outbox plaintext is local-only (not restored on a new device).

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSigner } from '../signer-context'
import { ensureAnnounced, sendEncryptedMessage, syncMessages } from '../lib/mailbox'
import { listMessages, markMessageRead, type MessageRecord } from '../lib/store'
import { useI18n } from '../i18n'

const shortAddr = (a: string): string => `${a.slice(0, 8)}…${a.slice(-6)}`

export function MessagesPage() {
  const { t } = useI18n()
  const { evm } = useSigner()
  const me = evm?.address.toLowerCase() ?? null
  const [messages, setMessages] = useState<MessageRecord[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [composing, setComposing] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [to, setTo] = useState('')
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => setMessages(await listMessages()), [])

  const sync = useCallback(async () => {
    if (!evm) return
    try {
      const r = await ensureAnnounced(evm)
      setStatus(r.txHash ? t('messages.announceTx', [r.txHash.slice(0, 14) + '…']) : t('messages.announceOk'))
    } catch (e) {
      setStatus(t('messages.announceFailed', [(e as Error).message]))
    }
    try {
      const r = await syncMessages(evm.address, evm)
      if (r.scanned > 0) setStatus(t('messages.syncDone', [r.inbox, r.outbox]))
    } catch (e) {
      setStatus(t('messages.syncFailed', [(e as Error).message]))
    }
    await refresh()
  }, [evm, refresh])

  useEffect(() => {
    void refresh()
  }, [refresh])
  useEffect(() => {
    if (evm) void sync()
  }, [sync])
  // quiet polling while the page is open (incoming mail; announce is idempotent, no duplicate transactions)
  useEffect(() => {
    if (!evm) return
    const iv = setInterval(() => {
      void (async () => {
        try {
          const r = await syncMessages(evm.address, evm)
          if (r.scanned > 0) await refresh()
        } catch {
          // polling failures stay silent (rate limits etc.); the next round retries
        }
      })()
    }, 30_000)
    return () => clearInterval(iv)
  }, [evm, refresh])

  const conversations = useMemo(() => {
    const byPeer = new Map<string, MessageRecord[]>()
    for (const m of messages) {
      if (!me || (m.from !== me && m.to !== me)) continue
      const peer = m.from === me ? m.to : m.from
      const list = byPeer.get(peer) ?? []
      list.push(m)
      byPeer.set(peer, list)
    }
    for (const list of byPeer.values()) list.sort((a, b) => a.at - b.at)
    return [...byPeer.entries()]
      .map(([peer, list]) => ({
        peer,
        last: list[list.length - 1],
        unread: list.filter((m) => !m.sentByMe && !m.read).length,
        total: list.length,
      }))
      .sort((a, b) => b.last.at - a.last.at)
  }, [messages, me])

  const selectedThread = useMemo(() => {
    if (!selected || !me) return []
    const list = messages.filter((m) => (m.from === me && m.to === selected) || (m.from === selected && m.to === me))
    list.sort((a, b) => a.at - b.at)
    return list
  }, [messages, selected, me])

  const openConversation = async (peer: string) => {
    setSelected(peer)
    setComposing(false)
    for (const m of messages) if (!m.sentByMe && !m.read && m.from === peer) await markMessageRead(m.id)
    await refresh()
  }

  const send = async (recipient: string, text: string) => {
    if (!evm || !recipient || !text.trim()) return
    setBusy(true)
    setStatus(null)
    try {
      const r = await sendEncryptedMessage(evm, recipient, text)
      setStatus(t('messages.sentTx', [r.txHash.slice(0, 14) + '…']))
      setDraft('')
      setTo('')
      setSelected(recipient.toLowerCase())
      setComposing(false)
      await refresh()
    } catch (e) {
      const message = (e as Error).message
      setStatus(
        /RecipientNoKey|not announced/i.test(message)
          ? t('messages.noKey')
          : t('messages.sendFailed', [message]),
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page">
      <section className="card">
        <div className="card-head">
          <h2>{t('messages.title')}</h2>
          <button className="btn ghost small" onClick={() => void sync()} disabled={!evm}>
            {t('messages.refresh')}
          </button>
        </div>
        <p className="privacy-note">{t('messages.encryptNotice')}</p>
        {status && <div className="notice">{status}</div>}
        {!evm && <div className="notice">{t('messages.connectFirst')}</div>}
      </section>

      <section className="card">
        <div className="messages-layout">
          <aside className="msg-list">
            <button className="btn small" onClick={() => { setComposing(true); setSelected(null) }}>
              {t('messages.compose')}
            </button>
            {conversations.length === 0 && <p className="muted">{t('messages.empty')}</p>}
            {conversations.map(({ peer, last, unread }) => (
              <button
                key={peer}
                className={selected === peer && !composing ? 'msg-peer active' : 'msg-peer'}
                onClick={() => void openConversation(peer)}
              >
                <span className="mono">{shortAddr(peer)}</span>
                <span className="muted small-text">
                  {last.plain ?? (last.sentByMe ? t('messages.noPlainSelf') : t('messages.locked'))}
                </span>
                {unread > 0 && <span className="badge">{unread}</span>}
              </button>
            ))}
          </aside>

          <div className="msg-thread">
            {composing || (!selected && conversations.length === 0) ? (
              <form
                className="msg-compose"
                onSubmit={(e) => {
                  e.preventDefault()
                  void send(to.trim(), draft)
                }}
              >
                <div className="kv">
                  <span>{t('messages.to')}</span>
                  <input className="mono" placeholder="0x…" value={to} onChange={(e) => setTo(e.target.value)} />
                </div>
                <textarea
                  placeholder={t('messages.messagePlaceholder')}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  rows={4}
                />
                <div className="row">
                  <button className="btn primary" type="submit" disabled={busy || !evm || !to.trim() || !draft.trim()}>
                    {busy ? t('messages.sending') : t('messages.send')}
                  </button>
                  {composing && (
                    <button className="btn ghost" type="button" onClick={() => setComposing(false)}>
                      {t('common.cancel')}
                    </button>
                  )}
                </div>
              </form>
            ) : selected ? (
              <>
                <div className="msg-thread-head">
                  <span className="mono">{selected}</span>
                </div>
                <div className="msg-bubbles">
                  {selectedThread.map((m) => (
                    <div key={m.id} className={m.sentByMe ? 'msg-out' : 'msg-in'}>
                      <div className="msg-body">
                        {m.plain ?? (m.sentByMe ? t('messages.noPlainSelf') : t('messages.locked'))}
                      </div>
                      <div className="muted small-text">{new Date(m.at).toLocaleString()}</div>
                    </div>
                  ))}
                </div>
                <form
                  className="msg-compose"
                  onSubmit={(e) => {
                    e.preventDefault()
                    void send(selected, draft)
                  }}
                >
                  <textarea
                    placeholder={t('messages.replyPlaceholder')}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    rows={3}
                  />
                  <div className="row">
                    <button className="btn primary" type="submit" disabled={busy || !evm || !draft.trim()}>
                      {busy ? t('messages.sending') : t('messages.reply')}
                    </button>
                  </div>
                </form>
              </>
            ) : (
              <p className="muted">{t('messages.pickConversation')}</p>
            )}
          </div>
        </div>
      </section>
    </div>
  )
}
