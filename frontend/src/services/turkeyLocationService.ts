/**
 * Turkiye Location Service - Live API & Bundled Dataset Provider
 *
 * Integrates with the free, open-source Türkiye API (api.turkiyeapi.dev)
 * with instant fallback to bundled official 2025 data (81 provinces & 973 districts).
 */
import { TURKEY_LOCATIONS, CityData } from '../data/turkeyLocations';

const API_BASE = 'https://api.turkiyeapi.dev/v2';
const CACHE_KEY = 'tezlify_turkey_locations_cache_v2';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface CachedData {
  timestamp: number;
  locations: CityData[];
}

export class TurkeyLocationService {
  private static memoryCache: CityData[] | null = null;

  /**
   * Retrieves all 81 provinces and 973 districts.
   * Returns bundled/cached data immediately, and can refresh in background.
   */
  public static getAllLocations(): CityData[] {
    if (this.memoryCache && this.memoryCache.length > 0) {
      return this.memoryCache;
    }

    if (typeof window !== 'undefined') {
      try {
        const raw = localStorage.getItem(CACHE_KEY);
        if (raw) {
          const parsed: CachedData = jsonParseSafe(raw);
          if (parsed && Date.now() - parsed.timestamp < CACHE_TTL_MS && Array.isArray(parsed.locations)) {
            this.memoryCache = parsed.locations;
            return parsed.locations;
          }
        }
      } catch (err) {
        console.warn('[TurkeyLocationService] Failed reading cached locations:', err);
      }
    }

    this.memoryCache = TURKEY_LOCATIONS;
    return TURKEY_LOCATIONS;
  }

  /**
   * Fetches latest 2025 datasets from live open API in background and updates cache.
   */
  public static async syncLiveLocations(): Promise<CityData[]> {
    try {
      const [provRes, distRes] = await Promise.all([
        fetch(`${API_BASE}/datasets/2025/provinces.json`, { method: 'GET' }),
        fetch(`${API_BASE}/datasets/2025/districts.json`, { method: 'GET' }),
      ]);

      if (!provRes.ok || !distRes.ok) {
        throw new Error(`Live API returned status ${provRes.status} / ${distRes.status}`);
      }

      const provinces = await provRes.json();
      const districts = await distRes.json();

      const distMap: Record<number, string[]> = {};
      for (const p of provinces) {
        distMap[p.id] = [];
      }
      for (const d of districts) {
        if (distMap[d.provinceId]) {
          distMap[d.provinceId].push(d.name);
        }
      }

      const freshLocations: CityData[] = provinces.map((p: any) => ({
        name: p.name,
        districts: (distMap[p.id] || []).sort((a: string, b: string) => a.localeCompare(b, 'tr')),
      }));

      if (freshLocations.length === 81) {
        this.memoryCache = freshLocations;
        if (typeof window !== 'undefined') {
          const cachePayload: CachedData = {
            timestamp: Date.now(),
            locations: freshLocations,
          };
          localStorage.setItem(CACHE_KEY, JSON.stringify(cachePayload));
        }
        return freshLocations;
      }
    } catch (e) {
      console.warn('[TurkeyLocationService] Live sync failed, keeping bundled fallback:', e);
    }

    return TURKEY_LOCATIONS;
  }

  /**
   * Returns districts for a given city name.
   */
  public static getDistricts(cityName: string): string[] {
    const locations = this.getAllLocations();
    const city = locations.find(
      (c) => c.name.toLocaleLowerCase('tr-TR') === cityName.trim().toLocaleLowerCase('tr-TR')
    );
    return city ? city.districts : [];
  }

  /**
   * Returns all 81 city names.
   */
  public static getCityNames(): string[] {
    return this.getAllLocations().map((c) => c.name);
  }
}

function jsonParseSafe(str: string): any {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}
