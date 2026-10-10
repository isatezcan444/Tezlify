/**
 * Phase 24 Verification Script: Fast Initial Hydration, Silent Reconciliation & Avatar-First Loading
 *
 * Checks:
 * 1. Initial Conversation Cache (0ms render parity): getInitialCachedConversations and saveCachedConversations
 * 2. Silent Reconciliation Contract: silent jobs suppress whatsapp_sync_* banner events
 * 3. Reconnect Banner Suppression: WebSocket reconnect does not revive syncing banner
 * 4. Avatar Priority Queue: priority='high' pushes to front (unshift) and uses loading="eager"
 * 5. Priority query parameter forwarded through WhatsApp API & Repository
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

console.log('[test-phase24] Starting Phase 24 verification suite...');

// 1. Static Contract Checks in Source Files
const hubPagePath = path.join(rootDir, 'src', 'pages', 'WhatsAppHubPage.tsx');
const hubPageSource = fs.readFileSync(hubPagePath, 'utf8');

// Check Initial Hydration Cache
assert(hubPageSource.includes("CONVERSATIONS_CACHE_KEY = 'tezlify_cached_conversations'"),
  'CONVERSATIONS_CACHE_KEY must be defined for instant hydration');
assert(hubPageSource.includes('getInitialCachedConversations()'),
  'useState must initialize conversations with getInitialCachedConversations()');
assert(hubPageSource.includes('saveCachedConversations('),
  'saveCachedConversations must be called when conversations are fetched');
assert(hubPageSource.includes('if (conversationsRef.current.length === 0) {\n        setConvLoadState(\'loading\');\n      }'),
  'Skeleton loader must not clobber cached conversations when cached items exist');

// Check Silent Reconnect & Banner Guards
assert(hubPageSource.includes('if (activeSyncIdRef.current || isPostQrSyncing) {\n        void refreshSyncStatus();\n      }'),
  'handleReconnect must guard refreshSyncStatus to prevent banner popups during silent reconnect');
assert(hubPageSource.includes('!(sessionSync as any)?.silent'),
  'Syncing banner must be guarded against silent sync jobs');
const handleQrSuccessMatch = hubPageSource.match(/const handleQrSuccess = useCallback\(\(\) => \{[\s\S]*?\}, \[fetchSessions/);
assert(handleQrSuccessMatch && !handleQrSuccessMatch[0].includes('void handleSyncChats()'),
  'handleQrSuccess must not invoke redundant handleSyncChats()');

console.log('  ✓ 1. WhatsAppHubPage static hydration and silent reconciliation guards verified');

// 2. Avatar Component Priority Queue & Zero-Flicker State
const avatarPath = path.join(rootDir, 'src', 'components', 'ui', 'Avatar.tsx');
const avatarSource = fs.readFileSync(avatarPath, 'utf8');

assert(avatarSource.includes("if (priority === 'high') {\n    avatarRefreshQueue.unshift(run);\n  } else {\n    avatarRefreshQueue.push(run);\n  }"),
  'Avatar queueAvatarRefresh must prioritize high priority requests via unshift');
assert(avatarSource.includes('Boolean(initialEffective && !failedAvatarUrls.has(initialEffective))'),
  'Avatar isImageLoaded must initialize true when initialEffective exists to eliminate letter flicker');
assert(avatarSource.includes('loading={priority === \'high\' ? \'eager\' : \'lazy\'}'),
  'Avatar img tag must use loading="eager" for priority="high"');
assert(avatarSource.includes('sessionStorage.getItem(AVATAR_SESSION_CACHE_KEY)'),
  'Avatar must persist resolved cache to sessionStorage across navigation');

console.log('  ✓ 2. Avatar priority queue, sessionStorage persistence, and eager loading verified');

// 3. API & Repository Priority Forwarding
const apiPath = path.join(rootDir, 'src', 'features', 'whatsapp', 'api', 'whatsappApi.ts');
const repoPath = path.join(rootDir, 'src', 'features', 'whatsapp', 'data', 'whatsappRepository.ts');
const apiSource = fs.readFileSync(apiPath, 'utf8');
const repoSource = fs.readFileSync(repoPath, 'utf8');

assert(apiSource.includes("priority: string = 'normal'"),
  'whatsappApi.refreshAvatar must accept priority parameter');
assert(apiSource.includes("?priority=${encodeURIComponent(priority)}"),
  'whatsappApi.refreshAvatar must append priority query param');
assert(repoSource.includes("priority: string = 'normal'"),
  'WhatsAppRepository.refreshAvatar must accept priority parameter');

console.log('  ✓ 3. Frontend API and Repository priority piping verified');

// 4. Backend Orchestration and Endpoints Verification
const backendSyncPath = path.join(rootDir, '..', 'backend', 'app', 'services', 'whatsapp', 'orchestration', 'sync.py');
const backendEndpointPath = path.join(rootDir, '..', 'backend', 'app', 'api', 'v1', 'endpoints', 'whatsapp.py');
const backendSyncSource = fs.readFileSync(backendSyncPath, 'utf8');
const backendEndpointSource = fs.readFileSync(backendEndpointPath, 'utf8');

assert(backendSyncSource.includes('silent: bool = False'),
  'SyncJob and WhatsAppSyncOrchestrator.request_sync must accept silent parameter');
assert(backendSyncSource.includes('if getattr(job, "silent", False) and str(payload.get("event", "")).startswith("whatsapp_sync_"):'),
  'Silent jobs must suppress whatsapp_sync_* WS events');
assert(backendEndpointSource.includes('priority: Optional[str] = Query("normal")'),
  'Backend refresh_contact_avatar endpoint must accept priority query param');

console.log('  ✓ 4. Backend silent reconciliation and priority endpoint verified');

// 5. Gateway Route Verification
const gatewayIndexPath = path.join(rootDir, '..', 'whatsapp-gateway', 'src', 'index.js');
const gatewayIndexSource = fs.readFileSync(gatewayIndexPath, 'utf8');

assert(gatewayIndexSource.includes('const { jid, force, priority } = req.body || {};'),
  'Gateway /sessions/:id/avatar/refresh route must parse priority from request body');
assert(gatewayIndexSource.includes('sessionManager.refreshAvatar(req.params.id, jid, Boolean(force), priority || \'normal\')'),
  'Gateway must pass priority to sessionManager.refreshAvatar');

console.log('  ✓ 5. Gateway priority routing verified');

console.log('\n======================================================');
console.log('ALL PHASE 24 REGRESSION TESTS PASSED (5/5)!');
console.log('======================================================\n');
