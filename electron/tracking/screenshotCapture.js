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

async function captureCurrentMonitorPng() {
    if (process.platform === 'darwin') {
        const { execFile } = require('child_process');
        const path = require('path');
        const os = require('os');
        const fs = require('fs/promises');
        
        const timestamp = Date.now();
        const tmpPath = path.join(os.tmpdir(), `wf_shot_${timestamp}.png`);
        
        return new Promise((resolve, reject) => {
            // -x = silent, -C = cursor, -m = main monitor ONLY (prevents filename ' 1' multi-monitor bug)
            execFile('screencapture', ['-x', '-C', '-m', tmpPath], async (err, stdout, stderr) => {
                if (err) {
                    return reject(new Error('macOS screenshot failed: ' + (stderr || err.message)));
                }
                try {
                    // Give it a solid 500ms for macOS to finish physically writing to the SSD
                    await new Promise(r => setTimeout(r, 500));
                    let imageBuffer;
                    try {
                        imageBuffer = await fs.readFile(tmpPath);
                    } catch (readErr) {
                        // Multi-monitor fallback just in case -m failed to stop numbering on older macOS
                        try {
                            const fallbackPath = path.join(os.tmpdir(), `wf_shot_${timestamp} 1.png`);
                            imageBuffer = await fs.readFile(fallbackPath);
                            await fs.unlink(fallbackPath).catch(() => {});
                        } catch (fallbackErr) {
                            throw readErr; // throw original
                        }
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

