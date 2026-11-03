/**
 * Test stub for `pg`. The durability harness always injects its own fake pool,
 * so this Pool exists only so modules that destructure it at import time load.
 */
export class Pool {
  constructor(options = {}) {
    this.options = options;
    this.connected = false;
  }

  async query() {
    throw new Error('pg stub: a real Pool must never be used by this harness');
  }

  async connect() {
    throw new Error('pg stub: a real Pool must never be used by this harness');
  }

  on() { return this; }

  async end() {}
}

export const types = {
  setTypeParser() {},
  getTypeParser() { return (value) => value; },
};

export default { Pool, types };
