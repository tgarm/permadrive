# How the encrypted vault works

This document explains exactly what the vault protects, what it cannot protect, and how
to verify every claim yourself against the chain. No trust in this app's promise is
required — everything below is checkable with public data and ~20 lines of WebCrypto.

## The one-paragraph model

A vault is a JSON **envelope** published on-chain (via the same permanent storage
pipeline as any file). The envelope contains **only ciphertext**: your entries are
encrypted as a whole with a random 256-bit **data key** (AES-256-GCM), and the data key
itself is stored inside the envelope — wrapped, twice, by two independent methods you
control. The chain never sees a single plaintext byte of your entries.

```
entries (plaintext JSON)                    never on-chain, page memory only
   │ AES-256-GCM, random 96-bit IV per save
   ▼
cipher {iv, ct} ─────────────────────────── on-chain (ciphertext)
   ▲
data key K (random 256-bit, generated once, never changes)
   │
   ├─ wrapped by KEK₁ ◄── your passphrase, PBKDF2-SHA256 (310,000 iterations)
   │     → exported as the keystore file (offline, yours)
   │
   └─ wrapped by KEK₂ ◄── HKDF-SHA256 over an EVM wallet signature
         → stored inside the envelope's wrappedKeys[]
```

## The two unlock channels

**1. Wallet signature (default, effortless).** Unlocking signs one fixed message —

```
PermaDrive vault key wrap v1 · 0x<your address>
```

— with your EVM wallet. The 65-byte signature is fed through HKDF-SHA256 to derive the
key-wrapping key that unwraps K. Consequences worth understanding:

- **The private key never leaves the wallet.** Only the signature does, and a signature
  over a known constant reveals nothing usable about the key.
- **No transaction is created and nothing is published.** The signature exists only in
  your browser's memory for the moment of unwrapping; it is never stored or sent anywhere.
- **It works across devices** because standard EVM signing is deterministic
  (RFC 6979): the same message always yields the same signature, so the same key can be
  re-derived on any machine with the same wallet. Local (non-extension) keys are
  deterministic by construction; most extension wallets are too, but the EIP-712 /
  `personal_sign` ecosystem does not *guarantee* it — a wallet that signs
  non-reproducibly simply fails the unwrap (GCM authentication rejects the result), and
  you fall back to channel 2. There is no lockout either way.

**2. Keystore file + passphrase (the universal recovery path).** At creation you set a
passphrase; the app wraps K with it (PBKDF2-SHA256, 310,000 iterations) and forces you to
download the result as a small JSON keystore file. This file — not the passphrase alone,
and not the wallet — is what guarantees recovery when:

- the wallet is lost or replaced,
- you switch to a wallet whose signatures are not reproducible,
- the browser profile is gone.

Losing **both** the wallet-signature channel and the keystore file means the ciphertext
stays on-chain forever but can never be opened again. There is no escrow, no reset, no
backdoor — that is the point of the design, and also its hardest edge. Store the keystore
offline (password manager, USB stick, printed paper).

## What is public, exactly

| Data | On-chain? | Who can see it |
|---|---|---|
| Envelope ciphertext (all entries, encrypted) | yes | anyone |
| Envelope filename `pdvault-<addr8>.json` | yes | anyone |
| That address `<addr>` has a vault, its size, version history | yes | anyone |
| Your entries, passwords, titles | **no** | only K holders |
| Your passphrase | no | never leaves the device |
| Your wallet signature at unlock | no | never published, memory only |

What this leaks (honestly): the *existence* and *size* of a vault, and — because
retrieval uses public infrastructure — the fact that your IP fetched a given CID. If that
access-pattern metadata matters to you, fetch through a VPN/Tor. On-chain writes are
permanent: old envelope versions stay retrievable forever, which is what makes "deleted a
password, need it back" work — and also means an old password you rotated out remains in
old ciphertext, decryptable by K (K never changes), just not by anyone without K.

## Verify it yourself

1. Take the envelope's manifest CID from the registry (the app shows it; or read the
   FileRegistry `entries(address)` call on any EVM explorer for chainId 870).
2. Resolve the manifest, then the envelope, with the retrieval pipeline of your choice
   (indexer + `chain_getBlock`, as documented in the README's scripts).
3. Confirm the envelope contains no plaintext: it is `{"v":1,"kind":"permadrive-vault",
   "address":…,"cipher":{…hex…},"wrappedKeys":[…hex…]}` — grep it for any string you
   stored; you will not find it.
4. With the keystore file and ~15 lines of WebCrypto (PBKDF2 → AES-GCM unwrap → AES-GCM
   open), decrypt the entries without this app at all.

## Design decisions, and why

- **Why not encrypt each entry separately?** A single envelope keeps the on-chain format
  trivial to audit (one ciphertext blob, fixed filename, content-addressed) and makes
  versioning automatic: every save is a new sealed envelope, and old versions remain a
  complete recovery snapshot.
- **Why is the app not needed for recovery?** Because "pure frontend, no backend" also
  means no one can reset anything for you. The keystore format above is the escape hatch:
  self-describing JSON, standard primitives, decryptable by hand.
- **Why force the keystore download at creation?** Because the wallet-signature channel
  depends on wallet behavior this project cannot guarantee. The one-minute of friction at
  creation buys the only recovery path that survives losing the wallet.
- **Why AES-256-GCM everywhere?** One authenticated-encryption primitive for payload and
  key wrapping; every wrap has a fresh random IV; any bit of tampering fails
  authentication instead of decrypting to garbage.
