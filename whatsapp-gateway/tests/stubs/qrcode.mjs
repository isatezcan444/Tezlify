/**
 * Test stub for qrcode. Pairing QR rendering is never exercised here.
 */
export async function toDataURL() {
  throw new Error('qrcode stub: QR rendering is not available in unit tests');
}

export async function toString() {
  throw new Error('qrcode stub: QR rendering is not available in unit tests');
}

export default { toDataURL, toString };
