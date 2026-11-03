/**
 * WhatsApp Gateway Media Store.
 *
 * Handles incoming media downloading via Baileys, disk persistence,
 * sidecar metadata file saving (${mediaId}.meta.json), bounded in-memory indexing,
 * SHA-256 integrity metadata, and session cleanup.
 *
 * Retention model: `MEDIA_INDEX_MAX` bounds only the RAM index. Physical files and
 * their sidecars are never removed because the index overflowed — DB rows still
 * reference them and they stay resolvable through lazy sidecar reads.
 */
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { v4 as uuidv4 } from 'uuid';
import { downloadMediaMessage, downloadContentFromMessage } from '@whiskeysockets/baileys';
import { resolveDownloadableMedia, unwrapMessageContent } from '../messages/message-classifier.js';

// Surec baslama ani: bu andan SONRA uretilmis bir mesaj onceden diskte olamaz.
// Bu, canli medya akisinda gereksiz tam sidecar taramasini engeller; replay /
// restart sonrasi eski mesajlarda ise disk kontrolu yapilir.
const PROCESS_STARTED_AT_MS = Date.now();

// Sidecar taramasi es zamanli okumalari sinirlar; her parti arasinda olay
// dongusune donulur. Boylece 5000+ dosyada da istek yolu bloklanmaz.
const SIDECAR_SCAN_BATCH = 64;

// Sidecar yoksa uzantidan MIME tahmini (sendFile davranisina yakin).
const MIME_BY_EXT = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  mp4: 'video/mp4',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  pdf: 'application/pdf',
  txt: 'text/plain',
  json: 'application/json',
};

export function createMediaStore({
  mediaDir,
  logger,
  MEDIA_INDEX_MAX = 5000,
  processStartedAtMs = PROCESS_STARTED_AT_MS,
}) {
  const mediaIndex = new Map();
  const mediaByWaId = new Map();
  const INTEGRITY_CACHE_MAX = 2000;
  const SIDECAR_SCAN_MAX = 5000;
  const integrityCache = new Map();
  // Disk sayimlari yalnizca gozlemlenebilirlik icindir; silme karari URETMEZ.
  const diskStats = { files: 0, sidecars: 0, bytes: 0 };
  // Ayni wa_message_id icin es zamanli disk taramalarini tekilleştirir.
  const dedupeScans = new Map();

  // Ayni (oturum, wa_message_id) ikilisi icin es zamanli ingestion'lari tek
  // indirme/yazmaya indirger. Anahtar yalnizca RAM'de tutulur ve log'a
  // yazilmaz. Oturum kimligi kapsama dahildir: ayni mesaj kimligi farkli
  // hesaplarda gorunurse biri digerinin medyasini paylasmamalidir.
  const ingestLocks = new Map();

  function ingestLockKey(session, waMessageId) {
    const scope = session?.id ? String(session.id) : '';
    return `${scope}\u0000${String(waMessageId)}`;
  }

  // Istek kimligi dogrudan dosya yoluna katiliyor; yol ayirici ve NUL reddedilir.
  function isSafeMediaKey(value) {
    const s = String(value ?? '');
    return (
      s.length > 0 &&
      s.length <= 255 &&
      s !== '.' &&
      s !== '..' &&
      !s.includes('/') &&
      !s.includes('\\') &&
      !s.includes('\0')
    );
  }

  // Sidecar okuma: { meta } | { corrupt: true } | null (sidecar hic yok = legacy)
  function readSidecar(mediaId) {
    const metaPath = path.join(mediaDir, `${mediaId}.meta.json`);
    if (!fs.existsSync(metaPath)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !parsed.filePath) {
        return { corrupt: true };
      }
      return { meta: parsed };
    } catch {
      return { corrupt: true };
    }
  }

  // Asenkron sidecar okuma: ENOENT = sidecar yok (legacy), diger hatalar = bozuk.
  async function readSidecarAsync(mediaId) {
    const metaPath = path.join(mediaDir, `${mediaId}.meta.json`);
    try {
      const raw = await fs.promises.readFile(metaPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !parsed.filePath) {
        return { corrupt: true };
      }
      return { meta: parsed };
    } catch (err) {
      if (err && err.code === 'ENOENT') return null;
      return { corrupt: true };
    }
  }

  async function fileExistsAsync(target) {
    try {
      await fs.promises.access(target);
      return true;
    } catch {
      return false;
    }
  }

  // Senkron tarama (yalnizca geriye uyumluluk icin). Istek yolunda KULLANILMAZ;
  // HTTP route'lari asenkron `resolveMediaPath` uzerinden tam tarama yapar.
  function findMetaByWaId(waMessageId) {
    try {
      const wanted = String(waMessageId);
      let scanned = 0;
      for (const file of fs.readdirSync(mediaDir)) {
        if (!file.endsWith('.meta.json')) continue;
        if (scanned >= SIDECAR_SCAN_MAX) break;
        scanned += 1;
        const mediaId = file.slice(0, -10);
        const read = readSidecar(mediaId);
        if (read?.meta && String(read.meta.waMessageId || '') === wanted) {
          return { mediaId, meta: read.meta };
        }
      }
    } catch {
      // directory unreadable — treat as a miss
    }
    return null;
  }

  /**
   * Tum sidecar'lari es zamanli ve sinirli partiler halinde tarar.
   * Sinir YOKTUR: 5000'den fazla dosyada da eski kayit bulunur. Okuma
   * `fs.promises` ile yapilir; parti aralarinda olay dongusune donulur.
   */
  async function findMetaByWaIdAsync(waMessageId, sessionScope = null) {
    const wanted = String(waMessageId);
    const scope =
      sessionScope === null || sessionScope === undefined
        ? null
        : String(sessionScope);
    let files;
    try {
      files = await fs.promises.readdir(mediaDir);
    } catch {
      return null;
    }
    const sidecars = files.filter((f) => f.endsWith('.meta.json'));
    for (let i = 0; i < sidecars.length; i += SIDECAR_SCAN_BATCH) {
      const batch = sidecars.slice(i, i + SIDECAR_SCAN_BATCH);
      const results = await Promise.all(
        batch.map(async (file) => {
          const mediaId = file.slice(0, -10);
          const read = await readSidecarAsync(mediaId);
          if (
            read?.meta &&
            String(read.meta.waMessageId || '') === wanted &&
            (scope === null || String(read.meta.sessionId || '') === scope)
          ) {
            return { mediaId, meta: read.meta };
          }
          return null;
        })
      );
      const hit = results.find(Boolean);
      if (hit) return hit;
      // Partiler arasinda makro gorevlere/isteklere nefes aldir.
      await new Promise((resolve) => setImmediate(resolve));
    }
    return null;
  }

  function mimeFromPath(filePath) {
    const ext = String(path.basename(filePath).split('.').pop() || '').toLowerCase();
    return MIME_BY_EXT[ext] || 'application/octet-stream';
  }

  // MIME degeri sidecar'dan (dis veri) gelebilir ve HTTP header'a yazilir.
  // CRLF/kontrol/ASCII-disi karakterler `setHeader`'i firlatir; bu yuzden
  // deger dogrulanir. Gecersiz MIME dosya ACILMADAN reddedilir.
  function isSafeMimeType(value) {
    if (typeof value !== 'string') return false;
    const s = value.trim();
    if (!s || s.length > 255) return false;
    for (let i = 0; i < s.length; i += 1) {
      const code = s.charCodeAt(i);
      if (code < 0x20 || code > 0x7e) return false;
    }
    const base = s.split(';', 1)[0].trim();
    return /^[A-Za-z0-9!#$%&'*+.^_`|~-]+\/[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(base);
  }

  async function getMediaMetaAsync(mediaId) {
    if (!mediaId || !isSafeMediaKey(mediaId)) return null;
    const strId = String(mediaId);
    const indexed = mediaIndex.get(strId);
    if (indexed) return indexed;

    const direct = await readSidecarAsync(strId);
    if (direct?.corrupt) return direct;
    if (direct?.meta) return direct.meta;

    if (mediaByWaId.has(strId)) {
      const mappedId = mediaByWaId.get(strId);
      const mapped = mediaIndex.get(mappedId);
      if (mapped) return mapped;
      const side = await readSidecarAsync(mappedId);
      if (side?.corrupt) return side;
      if (side?.meta) return side.meta;
    }

    const scanned = await findMetaByWaIdAsync(strId);
    return scanned ? scanned.meta : null;
  }

  // Disk initialization: scan mediaDir for existing .meta.json files on startup.
  // Only the newest MEDIA_INDEX_MAX entries enter RAM; older files stay on disk and
  // are re-hydrated lazily by getMediaPath()/getMediaMeta().
  function initFromDisk() {
    try {
      if (!fs.existsSync(mediaDir)) {
        fs.mkdirSync(mediaDir, { recursive: true });
        return;
      }
      const candidates = [];
      for (const file of fs.readdirSync(mediaDir)) {
        if (file.endsWith('.meta.json')) {
          diskStats.sidecars += 1;
        } else {
          diskStats.files += 1;
        }
        if (!file.endsWith('.meta.json')) continue;
        const mediaId = file.slice(0, -10);
        const read = readSidecar(mediaId);
        if (!read?.meta) continue;
        const meta = read.meta;
        if (!fs.existsSync(meta.filePath)) continue;
        const savedAt = Number(meta.savedAt);
        let sortKey = Number.isFinite(savedAt) && savedAt > 0 ? savedAt : 0;
        if (!sortKey) {
          try {
            sortKey = fs.statSync(meta.filePath).mtimeMs;
          } catch {
            sortKey = 0;
          }
        }
        try {
          diskStats.bytes += fs.statSync(meta.filePath).size;
        } catch {
          // file disappeared between existsSync and stat — ignore for stats
        }
        candidates.push({ mediaId, meta, sortKey });
      }
      // En yeni N kaydi tut; Map'e eskiden yeniye ekle ki ilk anahtar en eski olsun
      // ve evictOverflowMedia FIFO davranisini korusun.
      candidates.sort((a, b) => a.sortKey - b.sortKey);
      const keep = MEDIA_INDEX_MAX > 0 ? candidates.slice(-MEDIA_INDEX_MAX) : [];
      for (const { mediaId, meta } of keep) {
        mediaIndex.set(mediaId, meta);
        if (meta.waMessageId) {
          mediaByWaId.set(String(meta.waMessageId), mediaId);
        }
      }
      if (candidates.length > MEDIA_INDEX_MAX) {
        logger?.info(
          { indexed: MEDIA_INDEX_MAX, onDisk: candidates.length },
          'Media index capped on startup; older files remain lazily resolvable'
        );
      }
    } catch (err) {
      logger?.warn({ err }, 'Failed to initialize media store from disk');
    }
  }

  initFromDisk();

  function evictOverflowMedia() {
    while (mediaIndex.size > MEDIA_INDEX_MAX) {
      const oldestId = mediaIndex.keys().next().value;
      const entry = mediaIndex.get(oldestId);
      mediaIndex.delete(oldestId);
      if (entry?.waMessageId) {
        mediaByWaId.delete(String(entry.waMessageId));
      }
      // Yalnizca RAM siniri uygulanir. Fiziksel dosya ve sidecar silinmez:
      // DB satirlari hala onlari isaret ediyor ve lazy sidecar okumasi geri getirir.
      logger?.debug({ mediaId: oldestId }, 'Media index entry evicted; file retained on disk');
    }
  }

  function getMediaMeta(mediaId) {
    if (!mediaId || !isSafeMediaKey(mediaId)) return null;
    const strId = String(mediaId);
    const indexed = mediaIndex.get(strId);
    if (indexed) return indexed;

    const direct = readSidecar(strId);
    if (direct?.corrupt) return direct;
    if (direct?.meta) return direct.meta;

    if (mediaByWaId.has(strId)) {
      const mappedId = mediaByWaId.get(strId);
      const mapped = mediaIndex.get(mappedId);
      if (mapped) return mapped;
      const side = readSidecar(mappedId);
      if (side?.corrupt) return side;
      if (side?.meta) return side.meta;
    }

    const scanned = findMetaByWaId(strId);
    return scanned ? scanned.meta : null;
  }

  async function hashFile(filePath) {
    const hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(filePath)) {
      hash.update(chunk);
    }
    return hash.digest('hex');
  }

  // Ayni acik FD uzerinden hash: yol yeniden acilmaz, TOCTOU penceresi olusmaz.
  function hashFd(fd) {
    return new Promise((resolve, reject) => {
      const hash = createHash('sha256');
      const stream = fs.createReadStream(null, { fd, autoClose: false, start: 0 });
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('error', reject);
      stream.on('end', () => resolve(hash.digest('hex')));
    });
  }

  function rememberIntegrity(filePath, value) {
    integrityCache.delete(filePath);
    integrityCache.set(filePath, value);
    while (integrityCache.size > INTEGRITY_CACHE_MAX) {
      integrityCache.delete(integrityCache.keys().next().value);
    }
  }

  /**
   * Disk uzerindeki dosyayi sidecar hash'i ile dogrular.
   * - sidecar yok        → legacy, kabul (mumkunse sizeBytes kontrolu)
   * - sidecar bozuk      → META_CORRUPT (kontrollu hata)
   * - hash uyusmuyor     → HASH_MISMATCH (asla basari sayilmaz)
   *
   * NOT: Bu fonksiyon yol tabanlidir (stat + hashFile). HTTP route'lari bunun
   * yerine dogrulama ve gonderimi AYNI FD uzerinden yapan `openVerifiedMedia`
   * kullanir; burada yol degisimi (rename swap) penceresi kalirdi.
   */
  async function verifyMediaIntegrity(mediaId, filePath) {
    // Dosya adi `${mediaId}.${ext}` oldugu icin sidecar'i dosyadan turet; wa_message_id
    // ile gelen istekte ayni waId'ye ait birden fazla kopya olsa bile hash eslesir.
    const pathMediaId = path.basename(filePath).split('.')[0];
    const meta = (await getMediaMetaAsync(pathMediaId)) || (await getMediaMetaAsync(mediaId));
    if (meta && meta.corrupt) {
      return { ok: false, reason: 'META_CORRUPT' };
    }
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return { ok: false, reason: 'MISSING' };
    }
    if (!meta || !meta.sha256) {
      if (meta && Number.isFinite(meta.sizeBytes) && stat.size !== meta.sizeBytes) {
        return {
          ok: false,
          reason: 'SIZE_MISMATCH',
          expectedBytes: meta.sizeBytes,
          actualBytes: stat.size,
          legacy: true,
        };
      }
      return { ok: true, legacy: true };
    }
    const expected = String(meta.sha256).toLowerCase();
    const cached = integrityCache.get(filePath);
    if (
      cached &&
      cached.size === stat.size &&
      cached.mtimeMs === stat.mtimeMs &&
      cached.ctimeMs === stat.ctimeMs &&
      cached.expected === expected
    ) {
      return { ok: true, legacy: false, sha256: cached.actual, cached: true };
    }
    const actual = await hashFile(filePath);
    if (actual !== expected) {
      return { ok: false, reason: 'HASH_MISMATCH', legacy: false };
    }
    rememberIntegrity(filePath, {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      expected,
      actual,
    });
    return { ok: true, legacy: false, sha256: actual };
  }

  /**
   * Dogrulama ve gonderim icin dosyayi TEK KEZ acar.
   *
   * Basarida `stream` ayni FD'den okur; yol bu noktadan sonra yeniden
   * cozulmez. Boylece "dogrulanan bayt" ile "gonderilen bayt" ayni inode'a
   * aittir. Basarisizlikta FD kapatilir ve akis DONDURULMEZ.
   *
   * Legacy (sidecar'siz / hash'siz) dosyalar kabul edilir ancak `legacy:true`
   * ile isaretlenir; hash dogrulanmis gibi raporlanmaz.
   */
  async function openVerifiedMedia(mediaId, filePath) {
    // Metadata once okunur: bozuk sidecar ve gecersiz MIME, FD ACILMADAN
    // reddedilir. Boylece header hatasi bir dosya tanimlayicisini sizdiramaz.
    const pathMediaId = path.basename(filePath).split('.')[0];
    const meta = (await getMediaMetaAsync(pathMediaId)) || (await getMediaMetaAsync(mediaId));
    if (meta && meta.corrupt) {
      return { ok: false, reason: 'META_CORRUPT' };
    }
    const mimeType = meta?.mimeType || mimeFromPath(filePath);
    if (!isSafeMimeType(mimeType)) {
      return { ok: false, reason: 'INVALID_MIME' };
    }

    let fd = null;
    try {
      fd = fs.openSync(filePath, 'r');
    } catch (err) {
      if (err && err.code === 'ENOENT') return { ok: false, reason: 'MISSING' };
      throw err;
    }
    try {
      let stat;
      try {
        stat = fs.fstatSync(fd);
      } catch {
        fs.closeSync(fd);
        fd = null;
        return { ok: false, reason: 'MISSING' };
      }
      if (!stat.isFile()) {
        fs.closeSync(fd);
        fd = null;
        return { ok: false, reason: 'MISSING' };
      }
      let legacy = true;
      if (!meta || !meta.sha256) {
        if (meta && Number.isFinite(meta.sizeBytes) && stat.size !== meta.sizeBytes) {
          fs.closeSync(fd);
          fd = null;
          return { ok: false, reason: 'SIZE_MISMATCH', legacy: true };
        }
      } else {
        const expected = String(meta.sha256).toLowerCase();
        const actual = await hashFd(fd);
        if (actual !== expected) {
          fs.closeSync(fd);
          fd = null;
          return { ok: false, reason: 'HASH_MISMATCH' };
        }
        const after = fs.fstatSync(fd);
        if (
          after.size !== stat.size ||
          after.mtimeMs !== stat.mtimeMs ||
          after.ctimeMs !== stat.ctimeMs
        ) {
          fs.closeSync(fd);
          fd = null;
          return { ok: false, reason: 'CHANGED_DURING_VERIFY' };
        }
        legacy = false;
      }
      const size = stat.size;
      const filename = meta?.filename || null;
      if (size === 0) {
        fs.closeSync(fd);
        fd = null;
        return { ok: true, legacy, stream: Readable.from([]), size: 0, mimeType, filename };
      }
      const stream = fs.createReadStream(null, {
        fd,
        autoClose: true,
        start: 0,
        end: size - 1,
      });
      // FD sahipligi artik stream'e aittir.
      fd = null;
      return { ok: true, legacy, stream, size, mimeType, filename };
    } catch (err) {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          // already closed
        }
      }
      throw err;
    }
  }

  function getMediaIdByWaId(waMessageId) {
    if (!waMessageId) return null;
    const strId = String(waMessageId);
    if (mediaByWaId.has(strId)) {
      const mediaId = mediaByWaId.get(strId);
      const entry = mediaIndex.get(mediaId);
      if (entry && entry.filePath && fs.existsSync(entry.filePath)) {
        return mediaId;
      }
    }
    return null;
  }

  function getMediaPath(sessionId, mediaId, { allowSyncScan = true } = {}) {
    if (!mediaId || !isSafeMediaKey(mediaId)) return null;
    const strMediaId = String(mediaId);
    let entry = mediaIndex.get(strMediaId);

    // If mediaId wasn't found directly, check if it's a waMessageId
    if (!entry && mediaByWaId.has(strMediaId)) {
      const mappedId = mediaByWaId.get(strMediaId);
      entry = mediaIndex.get(mappedId);
    }

    // RAM'den dusmus (evicted) bir media_id ise sidecar'dan geri yukle.
    if (!entry) {
      const read = readSidecar(strMediaId);
      if (read?.meta && fs.existsSync(read.meta.filePath)) {
        entry = read.meta;
        mediaIndex.set(strMediaId, entry);
        if (entry.waMessageId) {
          mediaByWaId.set(String(entry.waMessageId), strMediaId);
        }
        evictOverflowMedia();
      } else if (!read && allowSyncScan) {
        // GERIYE UYUMLULUK: senkron tarama yalnizca acikca izin verilirse.
        // Istek yolu `resolveMediaPath` uzerinden ASENKRON tam tarama kullanir.
        const scanned = findMetaByWaId(strMediaId);
        if (scanned && fs.existsSync(scanned.meta.filePath)) {
          entry = scanned.meta;
          mediaIndex.set(scanned.mediaId, entry);
          if (entry.waMessageId) {
            mediaByWaId.set(String(entry.waMessageId), scanned.mediaId);
          }
          evictOverflowMedia();
        }
      }
    }

    // Direct filesystem check fallback (e.g. ${mediaId}.jpeg, ${mediaId}.mp4, etc.)
    // Yalnizca TAM eslesen kok ad kabul edilir; onek eslesmesi baska bir dosyayi
    // "dogrulanmis" gibi sunabilirdi.
    if (!entry) {
      try {
        const files = fs.readdirSync(mediaDir);
        const match = files.find(
          (f) => !f.endsWith('.meta.json') && f.split('.')[0] === strMediaId
        );
        if (match) {
          const fullPath = path.join(mediaDir, match);
          entry = { filePath: fullPath, sessionId: sessionId ? String(sessionId) : '' };
          mediaIndex.set(strMediaId, entry);
          evictOverflowMedia();
        }
      } catch {
        // directory read failed
      }
    }

    if (!entry || !entry.filePath || !fs.existsSync(entry.filePath)) return null;
    // CRITICAL: Do NOT reject if entry.sessionId !== sessionId.
    // Downloaded media belongs to CRM conversations. Ephemeral QR re-links assign a new
    // sessionId, but historical messages still reference the persisted media files.
    return entry.filePath;
  }

  /**
   * Istek yolu icin yol cozumu.
   *
   * Once hizli, senkron ve TARAMASIZ yolu dener. Bulamazsa sidecar'lari
   * ASENKRON ve sinirsiz tarar (5000+ dosyada da calisir). Boylece event loop
   * senkron dizin/JSON okumalariyla bloklanmaz.
   */
  function hydrateIndexEntry(mediaId, meta) {
    mediaIndex.set(mediaId, meta);
    if (meta.waMessageId) {
      mediaByWaId.set(String(meta.waMessageId), mediaId);
    }
    evictOverflowMedia();
  }

  async function resolveMediaPath(sessionId, mediaId) {
    if (!mediaId || !isSafeMediaKey(mediaId)) return null;
    const strId = String(mediaId);

    // 1. RAM (salt bellek, I/O yok)
    let entry = mediaIndex.get(strId);
    if (!entry && mediaByWaId.has(strId)) {
      entry = mediaIndex.get(mediaByWaId.get(strId));
    }
    if (entry?.filePath && (await fileExistsAsync(entry.filePath))) return entry.filePath;

    // 2. Dogrudan sidecar (asenkron). Evicted bir media_id burada bulunur.
    const direct = await readSidecarAsync(strId);
    if (direct?.meta?.filePath && (await fileExistsAsync(direct.meta.filePath))) {
      hydrateIndexEntry(strId, direct.meta);
      return direct.meta.filePath;
    }
    // Bozuk sidecar "legacy" sayilmaz: dosya bulunsa bile metadata'siz bir
    // indeks girdisi YAZILMAZ, boylece openVerifiedMedia META_CORRUPT dondurur.
    const metadataCorrupt = Boolean(direct?.corrupt);

    // 3. wa_message_id ile tam sidecar taramasi (asenkron, sinirsiz)
    if (!metadataCorrupt) {
      const scanned = await findMetaByWaIdAsync(strId);
      if (scanned?.meta?.filePath && (await fileExistsAsync(scanned.meta.filePath))) {
        hydrateIndexEntry(scanned.mediaId, scanned.meta);
        return scanned.meta.filePath;
      }
    }

    // 4. Sidecar'siz legacy dosya: ASENKRON dizin okumasi, TAM kok ad eslesmesi.
    //    Onek eslesmesi bilerek yoktur; "abc" istegi "abcdef.jpg" dosyasini acmaz.
    try {
      const files = await fs.promises.readdir(mediaDir);
      const match = files.find(
        (f) => !f.endsWith('.meta.json') && f.split('.')[0] === strId
      );
      if (match) {
        const fullPath = path.join(mediaDir, match);
        if (await fileExistsAsync(fullPath)) {
          if (metadataCorrupt) return fullPath;
          mediaIndex.set(strId, { filePath: fullPath, sessionId: sessionId ? String(sessionId) : '' });
          evictOverflowMedia();
          return fullPath;
        }
      }
    } catch {
      // directory unreadable — miss
    }
    return null;
  }

  function storeMediaBuffer(sessionId, buffer, { mimeType, filename, waMessageId } = {}) {
    if (!buffer || !Buffer.isBuffer(buffer)) return null;
    const mediaId = uuidv4();
    // Sidecar'a yazilan MIME ileride HTTP header'a donusur. Gecersiz bir
    // deger burada normalize edilir; yeni kayitlar asla riskli metadata
    // uretmez (eski kayitlar okuma yolunda reddedilir).
    const resolvedMime = isSafeMimeType(mimeType) ? mimeType.trim() : 'application/octet-stream';
    const ext = (resolvedMime.split('/')[1] || 'bin').split(';')[0];
    const resolvedFilename = filename || `media_${mediaId}.${ext}`;
    const filePath = path.join(mediaDir, `${mediaId}.${ext}`);
    try {
      fs.writeFileSync(filePath, buffer);
    } catch (writeErr) {
      // Disk dolu (ENOSPC) veya yazilamaz: kismi dosya birakma. Yalnizca BU
      // cagride olusturulan dosya temizlenir; mevcut dosyalara dokunulmaz.
      try {
        fs.rmSync(filePath, { force: true });
      } catch {
        // cleanup best-effort
      }
      logger?.error(
        { err: writeErr?.code || writeErr?.message, mediaId },
        'Media write failed; no index or DB reference will be created'
      );
      return null;
    }
    const meta = {
      sessionId: String(sessionId || ''),
      waMessageId: waMessageId ? String(waMessageId) : null,
      filePath,
      mimeType: resolvedMime,
      filename: resolvedFilename,
      sizeBytes: buffer.length,
      sha256: createHash('sha256').update(buffer).digest('hex'),
      savedAt: Date.now(),
    };
    const metaPath = path.join(mediaDir, `${mediaId}.meta.json`);
    try {
      fs.writeFileSync(metaPath, JSON.stringify(meta), 'utf8');
    } catch (metaErr) {
      // Hash/butunluk kaniti yazilamadi. Yeni dosyayi geri al: aksi halde
      // dogrulanamayan bir dosyaya DB referansi baglanabilirdi. Mevcut
      // dosyalar ve sidecar'lar ETKILENMEZ.
      try {
        fs.rmSync(filePath, { force: true });
      } catch {
        // cleanup best-effort
      }
      logger?.error(
        { err: metaErr?.code || metaErr?.message, mediaId },
        'Media sidecar write failed; rolled back the new file'
      );
      return null;
    }
    diskStats.files += 1;
    diskStats.sidecars += 1;
    diskStats.bytes += buffer.length;
    mediaIndex.set(mediaId, meta);
    if (waMessageId) {
      mediaByWaId.set(String(waMessageId), mediaId);
    }
    evictOverflowMedia();
    return { media_id: mediaId, mime_type: resolvedMime, filename: resolvedFilename, size_bytes: buffer.length };
  }

  let activeMediaDownloads = 0;
  const MAX_CONCURRENT_MEDIA_DOWNLOADS = 3;
  const mediaDownloadWaiters = [];

  async function acquireMediaDownloadSlot() {
    if (activeMediaDownloads < MAX_CONCURRENT_MEDIA_DOWNLOADS) {
      activeMediaDownloads++;
      return;
    }
    await new Promise((resolve) => mediaDownloadWaiters.push(resolve));
    activeMediaDownloads++;
  }

  function releaseMediaDownloadSlot() {
    activeMediaDownloads = Math.max(0, activeMediaDownloads - 1);
    if (mediaDownloadWaiters.length > 0) {
      const next = mediaDownloadWaiters.shift();
      if (next) next();
    }
  }

  // Baileys `messageTimestamp` saniye (Long|number|string) olabilir.
  function coerceMessageTimestampMs(waMessage) {
    const raw = waMessage?.messageTimestamp;
    if (raw === undefined || raw === null) return null;
    let seconds;
    if (typeof raw === 'object' && typeof raw.toNumber === 'function') {
      seconds = raw.toNumber();
    } else if (typeof raw === 'object' && typeof raw.toString === 'function') {
      seconds = Number(raw.toString());
    } else {
      seconds = Number(raw);
    }
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    return seconds * 1000;
  }

  // Bu surecten SONRA uretilmis bir mesaj diskte olamaz; canli akista tam
  // sidecar taramasini atlariz. Zaman damgasi yoksa guvenli taraf: tara.
  function shouldCheckDiskForDuplicate(waMessage) {
    const tsMs = coerceMessageTimestampMs(waMessage);
    if (tsMs === null) return true;
    return tsMs < processStartedAtMs;
  }

  function existingFromEntry(mediaId, entry) {
    return {
      media_id: mediaId,
      mime_type: entry.mimeType,
      filename: entry.filename,
      size_bytes: entry.sizeBytes,
    };
  }

  /**
   * Ayni wa_message_id icin diskte kayit var mi?
   *
   * 1) RAM (O(1)): normal canli akis.
   * 2) Disk (asenkron, tekillesen tam tarama): restart veya RAM eviction
   *    sonrasi ayni mesajin yeniden indirilip KOPYA uretmesini engeller.
   */
  async function findExistingMediaByWaId(waMessageId, waMessage, session) {
    const strId = String(waMessageId);
    // Dedupe KAPSAMI oturumdur. Ayni wa_message_id farkli oturumlarda
    // gorunurse kayit paylasilmaz; aksi halde B oturumu A'nin dosyasini
    // kendisininmis gibi dondururdu.
    const scope = session?.id ? String(session.id) : '';
    if (mediaByWaId.has(strId)) {
      const mediaId = mediaByWaId.get(strId);
      const entry = mediaIndex.get(mediaId);
      if (
        entry &&
        entry.filePath &&
        String(entry.sessionId || '') === scope &&
        fs.existsSync(entry.filePath)
      ) {
        return existingFromEntry(mediaId, entry);
      }
    }
    if (!shouldCheckDiskForDuplicate(waMessage)) return null;
    const scanKey = `${scope}\u0000${strId}`;
    let scan = dedupeScans.get(scanKey);
    if (!scan) {
      scan = findMetaByWaIdAsync(strId, scope);
      dedupeScans.set(scanKey, scan);
      scan.finally(() => dedupeScans.delete(scanKey));
    }
    const found = await scan;
    if (
      found?.meta?.filePath &&
      String(found.meta.sessionId || '') === scope &&
      (await fileExistsAsync(found.meta.filePath))
    ) {
      mediaIndex.set(found.mediaId, found.meta);
      mediaByWaId.set(strId, found.mediaId);
      evictOverflowMedia();
      return existingFromEntry(found.mediaId, found.meta);
    }
    return null;
  }

  async function ingestIncomingMedia(session, waMessage, sock, options = {}) {
    try {
      const waMessageId = waMessage?.key?.id;
      // Ayni mesajin medyasi RAM'de veya diskte zaten varsa YENI KOPYA URETME.
      if (waMessageId) {
        const existing = await findExistingMediaByWaId(String(waMessageId), waMessage, session);
        if (existing) return existing;
      }

      const unwrappedMessage = unwrapMessageContent(waMessage?.message) || waMessage?.message;
      const effectiveWaMessage = { ...waMessage, message: unwrappedMessage };
      const resolved = resolveDownloadableMedia(unwrappedMessage);
      if (!resolved) {
        logger?.debug(
          { waMessageId },
          'Medya indirilmedi: indirilebilir icerik bulunamadi'
        );
        return null;
      }
      const { media, mediaType } = resolved;

      // P1 FAST-PATH: If caller requested preview only and thumbnail is present, return immediately (0ms)
      if (options?.preferPreview && media.jpegThumbnail) {
        const thumbBuf = Buffer.isBuffer(media.jpegThumbnail)
          ? media.jpegThumbnail
          : Buffer.from(media.jpegThumbnail);
        if (thumbBuf.length > 0) {
          logger?.debug({ waMessageId }, 'Fast path: returning jpegThumbnail preview');
          return storeMediaBuffer(session?.id, thumbBuf, {
            mimeType: 'image/jpeg',
            filename: `thumb_${waMessageId || 'preview'}.jpeg`,
            waMessageId,
          });
        }
      }

      // If media.url is missing but directPath exists, provide fallback so Baileys internal validator doesn't reject
      if (!media.url && media.directPath) {
        media.url = 'https://mmg.whatsapp.net';
      }

      let buffer = null;
      await acquireMediaDownloadSlot();
      try {
        const dlPromise = (async () => {
          try {
            return await downloadMediaMessage(
              effectiveWaMessage,
              'buffer',
              {},
              { logger, reuploadRequest: sock?.updateMediaMessage }
            );
          } catch (dlErr) {
            // Direct fallback via downloadContentFromMessage if Baileys wrapper failed
            if ((media.directPath || media.url) && media.mediaKey) {
              try {
                const stream = await downloadContentFromMessage(media, mediaType || 'image', {});
                let buf = Buffer.from([]);
                for await (const chunk of stream) {
                  buf = Buffer.concat([buf, chunk]);
                }
                if (buf.length > 0) return buf;
              } catch (directErr) {
                logger?.debug({ directErr: directErr?.message, waMessageId }, 'downloadContentFromMessage fallback failed');
              }
            }
            throw dlErr;
          }
        })();

        let dlTimer;
        const dlTimeout = new Promise((_, reject) => {
          dlTimer = setTimeout(() => reject(new Error('Media download timeout (10s)')), 10_000);
        });
        dlTimeout.catch(() => {});
        try {
          buffer = await Promise.race([dlPromise, dlTimeout]);
        } finally {
          if (dlTimer) clearTimeout(dlTimer);
        }
      } catch (dlErr) {
        logger?.debug({ dlErr: dlErr?.message, waMessageId }, 'downloadMediaMessage failed or timed out, checking thumbnail');
      } finally {
        releaseMediaDownloadSlot();
      }

      let mimeType = media.mimetype || 'application/octet-stream';
      let filename = media.fileName || undefined;

      // Fallback: If full download failed (e.g. expired link on CDN), use jpegThumbnail as preview
      if (!buffer && media.jpegThumbnail) {
        const thumbBuf = Buffer.isBuffer(media.jpegThumbnail)
          ? media.jpegThumbnail
          : Buffer.from(media.jpegThumbnail);
        if (thumbBuf.length > 0) {
          buffer = thumbBuf;
          mimeType = 'image/jpeg';
          filename = filename || `thumb_${waMessageId || 'preview'}.jpeg`;
          logger?.info({ waMessageId }, 'Using jpegThumbnail fallback for media preview');
        }
      }

      if (!buffer) return null;
      return storeMediaBuffer(session?.id, buffer, { mimeType, filename, waMessageId });
    } catch (err) {
      logger?.warn({ err }, 'Failed to store incoming media');
      return null;
    }
  }

  /**
   * Ayni (oturum, wa_message_id) icin es zamanli cagrilar TEK indirme/yazma
   * yapar; digerleri ayni Promise'in sonucunu bekler. Anahtar `finally`
   * icinde, yalnizca hala bu goreve aitse silinir — basarisiz bir islem
   * sonraki denemeyi kilitlemez.
   */
  async function storeIncomingMedia(session, waMessage, sock, options = {}) {
    let key = null;
    let task = null;
    try {
      const waMessageId = waMessage?.key?.id;
      if (!waMessageId) {
        return await ingestIncomingMedia(session, waMessage, sock, options);
      }
      key = ingestLockKey(session, waMessageId);
      const pending = ingestLocks.get(key);
      if (pending) return await pending;

      task = ingestIncomingMedia(session, waMessage, sock, options);
      ingestLocks.set(key, task);
      return await task;
    } catch (err) {
      // `ingestIncomingMedia` hatalari yutar. Buraya yalnizca beklenmedik bir
      // throw (ör. bozuk bir getter) ulasir; eski "asla firlatma" sozlesmesi
      // korunur ve anahtar `finally` ile yine temizlenir.
      logger?.warn({ err }, 'Media ingestion failed unexpectedly');
      return null;
    } finally {
      // Yalnizca bizim kaydimizi sil; gelecekteki bir sahip varsa dokunma.
      if (key && task && ingestLocks.get(key) === task) ingestLocks.delete(key);
    }
  }

  function clearSessionMedia(sessionId) {
    // CRITICAL: Do NOT delete downloaded CRM conversation media files from disk upon
    // disconnect or logout. Disconnecting a WhatsApp line or relinking with QR code
    // intentionally preserves conversation history and media attachments. Disk files
    // are never removed here or on index eviction; only the RAM index is bounded.
  }

  /**
   * Disk doluluk gozlemlenebilirligi. SILME KARARI URETMEZ.
   *
   * `files`/`sidecars`/`bytes` yalnizca sayimdir (PII yok). `free_bytes` /
   * `total_bytes` dosya sisteminden okunur. Otomatik retention/eviction YOKTUR;
   * RAM indeksi siniri disinda hicbir sey silinmez.
   */
  async function mediaCapacitySummary() {
    let freeBytes = null;
    let totalBytes = null;
    try {
      const fsStat = await fs.promises.statfs(mediaDir);
      freeBytes = Number(fsStat.bavail) * Number(fsStat.bsize);
      totalBytes = Number(fsStat.blocks) * Number(fsStat.bsize);
    } catch {
      // statfs desteklenmiyorsa yalnizca sayimlar doner.
    }
    return {
      files: diskStats.files,
      sidecars: diskStats.sidecars,
      bytes: diskStats.bytes,
      free_bytes: Number.isFinite(freeBytes) ? freeBytes : null,
      total_bytes: Number.isFinite(totalBytes) ? totalBytes : null,
      index_entries: mediaIndex.size,
      index_max: MEDIA_INDEX_MAX,
    };
  }

  return {
    mediaIndex,
    mediaByWaId,
    getMediaPath,
    resolveMediaPath,
    getMediaIdByWaId,
    getMediaMeta,
    getMediaMetaAsync,
    verifyMediaIntegrity,
    openVerifiedMedia,
    mediaCapacitySummary,
    storeIncomingMedia,
    storeMediaBuffer,
    evictOverflowMedia,
    clearSessionMedia,
  };
}
