function isTrustedSender(event, webContents, expectedDocument, development) {
    if (!webContents || event.sender !== webContents || !event.senderFrame || event.senderFrame.parent) return false;
    try {
        const actual = new URL(event.senderFrame.url);
        const expected = new URL(expectedDocument);
        return development ? actual.origin === expected.origin : actual.href.split('#')[0] === expected.href;
    } catch { return false; }
}
module.exports = { isTrustedSender };
