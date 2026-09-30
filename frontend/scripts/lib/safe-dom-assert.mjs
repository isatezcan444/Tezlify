/**
 * DOM guvenli assertion sarmalayicisi — jsdom kapanlarinda sessiz OOM'u onler.
 *
 * SORUN (olculdu, tahmin degil)
 * -----------------------------
 * Bu depodaki jsdom dogrulama kapanlari gercek bilesenleri render edip DOM
 * uzerinde iddia kurar. Node'un `assert`i basarisiz bir karsilastirmayi
 * raporlarken degeri `util.inspect(v, { depth: 1000, customInspect: false })`
 * ile metne cevirir. `customInspect: false` jsdom'un ucuz custom inspect'ini
 * DEVRE DISI birakir ve elemani bastan sona yurur — React'in DOM dugumlerine
 * taktigi `__reactFiber$*` / `__reactProps$*` geri referanslari dahil.
 *
 * React ile render edilmis tek bir `<iframe>` icin olculen deger:
 *
 *   inspect(el)                                        ->      3.391 karakter, RSS degismedi
 *   inspect(el, { depth: 1000, customInspect: false }) -> 137.861.117 karakter, RSS 186MB -> 509MB
 *
 * Sonuc: surec ne stderr ne de "JavaScript heap out of memory" birakmadan
 * SIGKILL ile olur (exit 137). Gozlemlenen belirti makinenin RAM'inin
 * tukenmesiydi; tek teshis izi ciktinin yarida kesilmesi oldu.
 *
 * COZUM
 * -----
 * Esitlik ailesi sarmalanir. Karsilastirma ONCE sarmalayicinin kendisi yapar:
 *  - iki taraf da DOM dugumu DEGILSE -> orijinal fonksiyona aynen devredilir
 *    (davranis birebir ayni kalir);
 *  - taraflardan biri DOM dugumu ise ve karsilastirma GECERSE -> hicbir sey
 *    yapilmaz (Node'un mesaj uretimine hic girilmez, bu yuzden yanlis alarm yok);
 *  - taraflardan biri DOM dugumu ise ve karsilastirma BASARISIZ olursa ->
 *    OOM'a gitmek yerine okunabilir bir hata firlatilir.
 *
 * Bu ayrim onemli: `assert.equal(document.activeElement, input, ...)` gibi
 * MESRU eleman karsilastirmalari vardir ve gecmeleri gerekir. Sarmalayici
 * onlari bozmaz; yalnizca patlayacak olani guvenli hale getirir.
 *
 * KURAL: bir kapan icinde eleman karsilastirmasi yapacaksaniz, ifadenin
 * sonucunu boolean'a cevirin; bu sarmalayici yalnizca son savunma hattidir.
 *   KOTU : assert.equal(scope.querySelector('[data-testid="x"]'), null)
 *   IYI  : assert.ok(scope.querySelector('[data-testid="x"]') === null, '...')
 *          assert.equal(el.getAttribute('src'), '/api/...')
 */
import { isDeepStrictEqual } from 'node:util';

/**
 * `node:assert/strict` semantigi: `equal` -> `strictEqual`,
 * `deepEqual` -> `deepStrictEqual`. Bu yuzden tum karsilastirmalar strict'tir.
 */
const COMPARATORS = {
  equal: (a, b) => a === b,
  strictEqual: (a, b) => a === b,
  notEqual: (a, b) => a !== b,
  notStrictEqual: (a, b) => a !== b,
  deepEqual: (a, b) => isDeepStrictEqual(a, b),
  deepStrictEqual: (a, b) => isDeepStrictEqual(a, b),
  deepNotEqual: (a, b) => !isDeepStrictEqual(a, b),
  deepNotStrictEqual: (a, b) => !isDeepStrictEqual(a, b),
};

/** jsdom/gercek DOM dugumu mu? (nodeType + nodeName tasiyan nesne) */
export const isDomNode = (value) =>
  Boolean(value) &&
  typeof value === 'object' &&
  typeof value.nodeType === 'number' &&
  typeof value.nodeName === 'string';

const describe = (value) => {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (isDomNode(value)) return `<${String(value.nodeName).toLowerCase()}${value.id ? '#' + value.id : ''}>`;
  return typeof value;
};

/**
 * Verilen assert nesnesine DOM korumasini kurar. Idempotenttir.
 * @param {object} assertModule `node:assert/strict` varsayilan export'u
 * @returns {object} ayni modul (zincirlenebilir)
 */
export function hardenAssert(assertModule) {
  if (!assertModule || assertModule.__domHardened) return assertModule;

  for (const [name, compare] of Object.entries(COMPARATORS)) {
    const original = assertModule[name];
    if (typeof original !== 'function') continue;

    assertModule[name] = function guarded(actual, expected, message) {
      const touchesDom = isDomNode(actual) || isDomNode(expected);
      if (!touchesDom) return original(actual, expected, message);

      // Karsilastirmayi kendimiz yapariz: gecerse Node'un mesaj uretimine hic
      // girilmez, dolayisiyla mesru eleman karsilastirmalari bozulmaz.
      if (compare(actual, expected)) return undefined;

      throw new Error(
        `assert.${name}() failed on a live DOM element. Reporting it through Node would ` +
          `deep-inspect the element with customInspect:false and exhaust memory ` +
          `(measured: 137MB string from a single iframe, then SIGKILL with no diagnostic). ` +
          `Got ${describe(actual)} vs ${describe(expected)}. ` +
          `Assertion: ${String(message ?? '(no message)')}`,
      );
    };
  }

  Object.defineProperty(assertModule, '__domHardened', { value: true, enumerable: false });
  return assertModule;
}

export default hardenAssert;
