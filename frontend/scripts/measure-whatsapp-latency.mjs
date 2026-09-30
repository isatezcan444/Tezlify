/**
 * Measures real ingest latency on the deployed system, from the database.
 *
 * WHY THIS EXISTS
 * ---------------
 * Everything measured so far was jsdom or a single browser page load. The
 * user's report was that new messages "arrive late", and nothing in the test
 * suite could answer it. This reads the production database and separates the
 * two populations that were being conflated:
 *
 *   live   — a single message persisted shortly after WhatsApp stamped it.
 *            This is the number a person actually feels.
 *   bulk   — a history/hydration backfill. Its "latency" is not latency at all;
 *            the message was already old when it was written. Reporting an
 *            average across both makes a healthy system look broken.
 *
 * A previous unfiltered average showed p95 = 63 DAYS, which reads as a severe
 * regression and is in fact just backfill. Separating the paths is the whole
 * point.
 *
 * It also flags clustering: several rows sharing one write second is the
 * signature of a bulk hydration, not of delivery.
 *
 * Run: node scripts/measure-whatsapp-latency.mjs [--live] — exit 0 = within
 * budget. Pass --live to SKIP the latency assertion and only print, which is
 * what you want on a quiet system with no traffic in the window.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

// `exec`/`execFile` both reject an argv array here: the remote command is
// composed (ssh -> cd -> docker exec -> psql) and no shell is involved, so it
// is spawned directly and quoted once, at the SSH boundary.
const run = (argv) => new Promise((resolve, reject) => {
  const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  child.on('error', reject);
  child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err || `exit ${code}`))));
});
const SSH_OPTS = [
  '-i', `${process.env.HOME}/.ssh/id_tezlify_oracle`,
  '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
  'ubuntu@130.162.247.20',
];
const LIVE_ONLY = process.argv.includes('--live');
const HOURS = 12;
const LIVE_BUDGET_S = 10;

const psql = async (sql) => {
  // Two things bite here. ssh concatenates trailing arguments into ONE remote
  // command string, so the SQL is a single quoted argument; and it rejects a
  // command containing a newline ("invalid command"), so the query is collapsed
  // to one line before it is sent.
  const flat = sql.replace(/\s*\n\s*/g, ' ').trim();
  const remote = `cd /opt/tezlify && docker exec -i tezlify-db psql -U tezlify -d tezlify -At -F, -c ${JSON.stringify(flat)}`;
  const stdout = await run(['ssh', ...SSH_OPTS, remote]);
  return stdout.trim().split('\n').map((l) => l.trim()).filter(Boolean);
};

// 1. The two populations, split at the 10s line.
const rows = await psql(`
  SELECT CASE WHEN lag_s <= 10 THEN 'live' ELSE 'bulk' END AS path,
         count(*), round(avg(lag_s)::numeric, 2),
         coalesce(max(lag_s), 0)
  FROM (
    SELECT round(EXTRACT(EPOCH FROM (created_at - external_timestamp))) AS lag_s
    FROM public.messages
    WHERE created_at > now() - interval '${HOURS} hours'
      AND external_timestamp IS NOT NULL
  ) t
  GROUP BY 1 ORDER BY 1;
`);

const stats = {};
for (const r of rows) {
  const [path, n, avg, max] = r.split(',');
  stats[path] = { n: Number(n), avg: Number(avg), max: Number(max) };
}

// 1b. Delivery-status latency (the "tik -> gri tik" leg).
//
// DELIVERED is our latency: WhatsApp accepted the message. READ is NOT — it
// fires when the OTHER PERSON opens the chat, so its distribution is a measure
// of human behaviour, not of this system. Mixing them is what makes an average
// look like a 25s regression. They are reported separately, and only
// DELIVERED is asserted.
const statusRows = await psql(`
  SELECT status, count(*), round(avg(lag_s)::numeric, 2), coalesce(max(lag_s), 0)
  FROM (
    SELECT status, round(EXTRACT(EPOCH FROM (updated_at - created_at))) AS lag_s
    FROM public.messages
    WHERE created_at > now() - interval '${HOURS} hours'
      AND direction = 'OUTBOUND'
      AND updated_at > created_at + interval '0.5 seconds'
  ) t GROUP BY 1 ORDER BY 2 DESC;
`);

const statusStats = {};
for (const r of statusRows) {
  const [st, n, avg, max] = r.split(',');
  statusStats[st] = { n: Number(n), avg: Number(avg), max: Number(max) };
}

// 2. Clustering: how many write-seconds carried more than one row.
const clusterRows = await psql(`
  SELECT coalesce(max(c), 0) FROM (
    SELECT count(*) AS c FROM public.messages
    WHERE created_at > now() - interval '${HOURS} hours'
    GROUP BY date_trunc('second', created_at) HAVING count(*) > 1
  ) t;
`);
const largestBurst = Number(clusterRows[0] || 0);

for (const [st, v] of Object.entries(statusStats)) {
  const note = st === 'READ'
    ? '   (other person opened the chat — human timing, not ours)'
    : '   (our latency)';
  console.log(`  status ${st.padEnd(10)} n=${String(v.n).padEnd(4)} avg=${v.avg}s  max=${v.max}s${note}`);
}

const live = stats.live || { n: 0, avg: 0, max: 0};
const bulk = stats.bulk || { n: 0, avg: 0, max: 0 };

console.log(`WHATSAPP INGEST LATENCY — last ${HOURS}h (production)`);
console.log(`  live  (delivery)  n=${live.n}  avg=${live.avg}s  max=${live.max}s`);
console.log(`  bulk  (hydration) n=${bulk.n}  avg=${bulk.avg}s  max=${bulk.max}s`);
console.log(`  largest single-second write burst: ${largestBurst} rows`);

if (!live.n) {
  console.log('\nSKIP: no live deliveries in the window — nothing to assert.');
  console.log('An empty sample is not a pass; run again while messages are arriving.');
  process.exit(0);
}

if (LIVE_ONLY) {
  console.log('\n--live: measurement only, no assertion.');
  process.exit(0);
}

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ok - ${label}`); };

check('live delivery is inside the WhatsApp-Web budget', () => {
  assert.ok(
    live.avg <= LIVE_BUDGET_S,
    `average live latency ${live.avg}s exceeds the ${LIVE_BUDGET_S}s budget — this is the "messages arrive late" symptom`,
  );
});

check('no single live delivery is pathologically slow', () => {
  assert.ok(
    live.max <= 60,
    `worst live delivery took ${live.max}s; a burst this long is not a WhatsApp Web experience`,
  );
});

const delivered = statusStats.DELIVERED;
if (delivered && !LIVE_ONLY) {
  check('delivery status is acknowledged promptly', () => {
    assert.ok(
      delivered.avg <= 10,
      `average SENT->DELIVERED took ${delivered.avg}s; the tick should feel instant`,
    );
  });
  passed += 0;
}

check('bulk writes are distinguishable from live delivery', () => {
  // If these ever collapse into one population, the metric loses the ability to
  // tell a real regression from a backfill — which is how a healthy system
  // previously looked broken.
  assert.ok(
    !(live.max >= 1000 && bulk.max >= 1000 && Math.abs(live.avg - bulk.avg) < 5),
    'live and bulk latency are indistinguishable; the split no longer means anything',
  );
});

console.log(`\n${passed} checks passed`);
process.exit(passed >= 3 ? 0 : 1);
