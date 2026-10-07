// Runs only in the trusted main process; renderer identity and URLs are never accepted.
async function openEmployeeDashboard({ getToken, requestApi, webBase, openExternal, allowed }) {
    const token = getToken();
    if (!token) return { ok: false, error: 'Sign in to the desktop app before opening the dashboard.' };
    try {
        const response = await requestApi(token, { method: 'POST', path: '/auth/dashboard-handoff', body: '{}' });
        if (response.status === 401) return { ok: false, error: 'Your desktop session expired. Sign in again.' };
        if (response.status !== 201) return { ok: false, error: 'Unable to open your Employee dashboard. Please try again.' };
        const grant = JSON.parse(response.body);
        if (!/^[a-f0-9]{64}$/.test(grant.code || '') || !Number.isFinite(Date.parse(grant.expiresAt))
            || Date.parse(grant.expiresAt) <= Date.now() || token !== getToken()) {
            return { ok: false, error: 'Dashboard link expired or your account changed. Please try again.' };
        }
        const destination = new URL('/desktop/dashboard', webBase);
        if (!allowed(destination.toString())) return { ok: false, error: 'Dashboard service address is unavailable.' };
        destination.hash = new URLSearchParams({ handoff: grant.code }).toString();
        await openExternal(destination.toString());
        return { ok: true };
    } catch {
        return { ok: false, error: 'Unable to open the dashboard. Check your connection and try again.' };
    }
}
module.exports = { openEmployeeDashboard };
