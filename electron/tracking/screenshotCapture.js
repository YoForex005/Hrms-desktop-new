const { desktopCapturer, screen } = require('electron');
const { execFile } = require('child_process');

const PS_CAPTURE_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Capture full multi-monitor virtual screen bounding all displays
$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen

$bitmap = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bounds.Size)

$ms = New-Object System.IO.MemoryStream
$bitmap.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
$base64 = [System.Convert]::ToBase64String($ms.ToArray())
$ms.Dispose()
$graphics.Dispose()
$bitmap.Dispose()

[PSCustomObject]@{
    base64 = $base64
    width = $bounds.Width
    height = $bounds.Height
    x = $bounds.Left
    y = $bounds.Top
} | ConvertTo-Json -Compress
`;

function executePowerShell(script) {
    return new Promise((resolve, reject) => {
        execFile(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-STA', '-Command', script],
            { timeout: 15000, windowsHide: true, maxBuffer: 1024 * 1024 * 32 },
            (err, stdout, stderr) => {
                if (err) {
                    reject(new Error(stderr && String(stderr).trim() ? String(stderr).trim() : err.message));
                    return;
                }
                resolve(String(stdout || '').trim());
            }
        );
    });
}


function boundedImage(image) {
    let bytes = image.toPNG();
    if (bytes.length > 5 * 1024 * 1024) bytes = image.toJPEG(75);
    if (!bytes.length || bytes.length > 5 * 1024 * 1024) throw new Error('Screenshot exceeds upload size limit');
    return bytes;
}
async function captureAllMonitorsPng() {
    try {
        const displays = screen.getAllDisplays();
        if (!displays.length) throw new Error('No displays available');
        const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: {
            width: Math.max(...displays.map(display => Math.round(display.bounds.width * display.scaleFactor))),
            height: Math.max(...displays.map(display => Math.round(display.bounds.height * display.scaleFactor))),
        } });
        return displays.map(display => {
            const source = sources.find(source => String(source.display_id) === String(display.id));
            if (!source || source.thumbnail.isEmpty()) throw new Error('A display could not be captured');
            const size = source.thumbnail.getSize();
            return { imageBuffer: boundedImage(source.thumbnail), display: { ...display.bounds, width: size.width, height: size.height, displayId: String(display.id) } };
        });
    } catch (error) { console.warn('[ScreenshotCapture] Native capture unavailable:', error.message); }
    if (process.platform === 'darwin') {
        const path = require('node:path'), os = require('node:os'), fs = require('node:fs/promises');
        const { nativeImage } = require('electron');
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'emptrakr-capture-'));
        try {
            await fs.chmod(directory, 0o700);
            const displays = screen.getAllDisplays();
            const captures = [];
            for (let index = 0; index < displays.length; index++) {
                const imagePath = path.join(directory, 'display-' + index + '.png');
                await new Promise((resolve, reject) => execFile('screencapture', ['-x', '-C', '-D', String(index + 1), imagePath], { timeout: 15000, windowsHide: true }, error => error ? reject(error) : resolve()));
                await fs.chmod(imagePath, 0o600);
                const image = nativeImage.createFromBuffer(await fs.readFile(imagePath));
                const size = image.getSize();
                // OS numbering cannot reliably be equated with Electron display IDs.
                captures.push({ imageBuffer: boundedImage(image), display: { ...size, x: 0, y: 0, displayId: 'os-display-' + (index + 1) } });
            }
            if (!captures.length) throw new Error('No displays available');
            return captures;
        } finally { await fs.rm(directory, { recursive: true, force: true }); }
    }
    if (process.platform !== 'win32') throw new Error('Native display capture is unavailable');
    const raw = await executePowerShell(PS_CAPTURE_SCRIPT);
    const parsed = JSON.parse(raw);
    if (typeof parsed.base64 !== 'string' || !parsed.base64) throw new Error('Screenshot payload missing');
    const { nativeImage } = require('electron');
    return [{ imageBuffer: boundedImage(nativeImage.createFromBuffer(Buffer.from(parsed.base64, 'base64'))), display: {
        width: Number(parsed.width), height: Number(parsed.height), x: Number(parsed.x), y: Number(parsed.y), displayId: 'virtual-screen',
    } }];
}
async function captureCurrentMonitorPng() {
    const captures = await captureAllMonitorsPng();
    const primaryId = String(screen.getPrimaryDisplay().id);
    return captures.find(capture => capture.display.displayId === primaryId) || captures[0];
}
module.exports = { captureCurrentMonitorPng, captureAllMonitorsPng };
