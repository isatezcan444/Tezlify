/**
 * Phase 3: Frontend QR Connection Flow Automated Verification Suite
 * 
 * Verifies 12 scenarios:
 * 1. BAILEYS_QR connect action (presence and action handler in WhatsAppHubPage)
 * 2. Modal initial state (INITIALIZING with loader and text)
 * 3. QR_READY renders QR image with 3-step instructions & countdown
 * 4. QR refresh preserves session identity
 * 5. CONNECTED event updates state
 * 6. phone_number_e164 displayed
 * 7. DISCONNECTED state
 * 8. LOGGED_OUT state
 * 9. ERROR state
 * 10. TR i18n completeness
 * 11. EN i18n completeness
 * 12. META_CLOUD existing card behavior unchanged
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT_DIR = path.resolve(__dirname, '../..');
const FRONTEND_DIR = path.join(ROOT_DIR, 'frontend');

function runPhase3Tests() {
    console.log('--- Starting Phase 3 Frontend QR Connection Flow Verification Tests ---');

    // =========================================================================
    // Test 1: BAILEYS_QR connect action in WhatsAppHubPage
    // =========================================================================
    console.log('Running Test 1: BAILEYS_QR connect action in WhatsAppHubPage...');
    const hubPagePath = path.join(FRONTEND_DIR, 'src/pages/WhatsAppHubPage.tsx');
    assert(fs.existsSync(hubPagePath), 'WhatsAppHubPage.tsx must exist');
    const hubContent = fs.readFileSync(hubPagePath, 'utf8');

    assert(hubContent.includes('WhatsAppQrConnectModal'), 'WhatsAppHubPage must import WhatsAppQrConnectModal');
    assert(hubContent.includes('isQrConnectModalOpen'), 'WhatsAppHubPage must manage isQrConnectModalOpen state');
    assert(hubContent.includes('connectWithQr'), 'WhatsAppHubPage must provide connectWithQr action button');
    assert(hubContent.includes('<WhatsAppQrConnectModal'), 'WhatsAppHubPage must render WhatsAppQrConnectModal');

    // =========================================================================
    // Test 2: Modal initial state (INITIALIZING)
    // =========================================================================
    console.log('Running Test 2: Modal initial state (INITIALIZING)...');
    const modalPath = path.join(FRONTEND_DIR, 'src/components/domain/WhatsAppQrConnectModal.tsx');
    assert(fs.existsSync(modalPath), 'WhatsAppQrConnectModal.tsx must exist');
    const modalContent = fs.readFileSync(modalPath, 'utf8');

    assert(modalContent.includes("'INITIALIZING'"), 'Modal must support INITIALIZING state');
    assert(modalContent.includes("modalState === 'INITIALIZING'"), 'Modal must render INITIALIZING state UI');
    assert(modalContent.includes("qrPreparing"), 'Modal must display qrPreparing message during INITIALIZING');

    // =========================================================================
    // Test 3: QR_READY renders QR image with 3-step instructions & countdown
    // =========================================================================
    console.log('Running Test 3: QR_READY renders QR image with 3-step instructions & countdown...');
    assert(modalContent.includes("'QR_READY'"), 'Modal must support QR_READY state');
    assert(modalContent.includes("modalState === 'QR_READY'"), 'Modal must render QR_READY state UI');
    assert(modalContent.includes("qrModalStep1"), 'Modal must display Step 1 instruction');
    assert(modalContent.includes("qrModalStep2"), 'Modal must display Step 2 instruction');
    assert(modalContent.includes("qrModalStep3"), 'Modal must display Step 3 instruction');
    assert(modalContent.includes("secondsLeft"), 'Modal must have a live countdown timer');
    assert(modalContent.includes("qrExpired"), 'Modal must show expired overlay when timer expires');

    // =========================================================================
    // Test 4: QR refresh preserves session identity
    // =========================================================================
    console.log('Running Test 4: QR refresh preserves session identity...');
    assert(modalContent.includes("refreshSessionQr"), 'Modal must call refreshSessionQr API');
    assert(modalContent.includes("handleRefreshQr"), 'Modal must define handleRefreshQr handler');
    // Ensure it doesn't create new session on refresh
    assert(!modalContent.match(/handleRefreshQr[\s\S]*?createWhatsAppSession/), 'handleRefreshQr must NOT call createWhatsAppSession');

    // =========================================================================
    // Test 5: CONNECTED event updates state
    // =========================================================================
    console.log('Running Test 5: CONNECTED event updates state...');
    assert(modalContent.includes("'CONNECTED'"), 'Modal must support CONNECTED state');
    assert(modalContent.includes("detail.event === 'session_connected'"), 'Modal must listen for session_connected event');
    assert(modalContent.includes("setModalState('CONNECTED')"), 'Modal must transition to CONNECTED state');

    // =========================================================================
    // Test 6: phone_number_e164 displayed
    // =========================================================================
    console.log('Running Test 6: phone_number_e164 displayed...');
    assert(modalContent.includes("connectedPhone"), 'Modal must store and display discovered phone number');
    assert(modalContent.includes("setConnectedPhone"), 'Modal must update connected phone number on connect');

    // =========================================================================
    // Test 7: DISCONNECTED state
    // =========================================================================
    console.log('Running Test 7: DISCONNECTED state...');
    assert(modalContent.includes("'DISCONNECTED'"), 'Modal must support DISCONNECTED state');
    assert(modalContent.includes("detail.event === 'session_disconnected'"), 'Modal must listen for session_disconnected event');
    assert(modalContent.includes("disconnectedNotice"), 'Modal must show disconnectedNotice message');

    // =========================================================================
    // Test 8: LOGGED_OUT state
    // =========================================================================
    console.log('Running Test 8: LOGGED_OUT state...');
    assert(modalContent.includes("'LOGGED_OUT'"), 'Modal must support LOGGED_OUT state');
    assert(modalContent.includes("detail.event === 'session_logged_out'"), 'Modal must listen for session_logged_out event');
    assert(modalContent.includes("loggedOutNotice"), 'Modal must show loggedOutNotice message');

    // =========================================================================
    // Test 9: ERROR state
    // =========================================================================
    console.log('Running Test 9: ERROR state...');
    assert(modalContent.includes("'ERROR'"), 'Modal must support ERROR state');
    assert(modalContent.includes("errorMessage"), 'Modal must store and show safe error message');
    assert(modalContent.includes("retryConnection"), 'Modal must provide retry action');

    // =========================================================================
    // Test 10: TR i18n completeness
    // =========================================================================
    console.log('Running Test 10: TR i18n completeness...');
    const trPath = path.join(FRONTEND_DIR, 'src/locales/tr.ts');
    assert(fs.existsSync(trPath), 'tr.ts must exist');
    const trContent = fs.readFileSync(trPath, 'utf8');

    const requiredKeys = [
        'connectWithQr',
        'qrPreparing',
        'connectingState',
        'connectedState',
        'disconnectedNotice',
        'loggedOutNotice',
        'connectionError',
        'providerBaileysQr',
        'providerMetaCloud',
        'awaitingQrScan',
        'reconnectQr',
        'closeModal',
        'doneBtn',
        'refreshQr',
        'qrExpired',
        'qrModalStep1',
        'qrModalStep2',
        'qrModalStep3'
    ];

    for (const key of requiredKeys) {
        assert(trContent.includes(`${key}:`), `Turkish locale must contain key: ${key}`);
    }

    // =========================================================================
    // Test 11: EN i18n completeness
    // =========================================================================
    console.log('Running Test 11: EN i18n completeness...');
    const enPath = path.join(FRONTEND_DIR, 'src/locales/en.ts');
    assert(fs.existsSync(enPath), 'en.ts must exist');
    const enContent = fs.readFileSync(enPath, 'utf8');

    for (const key of requiredKeys) {
        assert(enContent.includes(`${key}:`), `English locale must contain key: ${key}`);
    }

    // =========================================================================
    // Test 12: META_CLOUD existing card behavior unchanged
    // =========================================================================
    console.log('Running Test 12: META_CLOUD existing card behavior unchanged...');
    const cardPath = path.join(FRONTEND_DIR, 'src/components/domain/WhatsAppNumberCard.tsx');
    assert(fs.existsSync(cardPath), 'WhatsAppNumberCard.tsx must exist');
    const cardContent = fs.readFileSync(cardPath, 'utf8');

    // Verify Meta Cloud fields are preserved for Meta numbers
    assert(cardContent.includes("isBaileys"), 'WhatsAppNumberCard must differentiate isBaileys');
    assert(cardContent.includes("number.waba_id"), 'Meta Cloud must show waba_id');
    assert(cardContent.includes("number.phone_number_id"), 'Meta Cloud must show phone_number_id');
    assert(cardContent.includes("number.verified_name"), 'Meta Cloud must show verified_name');
    assert(cardContent.includes("number.quality_rating"), 'Meta Cloud must show quality_rating');
    assert(cardContent.includes("onVerify"), 'Meta Cloud must support onVerify');

    // Verify Baileys does not render Meta fields
    const baileysBranchMatch = cardContent.match(/isBaileys \? \([\s\S]*?\/\* Meta Cloud/);
    assert(baileysBranchMatch, 'Card must have separate branch for Baileys');
    const baileysBranch = baileysBranchMatch[0];
    assert(!baileysBranch.includes("waba_id"), 'Baileys branch must not render waba_id');
    assert(!baileysBranch.includes("phone_number_id"), 'Baileys branch must not render phone_number_id');

    console.log('\n================================================================');
    console.log('✅ ALL 12 PHASE 3 FRONTEND QR FLOW VERIFICATION TESTS PASSED!');
    console.log('================================================================\n');
}

runPhase3Tests();
