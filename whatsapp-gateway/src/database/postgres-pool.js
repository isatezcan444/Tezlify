import pg from 'pg';

const { Pool } = pg;

export function createGatewayPostgresPool(connectionString, max = 3) {
  if (!connectionString) throw new Error('Gateway PostgreSQL connection string is required.');
  return new Pool({
    connectionString,
    max: Math.max(1, Math.min(5, Number(max) || 3)),
    min: 0,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 30_000,
    allowExitOnIdle: true,
  });
}
