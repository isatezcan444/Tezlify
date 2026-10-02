// Postgres pool 'error' dinleyicisi testi.
//
// SORUN (uretim, 2026-10-01): `docker restart tezlify-db` TUM gateway surecini
// oldurdu. Postgres her istemciyi `57P01 terminating connection due to
// administrator command` ile sonlandirdi; pg-pool bunu Pool uzerinde yeniden
// yaydi (`Client.idleListener`, pg-pool/index.js:62) ve Node'da DINLEYICISI
// OLMAYAN bir 'error' olayi olumculdur: firlatir. Yayma bir socket callback'i
// icinde oldugu icin bu yakalanmamis istisnaya donustu ve surec cikti
// (`restarts` +1, `Emitted 'error' event on BoundPool instance`).
//
// Maliyet saf kayipti: pool bozuk istemciyi ZATEN atiyor ve bir sonraki sorguda
// yenisini acardi. Yani gateway'in tolere edebilecegi bir DB kesintisi, her
// bagli WhatsApp hattini bir lease TTL (~45 sn) boyunca dusurdu.
//
// Bu test iki seyi sabitler: (1) dinleyicisiz bir Pool'un firlattigi (yani
// korumanin gercek bir seyi engelledigi) ve (2) dort pool olusturma noktasinin
// da dinleyici taktigi. Kaynak degisikligi geri alinirsa FAIL eder.
//
// `pg.Pool` alt sinifa cevrilir ve moduller BUNDAN SONRA dinamik import edilir:
// boylece modullerin `const { Pool } = pg` baglamasi alt sinifi yakalar ve
// sinif-ici (disariya acilmayan) yedek pool'lari da inceleyebiliriz.
import assert from 'node:assert/strict';
import pg from 'pg';

const RealPool = pg.Pool;
const created = [];
pg.Pool = class CapturedPool extends RealPool {
  constructor(options) {
    super(options);
    created.push(this);
  }
};

const { attachPoolErrorHandler, createGatewayPostgresPool } = await import(
  '../src/database/postgres-pool.js'
);
const { createPostgresSessionLease } = await import('../src/lease/postgres-session-lease.js');
const { createPostgresAuthRepository } = await import('../src/auth/postgres-auth-repository.js');
const { createPostgresEventOutbox } = await import('../src/outbox/postgres-event-outbox.js');

// Lazy: hicbir pool baglanmaz, bu yuzden gercek bir veritabani gerekmez ve
// surec asili kalmaz.
const FAKE = 'postgresql://user:pw@127.0.0.1:1/nonexistent';
// `createEncryptedCodec` demands a 32-BYTE Buffer (aes-256-gcm), not a string.
const KEY = Buffer.alloc(32, 7);

let passed = 0;
const check = (label, fn) => {
  fn();
  passed += 1;
  console.log(`  ok - ${label}`);
};

const adminShutdown = () =>
  Object.assign(new Error('terminating connection due to administrator command'), {
    code: '57P01',
    severity: 'FATAL',
  });

// --- 1. Baseline: the failure being prevented is real ------------------------
check('a Pool with NO error listener THROWS on emit (the crash being prevented)', () => {
  const bare = new pg.Pool({ connectionString: FAKE });
  assert.equal(bare.listenerCount('error'), 0);
  assert.throws(() => bare.emit('error', adminShutdown()), /terminating connection/);
});

// --- 2. The production pool -------------------------------------------------
check('createGatewayPostgresPool attaches exactly one error listener', () => {
  const before = created.length;
  const pool = createGatewayPostgresPool(FAKE);
  assert.equal(created[created.length - 1], pool);
  assert.ok(created.length > before);
  assert.equal(pool.listenerCount('error'), 1);
  assert.doesNotThrow(() => pool.emit('error', adminShutdown()));
});

// --- 3. The helper itself ----------------------------------------------------
check('attachPoolErrorHandler returns the same pool', () => {
  const pool = new pg.Pool({ connectionString: FAKE });
  assert.equal(attachPoolErrorHandler(pool, 'test'), pool);
  assert.equal(pool.listenerCount('error'), 1);
});

check('the handler NEVER throws, whatever it is handed', () => {
  const pool = attachPoolErrorHandler(new pg.Pool({ connectionString: FAKE }), 'test');
  // Raporlama, raporladigi arizanin kendisi olmamali: bir 'error' dinleyicisinden
  // disari sizan her sey tam da onlemeye calistigimiz yakalanmamis istisnayi
  // yeniden uretirdi.
  assert.doesNotThrow(() => pool.emit('error', adminShutdown()));
  assert.doesNotThrow(() => pool.emit('error', new Error('plain')));
  assert.doesNotThrow(() => pool.emit('error', Object.assign(new Error('no code'))));
  assert.doesNotThrow(() => pool.emit('error', 'a bare string'));
  assert.doesNotThrow(() => pool.emit('error', null));
  assert.doesNotThrow(() => pool.emit('error', undefined));
});

// --- 4. The three fallback pools (unreachable in prod, still reachable) ------
check('the lease repository guards its own fallback pool', () => {
  const before = created.length;
  const lease = createPostgresSessionLease({ connectionString: FAKE });
  assert.equal(lease.ttlSeconds, 45);
  const pool = created[created.length - 1];
  assert.ok(created.length > before, 'lease must create a pool when none is injected');
  assert.equal(pool.listenerCount('error'), 1);
  assert.doesNotThrow(() => pool.emit('error', adminShutdown()));
});

check('the auth repository guards its own fallback pool', () => {
  const before = created.length;
  createPostgresAuthRepository({ connectionString: FAKE, encryptionKey: KEY });
  const pool = created[created.length - 1];
  assert.ok(created.length > before, 'auth must create a pool when none is injected');
  assert.equal(pool.listenerCount('error'), 1);
  assert.doesNotThrow(() => pool.emit('error', adminShutdown()));
});

check('the event outbox guards its own fallback pool', () => {
  const before = created.length;
  createPostgresEventOutbox({ connectionString: FAKE, encryptionKey: KEY });
  const pool = created[created.length - 1];
  assert.ok(created.length > before, 'outbox must create a pool when none is injected');
  assert.equal(pool.listenerCount('error'), 1);
  assert.doesNotThrow(() => pool.emit('error', adminShutdown()));
});

// --- 5. An injected pool is left alone ---------------------------------------
check('an injected pool is not double-wrapped', () => {
  const shared = attachPoolErrorHandler(new pg.Pool({ connectionString: FAKE }), 'shared');
  const before = created.length;
  createPostgresSessionLease({ connectionString: FAKE, pool: shared });
  createPostgresEventOutbox({ connectionString: FAKE, pool: shared, encryptionKey: KEY });
  createPostgresAuthRepository({ connectionString: FAKE, pool: shared, encryptionKey: KEY });
  assert.equal(created.length, before, 'no new pool may be created when one is injected');
  assert.equal(shared.listenerCount('error'), 1);
});

console.log(`[test-postgres-pool-error] ${passed} assertions passed`);
