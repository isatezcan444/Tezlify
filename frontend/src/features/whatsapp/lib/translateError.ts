/**
 * A6/A5 — repository fail-closed hatalari i18n ANAHTARI olarak firlatilir
 * (ornek `whatsapp.templatesNotAvailable`); UI katmani cevirmek zorundadir.
 * Aksi halde kullanıcı ham anahtar gosterir ya da hata sebebini hic goremez
 * (AGENTS.md §3 merkezi localization invariant'i).
 */

// `domain.key` bicimli mesajlar i18n anahtari kabul edilir; serbest metinler
// (backend/gateway hata mesajlari) aynen gecilir.
const I18N_KEY_SHAPE = /^[a-z][a-zA-Z0-9_]*\.[a-zA-Z][a-zA-Z0-9_]*$/;

export function translateApiError(
  err: unknown,
  t: (key: string) => string,
): string | undefined {
  const raw =
    err instanceof Error ? err.message : typeof err === 'string' ? err : undefined;
  if (!raw) return undefined;
  if (I18N_KEY_SHAPE.test(raw)) {
    const translated = t(raw);
    // Anahtar sozluklerde yoksa t() anahtarin kendisini dondurur — bu
    // durumda tanimsiz sayilir ve cagiranin varsayilanina duser.
    return translated === raw ? undefined : translated;
  }
  return raw;
}
