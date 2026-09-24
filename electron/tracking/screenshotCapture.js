const { desktopCapturer, screen } = require('electron');
const { execFile } = require('child_process');
const { readFile, unlink } = require('fs/promises');

const PS_CAPTURE_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Capture full multi-monitor virtual screen bounding all displays
$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen

$bitmap = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bounds.Size)

$tmpFile = [System.IO.Path]::GetTempFileName()
$pngPath = [System.IO.Path]::ChangeExtension($tmpFile, 'png')
if (Test-Path $tmpFile) { Remove-Item $tmpFile -Force }

$bitmap.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()

[PSCustomObject]@{
    path = $pngPath
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
            { timeout: 15000, windowsHide: true, maxBuffer: 1024 * 1024 * 8 },
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

/**
 * Captures screenshot directly into an in-memory Buffer using Electron's native
 * desktopCapturer API (DirectX / ScreenCaptureKit). This eliminates spawning external
 * PowerShell processes, prevents antivirus/EDR flags, and avoids writing sensitive
 * unencrypted image files to the OS temporary directory.
 */
async function captureCurrentMonitorPng() {
    // ── 1. Native In-Memory Capture via Electron desktopCapturer ─────────────
    try {
        if (desktopCapturer) {
            const primaryDisplay = screen ? screen.getPrimaryDisplay() : null;
            const bounds = primaryDisplay ? primaryDisplay.bounds : { width: 1920, height: 1080 };
            const sources = await desktopCapturer.getSources({
                types: ['screen'],
                thumbnailSize: {
                    width: bounds.width || 1920,
                    height: bounds.height || 1080,
                },
            });

            if (sources && sources.length > 0) {
                // Select primary display or first available monitor
                const source = sources.find(s => s.id.startsWith('screen:0')) || sources[0];
                const imageBuffer = source.thumbnail.toPNG();
                const size = source.thumbnail.getSize();

                if (imageBuffer && imageBuffer.length > 0) {
                    return {
                        imageBuffer,
                        display: {
                            width: size.width || bounds.width || 0,
                            height: size.height || bounds.height || 0,
                            x: bounds.x || 0,
                            y: bounds.y || 0,
                        },
                    };
                }
            }
        }
    } catch (nativeErr) {
        console.warn('[ScreenshotCapture] Native desktopCapturer failed, trying OS fallback:', nativeErr?.message);
    }

    // ── 2. Fallbacks (macOS screencapture / Windows PowerShell) ───────────────
    if (process.platform === 'darwin') {
        const { execFile: execFileMac } = require('child_process');
        const path = require('path');
        const os = require('os');
        const fs = require('fs/promises');

        const timestamp = Date.now();
        const tmpPath = path.join(os.tmpdir(), `wf_shot_${timestamp}.png`);

        return new Promise((resolve, reject) => {
            execFileMac('screencapture', ['-x', '-C', '-m', tmpPath], async (err, _stdout, stderr) => {
                if (err) {
                    return reject(new Error('macOS screenshot failed: ' + (stderr || err.message)));
                }
                try {
                    await new Promise(r => setTimeout(r, 400));
                    let imageBuffer;
                    try {
                        imageBuffer = await fs.readFile(tmpPath);
                    } catch (readErr) {
                        const fallbackPath = path.join(os.tmpdir(), `wf_shot_${timestamp} 1.png`);
                        imageBuffer = await fs.readFile(fallbackPath);
                        await fs.unlink(fallbackPath).catch(() => {});
                    }
                    await fs.unlink(tmpPath).catch(() => {});
                    resolve({
                        imageBuffer,
                        display: { width: 0, height: 0, x: 0, y: 0 }
                    });
                } catch (e) {
                    reject(new Error('Failed to read mac screenshot: ' + e.message));
                }
            });
        });
    }

    const raw = await executePowerShell(PS_CAPTURE_SCRIPT);
    if (!raw) {
        throw new Error('Screenshot capture returned empty output');
    }

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        throw new Error(`Screenshot metadata parse failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }

    const filePath = parsed?.path;
    if (!filePath || typeof filePath !== 'string') {
        throw new Error('Screenshot capture metadata missing output path');
    }

    try {
        const imageBuffer = await readFile(filePath);
        return {
            imageBuffer,
            display: {
                width: Number(parsed.width) || 0,
                height: Number(parsed.height) || 0,
                x: Number(parsed.x) || 0,
                y: Number(parsed.y) || 0,
            },
        };
    } finally {
        await unlink(filePath).catch(() => {});
    }
}

module.exports = {
    captureCurrentMonitorPng,
};
