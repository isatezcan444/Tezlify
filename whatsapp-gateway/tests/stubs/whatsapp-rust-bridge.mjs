/**
 * Test stub for whatsapp-rust-bridge. App-state key expansion is irrelevant to
 * pending-LID durability; returning an empty result keeps the module loadable.
 */
export function expandAppStateKeys() {
  return { keys: [], removed: [] };
}

export default { expandAppStateKeys };
