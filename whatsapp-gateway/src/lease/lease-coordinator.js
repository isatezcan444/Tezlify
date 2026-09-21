/**
 * WhatsApp Distributed Session Lease Coordinator.
 *
 * Coordinates distributed lease locking (PostgreSQL) across gateway instances,
 * lease renewal heartbeats, contention backoff, and release upon shutdown or disconnect.
 */
import { diagnostic, sessionRef } from '../observability.js';

export function clearLeaseTimers(session) {
  if (session._leaseRenewTimer) clearInterval(session._leaseRenewTimer);
  if (session._leaseRetryTimer) clearTimeout(session._leaseRetryTimer);
  session._leaseRenewTimer = null;
  session._leaseRetryTimer = null;
  session._leaseRenewing = false;
}

export async function releaseLease(session, leaseRepository, instanceId) {
  clearLeaseTimers(session);
  session._leaseValidUntil = 0;
  if (leaseRepository) {
    try {
      await leaseRepository.release(session.id, instanceId);
    } catch {
      // Ignore cleanup error on release
    }
  }
}

export function createLeaseCoordinator({
  leaseRepository,
  instanceId,
  logger,
}) {
  async function acquireLease(session, generation, onContended) {
    if (!leaseRepository || session.ephemeral) return true;
    const acquired = await leaseRepository.acquire(session.id, instanceId, generation);
    if (!acquired) {
      session.status = 'RESTORING';
      session.is_phone_online = false;
      session.error_message = 'WHATSAPP_SESSION_OWNED_BY_ANOTHER_INSTANCE';
      diagnostic('socket_lease_contended', {
        session_ref: sessionRef(session.id),
        generation,
      });
      session._leaseRetryTimer = setTimeout(() => {
        session._leaseRetryTimer = null;
        if (!session._deleted && !session._shuttingDown && typeof onContended === 'function') {
          onContended();
        }
      }, 5000 + Math.floor(Math.random() * 1000));
      return false;
    }
    diagnostic('socket_lease_acquired', {
      session_ref: sessionRef(session.id),
      generation,
    });
    session._leaseValidUntil = Date.now() + leaseRepository.ttlSeconds * 1000;
    return true;
  }

  function armLeaseRenewal(session, generation, sock, onLost) {
    if (!leaseRepository || session._leaseRenewTimer) return;
    const renewalMs = Math.max(10_000, Math.floor((leaseRepository.ttlSeconds * 1000) / 3));
    session._leaseRenewTimer = setInterval(async () => {
      if (session._leaseRenewing || !session.lifecycle.isCurrent(generation, sock)) return;
      session._leaseRenewing = true;
      try {
        const renewed = await leaseRepository.renew(session.id, instanceId, generation);
        if (renewed) {
          session._leaseValidUntil = Date.now() + leaseRepository.ttlSeconds * 1000;
        } else {
          onLost();
        }
      } catch (error) {
        diagnostic('socket_lease_renew_failed', {
          session_ref: sessionRef(session.id),
          generation,
          error_name: error?.name || 'Error',
          error_code: error?.code || null,
        });
        if (Date.now() >= session._leaseValidUntil) onLost();
      } finally {
        session._leaseRenewing = false;
      }
    }, renewalMs);
  }

  return {
    acquireLease,
    armLeaseRenewal,
    clearLeaseTimers: (session) => clearLeaseTimers(session),
    releaseLease: (session) => releaseLease(session, leaseRepository, instanceId),
  };
}
