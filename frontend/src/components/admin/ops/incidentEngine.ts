/**
 * Tezlify Operations Center — Incident Engine & Telemetry Aggregator
 *
 * Transforms raw, noisy log streams into actionable, deduplicated incidents
 * with root-cause heuristics, impact assessment, and safe remediation guidance.
 *
 * Invariants:
 * 1. Deterministic Fingerprinting: Same root pattern always groups together.
 * 2. Honest Root Cause: Never fabricate root cause; indicate confidence level.
 * 3. Safe Actions: Actions indicate risk level and never trigger unconfirmed restarts.
 * 4. Stale Awareness: Unavailable or stale telemetry is explicitly flagged.
 */

import { classifyLogLevel } from './logLevel';
import type {
  OpsHealthCheck,
  OpsOperation,
  OpsServiceStatus,
} from '../../../types/admin';

export type IncidentSeverity = 'critical' | 'high' | 'medium' | 'low';
export type IncidentConfidence = 'high' | 'medium' | 'low' | 'unknown';
export type IncidentRisk = 'safe' | 'caution' | 'destructive';

export interface Incident {
  id: string; // Deterministic fingerprint
  service: string;
  level: 'ERROR' | 'WARN';
  severity: IncidentSeverity;
  severityReasonKey: string;
  titleKey: string;
  titleDefault: string;
  whatHappenedKey: string;
  whatHappenedDefault: string;
  impactKey: string;
  impactDefault: string;
  possibleCauseKey: string;
  possibleCauseDefault: string;
  confidence: IncidentConfidence;
  recommendedActionKey: string;
  recommendedActionDefault: string;
  actionRiskLevel: IncidentRisk;
  firstSeen: string;
  lastSeen: string;
  count: number;
  evidence: string[]; // Up to 3 raw sample lines
  relatedActionName?: string;
  resolved?: boolean;
}

export type ExecutiveHealthState = 'healthy' | 'attention' | 'critical' | 'unavailable';

export interface ExecutiveSummary {
  healthState: ExecutiveHealthState;
  healthStateLabelKey: string;
  healthDescriptionKey: string;
  activeIncidentsCount: number;
  criticalIncidentsCount: number;
  troubledServices: string[];
  whatsappState: {
    connected: boolean;
    state: string;
    hasOrphans: boolean;
    orphanCount: number;
    hasGhosts: boolean;
    ghostCount: number;
  };
  lastOperation: {
    name: string;
    label: string;
    status: 'running' | 'succeeded' | 'failed' | 'interrupted' | 'none';
    at?: string;
  };
  recommendedActionKey: string;
  recommendedActionDefault: string;
  isStale: boolean;
  lastUpdated: string;
}

/**
 * Strip variable fragments (timestamps, UUIDs, IPs, ports, memory addresses, hex IDs)
 * to produce a stable fingerprint for log deduplication.
 */
export function normalizeLogPattern(line: string): string {
  return line
    // Strip JSON structure wrapper keys if present
    .replace(/"ts":\s*\d+(\.\d+)?/g, '')
    .replace(/"duration":\s*\d+(\.\d+)?/g, '')
    .replace(/"err_id":\s*"[^"]+"/g, '')
    .replace(/"remote_port":\s*"[^"]+"/g, '')
    // Strip ISO and standard timestamps
    .replace(/\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/g, '')
    .replace(/\[\d{2}\/[A-Za-z]{3}\/\d{4}:\d{2}:\d{2}:\d{2}(\s\+\d{4})?\]/g, '')
    // Strip UUIDs
    .replace(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g, '<UUID>')
    // Strip IP:Port patterns
    .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?\b/g, '<IP>')
    // Strip hex memory addresses
    .replace(/0x[0-9a-fA-F]+/g, '<HEX>')
    // Strip auth tokens and secrets
    .replace(/(bearer\s+)[a-zA-Z0-9_\-\.]+/gi, '$1<TOKEN>')
    .replace(/(token|secret|password|api_key|auth)=([^\s&"']+)/gi, '$1=<REDACTED>')
    // Strip trailing line numbers in code references
    .replace(/:line\s*\d+/gi, '')
    .replace(/:\d+\b/g, '')
    // Strip redundant whitespace
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract timestamp from a log line if available, or return current ISO time.
 */
function extractTimestamp(line: string): string {
  // Check JSON format: "ts": 1791727866.3991294
  const jsonTs = line.match(/"ts":\s*(\d+(\.\d+)?)/);
  if (jsonTs) {
    const epochSec = parseFloat(jsonTs[1]);
    if (!isNaN(epochSec) && epochSec > 1000000000) {
      return new Date(epochSec * 1000).toISOString();
    }
  }

  // Check ISO format: 2026-10-11T22:58:10
  const isoMatch = line.match(/\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}/);
  if (isoMatch) {
    return new Date(isoMatch[0]).toISOString();
  }

  return new Date().toISOString();
}

interface PatternMatcher {
  predicate: (line: string) => boolean;
  severity: IncidentSeverity;
  severityReasonKey: string;
  titleKey: string;
  titleDefault: string;
  whatHappenedKey: string;
  whatHappenedDefault: string;
  impactKey: string;
  impactDefault: string;
  possibleCauseKey: string;
  possibleCauseDefault: string;
  confidence: IncidentConfidence;
  recommendedActionKey: string;
  recommendedActionDefault: string;
  actionRiskLevel: IncidentRisk;
  relatedActionName?: string;
}

const KNOWN_PATTERNS: PatternMatcher[] = [
  // 1. Caddy / Docker DNS lookup failure
  {
    predicate: (line) =>
      /lookup\s+backend\s+on\s+.*:\s*server\s+misbehaving/i.test(line) ||
      /reverseproxy\.statusError.*502/i.test(line) ||
      /dial tcp.*lookup backend/i.test(line),
    severity: 'critical',
    severityReasonKey: 'admin.incidents.caddyDnsSeverity',
    titleKey: 'admin.incidents.caddyDnsTitle',
    titleDefault: 'Caddy ters vekil dahili backend adresini çözemedi (502 Bad Gateway)',
    whatHappenedKey: 'admin.incidents.caddyDnsWhat',
    whatHappenedDefault: 'Caddy, backend servisine erişmeye çalışırken Docker DNS daemon (127.0.0.11) üzerinden adres çözümleme hatası aldı.',
    impactKey: 'admin.incidents.caddyDnsImpact',
    impactDefault: 'API uç noktaları ve WebSocket bağlantıları istemcilere 502 Bad Gateway yanıtı verir; kullanıcılar panele erişemez.',
    possibleCauseKey: 'admin.incidents.caddyDnsCause',
    possibleCauseDefault: 'Backend konteyneri yeniden başlatılıyor olabilir ya da Docker dahili DNS sunucusu aşırı yük altında.',
    confidence: 'high',
    recommendedActionKey: 'admin.incidents.caddyDnsAction',
    recommendedActionDefault: 'Backend konteynerinin çalıştığını ve Docker ağının sağlıklı olduğunu kontrol edin. Gerekirse Caddy yapılandırmasını yeniden yükleyin.',
    actionRiskLevel: 'caution',
    relatedActionName: 'reload_caddy',
  },
  // 2. WhatsApp Gateway Connection Loss / Disconnection
  {
    predicate: (line) =>
      /dial tcp.*gateway/i.test(line) ||
      /gateway connection (failed|lost|timeout)/i.test(line) ||
      /ECONNREFUSED.*3001/i.test(line) ||
      /Boom: Connection Failure/i.test(line) ||
      /WebSocket (closed|disconnected|error)/i.test(line),
    severity: 'high',
    severityReasonKey: 'admin.incidents.waGatewayConnSeverity',
    titleKey: 'admin.incidents.waGatewayConnTitle',
    titleDefault: 'WhatsApp Gateway bağlantısı kesildi veya yanıt vermiyor',
    whatHappenedKey: 'admin.incidents.waGatewayConnWhat',
    whatHappenedDefault: 'Backend veya istemci, WhatsApp Baileys gateway servisine soket bağlantısı kuramadı.',
    impactKey: 'admin.incidents.waGatewayConnImpact',
    impactDefault: 'WhatsApp mesaj gönderimi, gelen mesajların yakalanması ve QR eşleştirme duraksayabilir.',
    possibleCauseKey: 'admin.incidents.waGatewayConnCause',
    possibleCauseDefault: 'WhatsApp gateway süreci beklenmedik şekilde sonlanmış veya yeniden bağlanma döngüsüne girmiş olabilir.',
    confidence: 'high',
    recommendedActionKey: 'admin.incidents.waGatewayConnAction',
    recommendedActionDefault: 'Gateway loglarını inceleyin. Bağlantı geri gelmezse gateway servisini kontrollü biçimde yeniden başlatın.',
    actionRiskLevel: 'caution',
    relatedActionName: 'restart_gateway',
  },
  // 3. PostgreSQL Database Connection Pool Exhaustion or Timeout
  {
    predicate: (line) =>
      /asyncpg\.exceptions/i.test(line) ||
      /connection pool timeout/i.test(line) ||
      /too many connections/i.test(line) ||
      /deadlock detected/i.test(line) ||
      /database is locked/i.test(line),
    severity: 'critical',
    severityReasonKey: 'admin.incidents.dbPoolSeverity',
    titleKey: 'admin.incidents.dbPoolTitle',
    titleDefault: 'Veritabanı bağlantı havuzu tükendi veya zaman aşımına uğradı',
    whatHappenedKey: 'admin.incidents.dbPoolWhat',
    whatHappenedDefault: 'Uygulama PostgreSQL veritabanına bağlanırken havuz limitine ulaştı veya sorgu zaman aşımı meydana geldi.',
    impactKey: 'admin.incidents.dbPoolImpact',
    impactDefault: 'Kullanıcı girişleri, lead kayıtları ve kampanya yürütme işlemleri veritabanı hatası verebilir.',
    possibleCauseKey: 'admin.incidents.dbPoolCause',
    possibleCauseDefault: 'Uzun süren kilitli sorgular veya sızıntı yapan açık veritabanı oturumları havuzu tüketmiş olabilir.',
    confidence: 'high',
    recommendedActionKey: 'admin.incidents.dbPoolAction',
    recommendedActionDefault: 'Veritabanı havuz kullanımını inceleyin. PostgreSQL kesinlikle panelden restart edilmemeli; sorgu sızıntısı backend loglarından izlenmelidir.',
    actionRiskLevel: 'safe',
    relatedActionName: 'restart_backend',
  },
  // 4. Out of Memory (OOM)
  {
    predicate: (line) =>
      /oom[- ]killed/i.test(line) ||
      /out of memory/i.test(line) ||
      /killed process \d+/i.test(line),
    severity: 'critical',
    severityReasonKey: 'admin.incidents.oomSeverity',
    titleKey: 'admin.incidents.oomTitle',
    titleDefault: 'Konteyner bellek sınırı aşıldı (OOM Kill)',
    whatHappenedKey: 'admin.incidents.oomWhat',
    whatHappenedDefault: 'İşletim sistemi bellek yetersizliği nedeniyle süreci zorla sonlandırdı.',
    impactKey: 'admin.incidents.oomImpact',
    impactDefault: 'İlgili servis aniden durur, aktif işlemler kesintiye uğrar.',
    possibleCauseKey: 'admin.incidents.oomCause',
    possibleCauseDefault: 'Büyük veri yüklemeleri, Playwright scraper oturumları veya bellek sızıntısı sınırın aşılmasına yol açtı.',
    confidence: 'high',
    recommendedActionKey: 'admin.incidents.oomAction',
    recommendedActionDefault: 'Konteyner bellek limitlerini ve aktif scraper görevlerini kontrol edin.',
    actionRiskLevel: 'caution',
  },
  // 5. Rate limiting or 429 Too Many Requests
  {
    predicate: (line) =>
      /429 Too Many Requests/i.test(line) ||
      /rate limit exceeded/i.test(line) ||
      /antiban.*limit/i.test(line),
    severity: 'medium',
    severityReasonKey: 'admin.incidents.rateLimitSeverity',
    titleKey: 'admin.incidents.rateLimitTitle',
    titleDefault: 'Hız sınırı (Rate Limit) veya Anti-Ban koruma eşiği aşıldı',
    whatHappenedKey: 'admin.incidents.rateLimitWhat',
    whatHappenedDefault: 'Dış API veya Tezlify Anti-Ban politikası gönderim sıklığını geçici olarak kısıtladı.',
    impactKey: 'admin.incidents.rateLimitImpact',
    impactDefault: 'Mesaj gönderimleri güvenli bekleme süresine (jitter delay) alınır.',
    possibleCauseKey: 'admin.incidents.rateLimitCause',
    possibleCauseDefault: 'Anti-Ban güvenlik kuralları gereği gönderim hızlandırma durduruldu.',
    confidence: 'high',
    recommendedActionKey: 'admin.incidents.rateLimitAction',
    recommendedActionDefault: 'Politika ayarlarını kontrol edin, manuel müdahale yapmayın; sistem güvenli aralıklarla devam edecektir.',
    actionRiskLevel: 'safe',
  },
  // 6. Python Traceback / Unhandled Exception
  {
    predicate: (line) =>
      /Traceback \(most recent call last\)/i.test(line) ||
      /Internal Server Error/i.test(line) ||
      /Unhandled exception/i.test(line),
    severity: 'high',
    severityReasonKey: 'admin.incidents.unhandledExcSeverity',
    titleKey: 'admin.incidents.unhandledExcTitle',
    titleDefault: 'Beklenmeyen sunucu hatası (Unhandled Exception)',
    whatHappenedKey: 'admin.incidents.unhandledExcWhat',
    whatHappenedDefault: 'Backend kodunda yakalanmamış bir istisna veya 500 Internal Server Error oluştu.',
    impactKey: 'admin.incidents.unhandledExcImpact',
    impactDefault: 'İlgili HTTP isteğini başlatan kullanıcı hata mesajı aldı.',
    possibleCauseKey: 'admin.incidents.unhandledExcCause',
    possibleCauseDefault: 'Veri doğrulama hatası veya beklenmeyen harici servis yanıtı.',
    confidence: 'medium',
    recommendedActionKey: 'admin.incidents.unhandledExcAction',
    recommendedActionDefault: 'Ayrıntılı hata izini (stack trace) inceleyin ve ilgili servisi gözlemleyin.',
    actionRiskLevel: 'safe',
  },
];

/**
 * Group raw log lines across all services into structured, deduplicated incidents.
 */
export function groupLogsIntoIncidents(
  logsByService: Record<string, string[]>,
  serviceHealth?: OpsHealthCheck | null,
): Incident[] {
  const incidentsMap = new Map<string, Incident>();

  for (const [service, lines] of Object.entries(logsByService || {})) {
    if (!Array.isArray(lines)) continue;

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line || typeof line !== 'string' || !line.trim()) continue;
      const level = classifyLogLevel(line);
      if (level !== 'ERROR' && level !== 'WARN') continue;

      const norm = normalizeLogPattern(line);
      const matched = KNOWN_PATTERNS.find((p) => p.predicate(line));

      // Fingerprint combines service with matched title or normalized pattern
      const fpKey = matched
        ? `${service}:${matched.titleKey}`
        : `${service}:${norm.slice(0, 80)}`;

      const ts = extractTimestamp(line);
      const existing = incidentsMap.get(fpKey);

      if (existing) {
        existing.count += 1;
        existing.lastSeen = ts > existing.lastSeen ? ts : existing.lastSeen;
        if (existing.evidence.length < 3 && !existing.evidence.includes(line)) {
          existing.evidence.push(line);
        }
      } else {
        const severity: IncidentSeverity = matched
          ? matched.severity
          : level === 'ERROR'
          ? 'high'
          : 'medium';

        incidentsMap.set(fpKey, {
          id: fpKey,
          service,
          level,
          severity,
          severityReasonKey: matched?.severityReasonKey || 'admin.incidents.defaultSeverityReason',
          titleKey: matched?.titleKey || 'admin.incidents.genericTitle',
          titleDefault: matched?.titleDefault || `[${service.toUpperCase()}] ${level}: ${norm.slice(0, 80)}...`,
          whatHappenedKey: matched?.whatHappenedKey || 'admin.incidents.genericWhat',
          whatHappenedDefault: matched?.whatHappenedDefault || `${service} servisinde bir hata kaydı tespit edildi.`,
          impactKey: matched?.impactKey || 'admin.incidents.genericImpact',
          impactDefault: matched?.impactDefault || 'Hatanın türüne bağlı olarak bazı istekler başarısız olmuş olabilir.',
          possibleCauseKey: matched?.possibleCauseKey || 'admin.incidents.genericCause',
          possibleCauseDefault: matched?.possibleCauseDefault || 'Ayrıntılı kök neden tespiti için ham log kayıtlarını inceleyin.',
          confidence: matched?.confidence || 'unknown',
          recommendedActionKey: matched?.recommendedActionKey || 'admin.incidents.genericAction',
          recommendedActionDefault: matched?.recommendedActionDefault || 'Servis durumunu ve log ayrıntılarını kontrol edin.',
          actionRiskLevel: matched?.actionRiskLevel || 'safe',
          firstSeen: ts,
          lastSeen: ts,
          count: 1,
          evidence: [line],
          relatedActionName: matched?.relatedActionName,
          resolved: false,
        });
      }
    }
  }

  // Sort incidents by severity weight, then newest lastSeen
  const severityWeight: Record<IncidentSeverity, number> = {
    critical: 4,
    high: 3,
    medium: 2,
    low: 1,
  };

  return Array.from(incidentsMap.values()).sort((a, b) => {
    const diff = severityWeight[b.severity] - severityWeight[a.severity];
    if (diff !== 0) return diff;
    return b.lastSeen.localeCompare(a.lastSeen);
  });
}

/**
 * Compute an executive-level status evaluation that answers the 6 core questions.
 */
export function computeExecutiveSummary(params: {
  services: OpsServiceStatus[];
  health: OpsHealthCheck | null;
  operations: OpsOperation[];
  incidents: Incident[];
  orphanedCount?: number;
  ghostConnected?: string[];
  lastUpdated?: string;
  hasTelemetryError?: boolean;
}): ExecutiveSummary {
  const {
    services,
    health,
    operations,
    incidents,
    orphanedCount = 0,
    ghostConnected = [],
    lastUpdated = '',
    hasTelemetryError = false,
  } = params;

  // Question 1: Is system healthy?
  let healthState: ExecutiveHealthState = 'healthy';
  let healthStateLabelKey = 'admin.executive.stateHealthy';
  let healthDescriptionKey = 'admin.executive.descHealthy';

  const runningServices = services.filter((s) => s.status === 'running');
  const downServices = services.filter((s) => s.status !== 'running' && s.status !== 'absent');
  const unhealthyServices = services.filter((s) => s.health === 'unhealthy');
  const troubledServices = Array.from(
    new Set([
      ...downServices.map((s) => s.name.replace('tezlify-', '')),
      ...unhealthyServices.map((s) => s.name.replace('tezlify-', '')),
    ]),
  );

  const criticalIncidents = incidents.filter((i) => i.severity === 'critical');
  const highIncidents = incidents.filter((i) => i.severity === 'high');

  const wa = health?.whatsapp;
  const waConnected = Boolean(wa?.connected);
  const waState = wa?.state ? String(wa.state) : 'unknown';

  if (hasTelemetryError || services.length === 0) {
    healthState = 'unavailable';
    healthStateLabelKey = 'admin.executive.stateUnavailable';
    healthDescriptionKey = 'admin.executive.descUnavailable';
  } else if (downServices.length > 0 || criticalIncidents.length > 0) {
    healthState = 'critical';
    healthStateLabelKey = 'admin.executive.stateCritical';
    healthDescriptionKey = 'admin.executive.descCritical';
  } else if (
    unhealthyServices.length > 0 ||
    highIncidents.length > 0 ||
    orphanedCount > 0 ||
    ghostConnected.length > 0 ||
    !waConnected
  ) {
    healthState = 'attention';
    healthStateLabelKey = 'admin.executive.stateAttention';
    healthDescriptionKey = 'admin.executive.descAttention';
  }

  // Question 5: Last deployment / operation status
  const lastOp = operations[0];
  const lastOperationInfo = {
    name: lastOp?.name || 'none',
    label: lastOp?.label || '-',
    status: (lastOp?.status as any) || 'none',
    at: lastOp?.started_at || undefined,
  };

  // Question 6: What should executive/operator do now?
  let recommendedActionKey = 'admin.executive.actionNone';
  let recommendedActionDefault = 'Tüm servisler normal çalışıyor. Müdahaleye gerek yoktur.';

  if (healthState === 'unavailable') {
    recommendedActionKey = 'admin.executive.actionUnavailable';
    recommendedActionDefault = 'Sunucu telemetrisi alınamadı. Ağ bağlantınızı ve sunucu erişimini kontrol edin.';
  } else if (downServices.length > 0) {
    recommendedActionKey = 'admin.executive.actionDownServices';
    recommendedActionDefault = `Çalışmayan servisler tespit edildi: ${troubledServices.join(', ')}. Servis durumunu kontrol edin.`;
  } else if (orphanedCount > 0) {
    recommendedActionKey = 'admin.executive.actionOrphans';
    recommendedActionDefault = `${orphanedCount} adet yetim (orphaned) WhatsApp oturumu var. WhatsApp Yönetiminden hattı yeniden bağlayın.`;
  } else if (ghostConnected.length > 0) {
    recommendedActionKey = 'admin.executive.actionGhosts';
    recommendedActionDefault = 'Veritabanında bağlı görünen ancak gatewayde aktif olmayan hat tespit edildi. Oturumu senkronize edin.';
  } else if (criticalIncidents.length > 0) {
    recommendedActionKey = 'admin.executive.actionCritical';
    recommendedActionDefault = 'Kritik sistem olayları mevcut. Olaylar sekmesindeki ayrıntıları inceleyin.';
  } else if (highIncidents.length > 0) {
    recommendedActionKey = 'admin.executive.actionHigh';
    recommendedActionDefault = 'Yüksek öncelikli uyarılar var. Hata loglarını ve servis durumunu gözlemleyin.';
  }

  return {
    healthState,
    healthStateLabelKey,
    healthDescriptionKey,
    activeIncidentsCount: incidents.length,
    criticalIncidentsCount: criticalIncidents.length,
    troubledServices,
    whatsappState: {
      connected: waConnected,
      state: waState,
      hasOrphans: orphanedCount > 0,
      orphanCount: orphanedCount,
      hasGhosts: ghostConnected.length > 0,
      ghostCount: ghostConnected.length,
    },
    lastOperation: lastOperationInfo,
    recommendedActionKey,
    recommendedActionDefault,
    isStale: hasTelemetryError,
    lastUpdated: lastUpdated || new Date().toLocaleTimeString(),
  };
}
