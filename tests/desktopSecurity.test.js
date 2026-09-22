import assert from 'node:assert/strict';
import { URL } from 'node:url';

console.log('--- Starting Desktop Security Verification Tests ---');

// Test 1: URL Allowlist Logic Verification
function createUrlValidator(WEB_BASE, isDev) {
    return function isAllowedExternalUrl(candidateUrl) {
        if (typeof candidateUrl !== 'string' || !candidateUrl.trim()) return false;
        try {
            const parsed = new URL(candidateUrl.trim());
            // Enforce strict HTTP/HTTPS protocol
            if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
                return false;
            }

            // Extract trusted hostnames
            const webBaseUrl = new URL(WEB_BASE);
            const allowedHostnames = new Set([
                webBaseUrl.hostname.toLowerCase(),
                'hrms.yoforex.net',
                'emptrakr.com',
                'www.emptrakr.com',
            ]);

            if (isDev) {
                allowedHostnames.add('localhost');
                allowedHostnames.add('127.0.0.1');
            }

            const candidateHostname = parsed.hostname.toLowerCase();
            if (!allowedHostnames.has(candidateHostname)) {
                return false;
            }

            // Reject non-standard ports in production
            if (!isDev && parsed.port && parsed.port !== '443' && parsed.port !== '80') {
                return false;
            }

            return true;
        } catch (err) {
            return false;
        }
    };
}

const prodValidator = createUrlValidator('https://hrms.yoforex.net', false);
const devValidator = createUrlValidator('http://localhost:3000', true);

// 1. Approved production URLs
assert.equal(prodValidator('https://emptrakr.com/login'), true, 'emptrakr.com should be allowed');
assert.equal(prodValidator('https://www.emptrakr.com/dashboard'), true, 'www.emptrakr.com should be allowed');
assert.equal(prodValidator('https://hrms.yoforex.net/login?desktopCode=123'), true, 'hrms.yoforex.net should be allowed');
console.log('✓ Approved production URLs (emptrakr.com, www.emptrakr.com, hrms.yoforex.net) allowed');

// 2. Unapproved domains rejected
assert.equal(prodValidator('https://evil-example.com/steal-token'), false, 'evil-example.com must be rejected');
assert.equal(prodValidator('https://phishing-emptrakr.com'), false, 'phishing domain must be rejected');
assert.equal(prodValidator('https://google.com'), false, 'external unapproved domain must be rejected');
console.log('✓ Unapproved external domains rejected');

// 3. Dangerous protocols rejected
assert.equal(prodValidator('javascript:alert(1)'), false, 'javascript: must be rejected');
assert.equal(prodValidator('file:///etc/passwd'), false, 'file: must be rejected');
assert.equal(prodValidator('data:text/html,<script>alert(1)</script>'), false, 'data: must be rejected');
console.log('✓ Dangerous URI protocols (javascript, file, data) rejected');

// 4. Non-standard ports in production rejected
assert.equal(prodValidator('https://emptrakr.com:8443/login'), false, 'non-standard port 8443 must be rejected in prod');
assert.equal(prodValidator('https://emptrakr.com:22/ssh'), false, 'port 22 must be rejected');
console.log('✓ Non-standard ports rejected in production');

// 5. Dev validator allows localhost
assert.equal(devValidator('http://localhost:3000/login'), true, 'localhost allowed in dev');
assert.equal(devValidator('http://127.0.0.1:3000/login'), true, '127.0.0.1 allowed in dev');
assert.equal(prodValidator('http://localhost:3000/login'), false, 'localhost rejected in prod');
console.log('✓ Localhost allowed in development, rejected in production');

// Test 2: Shortcut Interception Logic Verification
function isBlockedProductionShortcut(input) {
    const isCtrlOrCmd = Boolean(input.control || input.meta);
    const key = String(input.key || '').toLowerCase();

    if (key === 'f12') return true;
    if (isCtrlOrCmd && (input.shift || input.alt) && (key === 'i' || key === 'j' || key === 'c')) return true;
    if (isCtrlOrCmd && key === 'u') return true;
    return false;
}

// Check all blocked shortcuts
assert.equal(isBlockedProductionShortcut({ key: 'F12' }), true, 'F12 blocked');
assert.equal(isBlockedProductionShortcut({ control: true, shift: true, key: 'I' }), true, 'Ctrl+Shift+I blocked');
assert.equal(isBlockedProductionShortcut({ meta: true, alt: true, key: 'I' }), true, 'Cmd+Option+I blocked');
assert.equal(isBlockedProductionShortcut({ control: true, shift: true, key: 'J' }), true, 'Ctrl+Shift+J blocked');
assert.equal(isBlockedProductionShortcut({ control: true, shift: true, key: 'C' }), true, 'Ctrl+Shift+C blocked');
assert.equal(isBlockedProductionShortcut({ control: true, key: 'U' }), true, 'Ctrl+U blocked');
assert.equal(isBlockedProductionShortcut({ meta: true, key: 'u' }), true, 'Cmd+U blocked');

// Normal inputs not blocked
assert.equal(isBlockedProductionShortcut({ key: 'a' }), false, 'normal typing allowed');
assert.equal(isBlockedProductionShortcut({ control: true, key: 'c' }), false, 'Ctrl+C copy allowed');
assert.equal(isBlockedProductionShortcut({ control: true, key: 'v' }), false, 'Ctrl+V paste allowed');
// Test 3: Idle Threshold Bounds Validation Verification
function validateIdleThreshold(seconds) {
    return typeof seconds === 'number' && !Number.isNaN(seconds) && seconds >= 60 && seconds <= 3600;
}

function validateWfhScreenIdleThreshold(seconds) {
    return typeof seconds === 'number' && !Number.isNaN(seconds) && seconds >= 30 && seconds <= 3600;
}

// Valid hardware idle thresholds
assert.equal(validateIdleThreshold(60), true, '60s hardware idle should be valid');
assert.equal(validateIdleThreshold(300), true, '300s hardware idle should be valid');
assert.equal(validateIdleThreshold(3600), true, '3600s (1h) hardware idle should be valid');

// Out-of-bounds evasion attempts
assert.equal(validateIdleThreshold(10), false, '10s hardware idle should be rejected (<60)');
assert.equal(validateIdleThreshold(86400), false, '86400s (24h) evasion attempt must be rejected');
assert.equal(validateIdleThreshold(1000000), false, '1M seconds evasion attempt must be rejected');
assert.equal(validateIdleThreshold(-10), false, 'negative seconds must be rejected');
assert.equal(validateIdleThreshold('60'), false, 'string representation must be rejected');

// Valid and invalid WFH screen idle thresholds
assert.equal(validateWfhScreenIdleThreshold(30), true, '30s screen idle should be valid');
assert.equal(validateWfhScreenIdleThreshold(240), true, '240s screen idle should be valid');
assert.equal(validateWfhScreenIdleThreshold(3600), true, '3600s screen idle should be valid');
assert.equal(validateWfhScreenIdleThreshold(15), false, '15s screen idle should be rejected (<30)');
assert.equal(validateWfhScreenIdleThreshold(86400), false, '86400s screen idle evasion attempt must be rejected');
console.log('✓ Idle threshold evasion attempts (>3600s, <60s, types) strictly rejected');

console.log('--- ALL DESKTOP SECURITY TESTS PASSED! ---');

