/* eslint-disable */
'use strict'

const WA_URL = 'https://web.whatsapp.com/'
const $ = (id) => document.getElementById(id)

let lastResult = null // { json, summary } do ultimo dump

function setStatus(msg, cls) {
  const el = $('status')
  el.textContent = msg
  el.className = cls || ''
}

function setBusy(msg) {
  const el = $('status')
  el.className = ''
  el.innerHTML = '<span class="spin"></span>' + msg
}

function setBadge(state, text) {
  $('badge').className = 'badge ' + state
  $('badgeText').textContent = text
}

async function getWaTab() {
  const tabs = await chrome.tabs.query({ url: 'https://web.whatsapp.com/*' })
  return tabs[0] || null
}

// ── Deteccao de estado (tab + login) ───────────────────────────────────

function probeWa() {
  try {
    let wid = null
    try { wid = JSON.parse(localStorage.getItem('last-wid-md') || 'null') } catch {}
    return { loggedIn: !!wid }
  } catch (e) {
    return { loggedIn: false }
  }
}

async function refreshState() {
  const tab = await getWaTab()
  if (!tab) {
    setBadge('offline', 'fechado')
    setStatus('WhatsApp Web nao esta aberto. Clique em "Abrir / focar WhatsApp Web".')
    $('dump').disabled = false // ainda permite (vai avisar se nao achar)
    return
  }
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: probeWa
    })
    if (result && result.loggedIn) {
      setBadge('online', 'conectado')
      setStatus('Pronto. Clique em "Fazer dump".')
    } else {
      setBadge('waiting', 'aguardando login')
      setStatus('Aba aberta mas sem login detectado. Escaneie o QR e tente de novo.')
    }
  } catch {
    setBadge('waiting', 'aba aberta')
    setStatus('Aba do WhatsApp Web encontrada.')
  }
}

// ── Render do resultado ────────────────────────────────────────────────

function renderCard(s) {
  $('rRegId').textContent = s.regId == null ? '—' : String(s.regId)
  $('rJid').textContent = s.meJid || '—'

  const checks = [
    ['noiseKey', s.hasNoiseKey],
    ['identityKey', s.hasIdentityKey],
    ['signedPreKey', s.hasSignedPreKey],
    ['appStateSyncKeys (' + s.appStateSyncKeys + ')', s.appStateSyncKeys > 0],
    ['appStateVersions (' + s.appStateVersions + ')', s.appStateVersions > 0]
  ]
  const box = $('rChecks')
  box.innerHTML = ''
  for (const [label, ok] of checks) {
    const div = document.createElement('div')
    div.className = 'chk ' + (ok ? 'yes' : 'no')
    const ic = document.createElement('span')
    ic.className = 'ic'
    ic.textContent = ok ? '✓' : '✗'
    const txt = document.createElement('span')
    txt.textContent = label
    div.append(ic, txt)
    box.appendChild(div)
  }

  const warn = $('rWarn')
  if (!s.hasNoiseKey) {
    warn.style.display = 'block'
    warn.textContent = '⚠ noiseKey nulo — sera necessario re-parear o destino.'
  } else {
    warn.style.display = 'none'
  }
  $('card').classList.add('show')
}

async function doDownload(json) {
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  await chrome.downloads.download({ url, filename: 'wa-web-dump.json', saveAs: false })
}

/** Executa o dump no MAIN world e retorna { json, summary } ou lanca erro. */
async function runDumpOnTab(triggerDownload) {
  const tab = await getWaTab()
  if (!tab) {
    throw new Error('Nenhuma aba web.whatsapp.com encontrada. Clique em "Abrir / focar WhatsApp Web".')
  }
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN', // necessario para acessar __d/require e os modulos internos do wa-web
    func: runWaDump,
    args: [{ triggerDownload }]
  })
  if (!result) throw new Error('O dump nao retornou nada. Veja o console da aba do WhatsApp.')
  if (result.error) throw new Error(result.error)
  lastResult = result
  return result
}

// ── Limpeza do storage (sem deslogar do servidor) ──────────────────────

/**
 * Roda na pagina (MAIN world). Apaga IndexedDB/localStorage/sessionStorage/
 * caches/service-workers do origin SEM chamar o logout do WhatsApp — o
 * dispositivo continua registrado no servidor, entao o dump segue valido
 * em outro cliente. Um logout normal invalidaria as credenciais.
 */
async function clearWaStorage() {
  const deleted = []
  const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(r, ms))])
  try {
    let names = []
    try {
      if (indexedDB.databases) names = (await indexedDB.databases()).map((d) => d.name).filter(Boolean)
    } catch {}
    const known = ['signal-storage', 'wawc_db_enc', 'model-storage', 'wawc-db', 'wam']
    for (const name of Array.from(new Set(names.concat(known)))) {
      await withTimeout(
        new Promise((res) => {
          const req = indexedDB.deleteDatabase(name)
          req.onsuccess = () => res()
          req.onerror = () => res()
          req.onblocked = () => res()
        }),
        1500
      )
      deleted.push(name)
    }
    try { localStorage.clear() } catch {}
    try { sessionStorage.clear() } catch {}
    try {
      if (self.caches) for (const k of await caches.keys()) await caches.delete(k)
    } catch {}
    try {
      if (navigator.serviceWorker) {
        const regs = await navigator.serviceWorker.getRegistrations()
        for (const r of regs) await r.unregister()
      }
    } catch {}
    return { ok: true, deleted }
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) }
  }
}

async function wipeWaStorage() {
  const tab = await getWaTab()
  if (!tab) throw new Error('Aba do WhatsApp Web nao encontrada para limpar.')
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    func: clearWaStorage
  })
  // Recarrega para soltar conexoes abertas do IndexedDB e cair na tela de QR.
  await chrome.tabs.reload(tab.id)
  return result
}

function askWipeConfirm() {
  return new Promise((resolve) => {
    const panel = $('wipeConfirm')
    panel.style.display = 'block'
    const yes = $('wipeYes')
    const no = $('wipeNo')
    const done = (val) => {
      panel.style.display = 'none'
      yes.removeEventListener('click', onYes)
      no.removeEventListener('click', onNo)
      resolve(val)
    }
    const onYes = () => done(true)
    const onNo = () => done(false)
    yes.addEventListener('click', onYes)
    no.addEventListener('click', onNo)
  })
}

/** Se a opcao estiver marcada, confirma e limpa o storage. */
async function maybeWipe() {
  if (!$('wipeAfter').checked) return
  const ok = await askWipeConfirm()
  if (!ok) {
    setStatus('Limpeza cancelada. Sessao mantida no navegador.')
    return
  }
  setBusy('Limpando storage e recarregando a aba…')
  const res = await wipeWaStorage()
  if (res && res.ok === false) {
    setStatus('Falha ao limpar: ' + res.error, 'err')
    return
  }
  setBadge('offline', 'limpo')
  setStatus(
    'Storage local limpo (sem logout no servidor). A aba recarregou no QR; ' +
      'as credenciais exportadas seguem validas em outro cliente.',
    'ok'
  )
}

// ── Acoes ──────────────────────────────────────────────────────────────

$('open').addEventListener('click', async () => {
  const existing = await getWaTab()
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true })
    await chrome.windows.update(existing.windowId, { focused: true })
  } else {
    await chrome.tabs.create({ url: WA_URL })
  }
  setStatus('WhatsApp Web aberto. Faca login e depois clique em "Fazer dump".')
  setTimeout(refreshState, 800)
})

$('dump').addEventListener('click', async () => {
  const btn = $('dump')
  btn.disabled = true
  setBusy('Executando dump na pagina…')
  try {
    const result = await runDumpOnTab(false)
    await doDownload(result.json)
    renderCard(result.summary)
    setStatus('Dump concluido e baixado (wa-web-dump.json).', 'ok')
    await maybeWipe()
  } catch (e) {
    setStatus('Erro: ' + (e && e.message ? e.message : String(e)), 'err')
  } finally {
    btn.disabled = false
  }
})

$('copy').addEventListener('click', async () => {
  if (!lastResult) return
  try {
    await navigator.clipboard.writeText(lastResult.json)
    setStatus('JSON copiado para a area de transferencia.', 'ok')
  } catch (e) {
    setStatus('Nao foi possivel copiar: ' + e.message, 'err')
  }
})

$('redownload').addEventListener('click', async () => {
  if (!lastResult) return
  await doDownload(lastResult.json)
  setStatus('Baixado de novo.', 'ok')
})

// ── Envio para API REST ────────────────────────────────────────────────

chrome.storage.local.get(['endpoint', 'authHeader', 'method', 'wipeAfter']).then((cfg) => {
  if (cfg.endpoint) $('endpoint').value = cfg.endpoint
  if (cfg.authHeader) $('authHeader').value = cfg.authHeader
  if (cfg.method) $('method').value = cfg.method
  if (cfg.endpoint) $('apiBox').open = true
  if (cfg.wipeAfter) $('wipeAfter').checked = true
})

$('wipeAfter').addEventListener('change', () => {
  chrome.storage.local.set({ wipeAfter: $('wipeAfter').checked })
})

function originPattern(urlStr) {
  const u = new URL(urlStr)
  return `${u.protocol}//${u.host}/*`
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * POST/PUT com retry. Logo apos conceder a permissao de host pela primeira
 * vez, o primeiro fetch costuma falhar com "Failed to fetch" porque a
 * permissao ainda nao propagou na camada de rede — por isso tentamos de novo
 * com backoff em vez de exigir um segundo clique.
 */
async function sendWithRetry(endpoint, opts, attempts = 4) {
  let lastErr
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetch(endpoint, opts)
    } catch (e) {
      lastErr = e // TypeError de rede — provavel propagacao da permissao
      if (i < attempts - 1) {
        setBusy('Conexao ainda propagando, tentando de novo (' + (i + 2) + '/' + attempts + ')…')
        await delay(300 * (i + 1))
      }
    }
  }
  throw lastErr
}

$('send').addEventListener('click', async () => {
  const btn = $('send')
  const endpoint = $('endpoint').value.trim()
  const authHeader = $('authHeader').value.trim()
  const method = $('method').value

  if (!endpoint) {
    setStatus('Informe a URL do endpoint.', 'err')
    return
  }
  let pattern
  try {
    pattern = originPattern(endpoint)
  } catch {
    setStatus('URL invalida.', 'err')
    return
  }

  btn.disabled = true
  await chrome.storage.local.set({ endpoint, authHeader, method })

  try {
    // Permissao de host em runtime (precisa partir do gesto do usuario).
    const granted = await chrome.permissions.request({ origins: [pattern] })
    if (!granted) {
      setStatus('Permissao de host negada para ' + pattern, 'err')
      return
    }

    setBusy('Executando dump…')
    const result = await runDumpOnTab(false)
    renderCard(result.summary)

    setBusy('Enviando para ' + endpoint + ' …')
    const headers = { 'Content-Type': 'application/json' }
    if (authHeader) {
      const idx = authHeader.indexOf(':')
      if (idx > 0) {
        headers[authHeader.slice(0, idx).trim()] = authHeader.slice(idx + 1).trim()
      } else {
        headers['Authorization'] = authHeader // assume valor cru do token
      }
    }

    const resp = await sendWithRetry(endpoint, { method, headers, body: result.json })
    const text = await resp.text().catch(() => '')
    if (!resp.ok) {
      setStatus('API respondeu HTTP ' + resp.status + ':\n' + text.slice(0, 500), 'err')
      return
    }
    setStatus(
      'Enviado com sucesso (HTTP ' + resp.status + ').' + (text ? '\n\nResposta:\n' + text.slice(0, 300) : ''),
      'ok'
    )
    await maybeWipe()
  } catch (e) {
    setStatus('Erro no envio: ' + (e && e.message ? e.message : String(e)), 'err')
  } finally {
    btn.disabled = false
  }
})

// Estado inicial ao abrir o popup.
refreshState()

/**
 * Esta funcao e serializada e injetada na pagina do WhatsApp Web no MAIN world.
 * Tudo precisa estar contido aqui dentro (sem closures externas).
 * Retorna { json, summary } ou { error }.
 */
async function runWaDump(opts) {
  const triggerDownload = !opts || opts.triggerDownload !== false
  try {
    function bytesToB64(bytes) {
      if (!bytes) return null
      let u
      if (bytes instanceof Uint8Array) u = bytes
      else if (bytes instanceof ArrayBuffer) u = new Uint8Array(bytes)
      else if (typeof bytes === 'string') {
        u = Uint8Array.from(bytes, (c) => c.charCodeAt(0))
      } else return null
      const chunks = []
      const STEP = 0x8000
      for (let i = 0; i < u.length; i += STEP) {
        chunks.push(String.fromCharCode.apply(null, u.subarray(i, i + STEP)))
      }
      return btoa(chunks.join(''))
    }

    function bufWrap(bytes) {
      const b = bytesToB64(bytes)
      return b == null ? null : { type: 'Buffer', data: b }
    }

    function deepBufWrap(value) {
      if (value == null) return value
      if (value instanceof Uint8Array || value instanceof ArrayBuffer) return bufWrap(value)
      if (Array.isArray(value)) return value.map(deepBufWrap)
      if (typeof value === 'object') {
        const out = {}
        for (const k of Object.keys(value)) {
          if (k === '$$unknownFieldCount') continue
          out[k] = deepBufWrap(value[k])
        }
        return out
      }
      return value
    }

    function open(name) {
      return new Promise((res, rej) => {
        const req = indexedDB.open(name)
        req.onsuccess = () => res(req.result)
        req.onerror = () => rej(req.error)
      })
    }

    function getAll(db, store) {
      return new Promise((res, rej) => {
        const tx = db.transaction(store, 'readonly')
        const req = tx.objectStore(store).getAll()
        req.onsuccess = () => res(req.result)
        req.onerror = () => rej(req.error)
      })
    }

    async function decryptRegMaterial(obj) {
      if (!obj || !obj.encKey || !obj.value) return null
      const counter = new Uint8Array(16)
      const ct = obj.value instanceof Uint8Array ? obj.value : new Uint8Array(obj.value)
      const out = await crypto.subtle.decrypt(
        { name: 'AES-CTR', length: 128, counter },
        obj.encKey,
        ct
      )
      return new Uint8Array(out)
    }

    function getWaModule(name) {
      try {
        if (typeof require === 'function') return require(name)
      } catch {}
      try {
        if (typeof __d === 'function') {
          let captured
          const sentinel = '__waDumpProbe_' + Math.random().toString(36).slice(2)
          __d(sentinel, [name], function (_t, _n, _r, _o) {
            captured = _o(name)
          })
          if (typeof __d.require === 'function') {
            captured = captured ?? __d.require(name)
          }
          if (captured) return captured
        }
      } catch {}
      return null
    }

    async function getNoiseInfoViaInternalModule() {
      const infoStore = getWaModule('WAWebUserPrefsInfoStore')
      if (!infoStore?.waNoiseInfo?.get) return null
      try {
        const decrypted = await infoStore.waNoiseInfo.get()
        if (!decrypted?.staticKeyPair) return null
        return {
          pubKey: new Uint8Array(decrypted.staticKeyPair.pubKey),
          privKey: new Uint8Array(decrypted.staticKeyPair.privKey)
        }
      } catch (e) {
        console.warn('[wa-web-dump] internal module getNoiseInfo failed:', e)
        return null
      }
    }

    async function getNoiseInfoFallback() {
      const saltJson = localStorage.getItem('WAWebEncKeySalt')
      const noiseJson = localStorage.getItem('WANoiseInfo')
      const ivJson = localStorage.getItem('WANoiseInfoIv')
      if (!saltJson || !noiseJson || !ivJson) return null

      const saltBytes = Uint8Array.from(atob(JSON.parse(saltJson)), (c) => c.charCodeAt(0))
      const noiseObj = JSON.parse(noiseJson)
      const ivs = JSON.parse(ivJson).map((b) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0)))
      const encPub = Uint8Array.from(atob(noiseObj.pubKey), (c) => c.charCodeAt(0))
      const encPriv = Uint8Array.from(atob(noiseObj.privKey), (c) => c.charCodeAt(0))

      const dbEnc = await open('wawc_db_enc')
      const baseRows = await getAll(dbEnc, 'keys')
      dbEnc.close()
      if (!baseRows?.length) return null

      for (const row of baseRows) {
        const baseKey = row.key
        const candidateInfos = [new Uint8Array(1)]
        for (const info of candidateInfos) {
          try {
            const aesKey = await crypto.subtle.deriveKey(
              { name: 'HKDF', hash: 'SHA-256', salt: saltBytes, info },
              baseKey,
              { name: 'AES-CBC', length: 128 },
              false,
              ['decrypt']
            )
            const pub = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: ivs[1] }, aesKey, encPub)
            const priv = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: ivs[2] }, aesKey, encPriv)
            return { pubKey: new Uint8Array(pub), privKey: new Uint8Array(priv) }
          } catch {}
        }
      }
      return null
    }

    async function getNoiseKey() {
      const viaModule = await getNoiseInfoViaInternalModule()
      if (viaModule) {
        console.log('[wa-web-dump] noise key obtained via WAWebUserPrefsInfoStore (decrypted)')
        return viaModule
      }
      const viaFallback = await getNoiseInfoFallback()
      if (viaFallback) {
        console.log('[wa-web-dump] noise key obtained via fallback HKDF (placeholder info path)')
        return viaFallback
      }
      console.warn('[wa-web-dump] FAILED to obtain noise key. Continuing without noiseKey.')
      return null
    }

    async function getModelTable(schemaModuleName, tableGetterName) {
      const mod = getWaModule(schemaModuleName)
      const getter = mod?.[tableGetterName]
      if (typeof getter !== 'function') return []
      try {
        const rows = await getter().all()
        return Array.isArray(rows) ? rows : []
      } catch (e) {
        console.warn(`[wa-web-dump] ${schemaModuleName}.${tableGetterName}().all() failed:`, e)
        return []
      }
    }

    function toUint8(v) {
      if (v == null) return null
      if (v instanceof Uint8Array) return v
      if (v instanceof ArrayBuffer) return new Uint8Array(v)
      if (typeof v === 'object' && v.buffer instanceof ArrayBuffer) {
        return new Uint8Array(v.buffer, v.byteOffset ?? 0, v.byteLength ?? v.buffer.byteLength)
      }
      if (typeof v === 'string') return Uint8Array.from(v, (c) => c.charCodeAt(0))
      return null
    }

    // ── Run ──────────────────────────────────────────────────────────────
    const sg = await open('signal-storage')
    const [meta, signedPrekey] = await Promise.all([
      getAll(sg, 'signal-meta-store'),
      getAll(sg, 'signed-prekey-store')
    ])
    sg.close()

    const metaMap = {}
    for (const r of meta) metaMap[r.key] = r.value

    const staticPub = await decryptRegMaterial(metaMap.signal_static_pubkey)
    const staticPriv = await decryptRegMaterial(metaMap.signal_static_privkey)
    const noise = await getNoiseKey()
    const advSignedIdentity = metaMap.adv_signed_identity
      ? deepBufWrap(metaMap.adv_signed_identity)
      : null

    const [syncKeysRows, collectionVersionRows, syncActionsRows] = await Promise.all([
      getModelTable('WAWebSchemaSyncKeys', 'getSyncKeysTable'),
      getModelTable('WAWebSchemaCollectionVersion', 'getCollectionVersionTable'),
      getModelTable('WAWebSchemaSyncActions', 'getSyncActionsTable')
    ])

    let advSecretKey = null
    try {
      const v = await getWaModule('WAWebUserPrefsMultiDevice')?.getADVSecretKey?.()
      if (typeof v === 'string') advSecretKey = Uint8Array.from(atob(v), (c) => c.charCodeAt(0))
      else if (v) advSecretKey = toUint8(v)
    } catch {}

    const appStateSyncKeys = syncKeysRows
      .map((r) => {
        const keyId = toUint8(r.keyId)
        const keyData = toUint8(r.keyData)
        if (!keyId || !keyData) return null
        return {
          keyId: bufWrap(keyId),
          keyData: bufWrap(keyData),
          timestamp: r.timestamp ?? 0,
          ...(r.fingerprint ? { fingerprint: r.fingerprint } : {}),
          ...(r.keyEpoch !== undefined ? { keyEpoch: r.keyEpoch } : {})
        }
      })
      .filter(Boolean)

    const indexValueByCollection = new Map()
    for (const a of syncActionsRows) {
      const im = toUint8(a.indexMac)
      const vm = toUint8(a.valueMac)
      if (!a.collection || !im || !vm) continue
      const map = indexValueByCollection.get(a.collection) ?? {}
      map[bytesToB64(im)] = bufWrap(vm)
      indexValueByCollection.set(a.collection, map)
    }

    const appStateVersions = collectionVersionRows
      .map((r) => {
        const ltHash = toUint8(r.ltHash)
        if (!r.collection || !ltHash) return null
        return {
          collection: r.collection,
          version: r.version ?? 0,
          hash: bufWrap(ltHash),
          indexValueMap: indexValueByCollection.get(r.collection) ?? {}
        }
      })
      .filter(Boolean)

    const lastWidMd = (() => {
      try {
        return JSON.parse(localStorage.getItem('last-wid-md') ?? 'null')
      } catch {
        return null
      }
    })()
    const lid = (() => {
      try {
        return JSON.parse(localStorage.getItem('WALid') ?? 'null')
      } catch {
        return null
      }
    })()
    const meDisplayName = (() => {
      try {
        return JSON.parse(localStorage.getItem('me-display-name') ?? 'null')
      } catch {
        return null
      }
    })()

    function widToJid(wid) {
      if (!wid || typeof wid !== 'string') return null
      const at = wid.lastIndexOf('@')
      const head = at >= 0 ? wid.slice(0, at) : wid
      const server = at >= 0 ? wid.slice(at + 1) : 's.whatsapp.net'
      const colon = head.indexOf(':')
      const userAndAgent = colon >= 0 ? head.slice(0, colon) : head
      const device = colon >= 0 ? Number(head.slice(colon + 1)) : 0
      const dot = userAndAgent.indexOf('.')
      const user = dot >= 0 ? userAndAgent.slice(0, dot) : userAndAgent
      return `${user}:${device}@${server}`
    }

    const dump = {
      device: {
        registrationId: metaMap.signal_reg_id ?? null,
        noiseKey: noise
          ? { pubKey: bufWrap(noise.pubKey), privKey: bufWrap(noise.privKey) }
          : null,
        identityKey:
          staticPub && staticPriv
            ? { pubKey: bufWrap(staticPub), privKey: bufWrap(staticPriv) }
            : null,
        signedPreKey: signedPrekey[signedPrekey.length - 1]
          ? {
              keyId: signedPrekey[signedPrekey.length - 1].keyId,
              keyPair: {
                pubKey: bufWrap(signedPrekey[signedPrekey.length - 1].keyPair.pubKey),
                privKey: bufWrap(signedPrekey[signedPrekey.length - 1].keyPair.privKey)
              },
              signature: bufWrap(signedPrekey[signedPrekey.length - 1].signature)
            }
          : null,
        advSecretKey: advSecretKey ? bufWrap(advSecretKey) : bufWrap(new Uint8Array(0)),
        account: advSignedIdentity,
        meJid: widToJid(lastWidMd),
        meLid: widToJid(lid),
        meDisplayName: meDisplayName ?? null,
        platform: 'web'
      },
      appStateSyncKeys,
      appStateVersions
    }

    const summary = {
      regId: dump.device.registrationId,
      meJid: dump.device.meJid,
      meLid: dump.device.meLid,
      hasNoiseKey: !!dump.device.noiseKey,
      hasIdentityKey: !!dump.device.identityKey,
      hasSignedPreKey: !!dump.device.signedPreKey,
      appStateSyncKeys: dump.appStateSyncKeys.length,
      appStateVersions: dump.appStateVersions.length
    }
    console.log('[wa-web-dump] summary:', summary)

    const json = JSON.stringify(dump, null, 2)

    // Download opcional pela propria pagina (independe do popup).
    if (triggerDownload) {
      try {
        const blob = new Blob([json], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = 'wa-web-dump.json'
        document.body.appendChild(a)
        a.click()
        a.remove()
        URL.revokeObjectURL(url)
      } catch (e) {
        console.warn('[wa-web-dump] page-side download failed:', e)
      }
    }

    window.__waWebDumpResult = dump
    return { json, summary }
  } catch (e) {
    return { error: e && e.message ? e.message : String(e) }
  }
}
