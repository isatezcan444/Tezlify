// ---------------------------------------------------------------------------
// Tezlify FAZ 8 — Baileys identity patch (idempotent, postinstall).
//
// Neden: @whiskeysockets/baileys 6.7.24, WhatsApp'ın LID çağında adres defteri
// kimliklerini çözmek için gereken üç veriyi decode edip DÜŞÜRÜYOR:
//   1. chat-utils.js  : contacts.upsert payload'ında `contactAction.pnJid`
//      (LID-anahtarlı rehber kaydının telefon JID'i) taşınmıyor; ayrıca
//      `lidContactAction` (LID-anahtarlı kayıtlı ad) hiç handle edilmiyor.
//   2. history.js     : HistorySync.phoneNumberToLidMappings (telefon↔LID
//      çiftleri) processHistoryMessage return'inde forward edilmiyor.
//   3. event-buffer.js: buffered messaging-history.set consolidate edilirken
//      phoneNumberToLidMappings kayboluyor.
// Bu üç veri olmadan gateway, rehber adlarını telefona kalıcı olarak
// eşleyemez (kişiler ham `xxx@lid` / telefon olarak görünür).
//
// patch-package workspace kök yapısında üretim yapamadığı için bu script
// aynı işi görür: npm install sonrası (postinstall) node_modules içindeki
// ESM dosyalara minimum, işaret-lenimli string patch uygular. Zaten
// uygulanmışsa no-op'tur (idempotent). Baileys sürümü değişirse patch
// hedefleri bulunamaz ve script uyarı verir (sessiz yanlışlık yapmaz).
// ---------------------------------------------------------------------------
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Test/hack desteği: BAILEYS_LIB_DIR verilirse o dizine patch uygular.
const libDir = process.env.BAILEYS_LIB_DIR
  ? path.join(process.env.BAILEYS_LIB_DIR, 'lib')
  : (() => {
      const baileysPkg = require.resolve('@whiskeysockets/baileys/package.json', { paths: [__dirname] });
      return path.join(path.dirname(baileysPkg), 'lib');
    })();

const MARKER = 'TEZLIFY FAZ 8 PATCH';

/** @type {{file: string, id: string, apply: (src: string) => string | null}[]} */
const PATCHES = [
  {
    file: path.join(libDir, 'Utils', 'chat-utils.js'),
    id: 'chat-utils-import-isLidUser',
    apply: (src) => {
      const from = "import { getBinaryNodeChild, getBinaryNodeChildren, isJidGroup, isJidUser, jidNormalizedUser } from '../WABinary/index.js';";
      const to = "import { getBinaryNodeChild, getBinaryNodeChildren, isJidGroup, isJidUser, isLidUser, jidNormalizedUser } from '../WABinary/index.js';";
      return src.includes(from) ? src.replace(from, to) : null;
    },
  },
  {
    file: path.join(libDir, 'Utils', 'chat-utils.js'),
    id: 'chat-utils-contactAction-pn',
    apply: (src) => {
      const from = `    else if (action?.contactAction) {
        ev.emit('contacts.upsert', [
            {
                id: id,
                name: action.contactAction.fullName,
                lid: action.contactAction.lidJid || undefined,
                jid: isJidUser(id) ? id : undefined
            }
        ]);
    }`;
      const to = `    else if (action?.contactAction) {
        ev.emit('contacts.upsert', [
            {
                id: id,
                name: action.contactAction.fullName,
                lid: action.contactAction.lidJid || undefined,
                jid: isJidUser(id) ? id : undefined,
                // ${MARKER}: Baileys drops pnJid — LID-keyed address-book
                // patches carry the phone in pnJid; forward it for identity.
                pn: action.contactAction.pnJid || undefined
            }
        ]);
    }
    else if (action?.lidContactAction) {
        // ${MARKER}: lidContactAction (LID-keyed saved name) is unhandled in
        // Baileys — emit it so the gateway stores the name under the LID key.
        ev.emit('contacts.upsert', [
            {
                id: id,
                name: action.lidContactAction.fullName || action.lidContactAction.firstName || undefined,
                lid: isLidUser(id) ? id : undefined
            }
        ]);
    }`;
      return src.includes(from) ? src.replace(from, to) : null;
    },
  },
  {
    file: path.join(libDir, 'Utils', 'history.js'),
    id: 'history-phoneNumberToLidMappings',
    apply: (src) => {
      const from = `    return {
        chats,
        contacts,
        messages,
        syncType: item.syncType,
        progress: item.progress
    };`;
      const to = `    return {
        chats,
        contacts,
        messages,
        syncType: item.syncType,
        progress: item.progress,
        // ${MARKER}: HistorySync.phoneNumberToLidMappings is decoded but
        // dropped by Baileys — forward phone<->LID pairs for the gateway.
        phoneNumberToLidMappings: item.phoneNumberToLidMappings?.length
            ? item.phoneNumberToLidMappings.map((m) => ({ pnJid: m.pnJid || undefined, lidJid: m.lidJid || undefined }))
            : undefined
    };`;
      return src.includes(from) ? src.replace(from, to) : null;
    },
  },
  {
    file: path.join(libDir, 'Utils', 'event-buffer.js'),
    id: 'event-buffer-keep-mappings',
    apply: (src) => {
      const from = `            data.historySets.isLatest = eventData.isLatest || data.historySets.isLatest;
            break;`;
      const to = `            data.historySets.isLatest = eventData.isLatest || data.historySets.isLatest;
            // ${MARKER}: preserve phone<->LID mappings across buffering.
            if (eventData.phoneNumberToLidMappings?.length) {
                data.historySets.phoneNumberToLidMappings = [
                    ...(data.historySets.phoneNumberToLidMappings || []),
                    ...eventData.phoneNumberToLidMappings
                ];
            }
            break;`;
      const a = src.includes(from) ? src.replace(from, to) : null;
      const from2 = `            isLatest: data.historySets.isLatest,
            peerDataRequestSessionId: data.historySets.peerDataRequestSessionId`;
      const to2 = `            isLatest: data.historySets.isLatest,
            peerDataRequestSessionId: data.historySets.peerDataRequestSessionId,
            phoneNumberToLidMappings: data.historySets.phoneNumberToLidMappings`;
      if (a && a.includes(from2)) return a.replace(from2, to2);
      return null;
    },
  },
];

let changed = 0;
let skipped = 0;
let missing = 0;
for (const p of PATCHES) {
  let src;
  try {
    src = readFileSync(p.file, 'utf8');
  } catch {
    console.warn(`[patch-baileys] missing file: ${p.file}`);
    missing += 1;
    continue;
  }
  if (alreadyApplied(src, p)) {
    skipped += 1;
    continue;
  }
  const next = p.apply(src);
  if (next === null) {
    // Either already applied (marker present) or upstream changed shape.
    if (src.includes(MARKER)) {
      skipped += 1;
    } else {
      console.warn(`[patch-baileys] WARNING: patch target not found: ${p.id} (${path.relative(process.cwd(), p.file)}) — Baileys sürümü değişmiş olabilir, FAZ 8 identity düzeltmesi bu kaynak olmadan eksik kalır.`);
      missing += 1;
    }
    continue;
  }
  writeFileSync(p.file, next, 'utf8');
  changed += 1;
}

function alreadyApplied(src, p) {
  // Heuristic: the patch's distinctive replacement text is present.
  switch (p.id) {
    case 'chat-utils-import-isLidUser':
      return src.includes('isJidUser, isLidUser,');
    case 'chat-utils-contactAction-pn':
      return src.includes('pn: action.contactAction.pnJid');
    case 'history-phoneNumberToLidMappings':
      return src.includes('phoneNumberToLidMappings: item.phoneNumberToLidMappings');
    case 'event-buffer-keep-mappings':
      return src.includes('data.historySets.phoneNumberToLidMappings');
    default:
      return false;
  }
}

console.log(`[patch-baileys] done — applied:${changed} already:${skipped} unresolved:${missing}`);
if (missing > 0) process.exitCode = 0; // non-fatal: gateway still boots, degraded identity
