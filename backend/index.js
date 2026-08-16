const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const ffmpegPath = 'ffmpeg';
const ytdlpBin = 'yt-dlp';

function runYtDlp(args) {
    return new Promise((resolve, reject) => {
        const cmd = `"${ytdlpBin}" ${args}`;
        console.log(`[yt-dlp] Executing: ${cmd.substring(0, 180)}...`);
        exec(cmd, { maxBuffer: 1024 * 1024 * 50, timeout: 180000 }, (error, stdout, stderr) => {
            if (error && (!stdout || !stdout.trim())) {
                console.error(`[yt-dlp error] Stderr:`, stderr ? stderr.substring(0, 300) : error.message);
                return reject(new Error(stderr || error.message));
            }
            resolve(stdout);
        });
    });
}

const app = express();
const port = process.env.PORT || 3001;

app.use(cors({
    origin: '*',
    exposedHeaders: ['Content-Disposition', 'X-Filename']
}));
app.use(express.json());

const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
}

const cookiesFile = path.join(__dirname, 'cookies.txt');

function syncCookies() {
    let rawContent = process.env.YOUTUBE_COOKIES || process.env.YOUTUBE_COOKIES_BASE64;

    if (process.env.YOUTUBE_COOKIES_BASE64 && !process.env.YOUTUBE_COOKIES) {
        try {
            rawContent = Buffer.from(process.env.YOUTUBE_COOKIES_BASE64, 'base64').toString('utf8');
        } catch (e) {
            console.error("Failed to decode YOUTUBE_COOKIES_BASE64:", e);
        }
    }

    if (rawContent) {
        try {
            let content = rawContent.replace(/\\n/g, '\n').replace(/\\r/g, '');
            const lines = content.split('\n');
            const fixedLines = ['# Netscape HTTP Cookie File', '# http://curl.haxx.se/rfc/cookie_spec.html', ''];

            for (let line of lines) {
                line = line.trim();
                if (!line || line.startsWith('#')) continue;
                const parts = line.split(/\s+/);
                if (parts.length >= 7) {
                    const domain = parts[0];
                    const flag = parts[1].toUpperCase();
                    const path = parts[2];
                    const secure = parts[3].toUpperCase();
                    const expiration = parts[4];
                    const name = parts[5];
                    const value = parts.slice(6).join(' ');
                    fixedLines.push([domain, flag, path, secure, expiration, name, value].join('\t'));
                }
            }

            if (fixedLines.length > 3) {
                fs.writeFileSync(cookiesFile, fixedLines.join('\n'), 'utf8');
                console.log(`[Cookies] Synced ${fixedLines.length - 3} valid Netscape cookies.`);
                return true;
            }
        } catch (e) {
            console.error("Failed to sync cookies from env:", e);
        }
    }
    return fs.existsSync(cookiesFile) && fs.statSync(cookiesFile).size > 50;
}

syncCookies();

function sanitizeFilename(name) {
    if (!name) return 'media';
    const cleaned = name
        .replace(/[^\w\s-]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    return cleaned.substring(0, 80) || 'media';
}

function getPlatformArgs(url, clientMode = 'cookies_web') {
    const isYouTube = /youtu(\.be|be\.com)/i.test(url);
    const isFacebook = /facebook\.com|fb\.watch/i.test(url);
    const isInstagram = /instagram\.com/i.test(url);

    let args = `--no-warnings --no-check-certificates`;

    const hasCookies = syncCookies();

    if (isYouTube) {
        if (clientMode === 'cookies_web' && hasCookies) {
            args += ` --cookies "${cookiesFile}"`;
        } else if (clientMode === 'cookies_android' && hasCookies) {
            args += ` --cookies "${cookiesFile}" --extractor-args "youtube:player_client=android"`;
        } else if (clientMode === 'no_cookies_android') {
            args += ` --no-cookies --extractor-args "youtube:player_client=android"`;
        } else if (clientMode === 'no_cookies_mweb') {
            args += ` --no-cookies --extractor-args "youtube:player_client=mweb"`;
        } else {
            args += ` --no-cookies --extractor-args "youtube:player_client=android"`;
        }
    } else if (isFacebook) {
        if (hasCookies) args += ` --cookies "${cookiesFile}"`;
        args += ` --add-header "user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36"`;
        args += ` --add-header "referer:https://www.facebook.com/"`;
    } else if (isInstagram) {
        if (hasCookies) args += ` --cookies "${cookiesFile}"`;
        args += ` --add-header "user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36"`;
        args += ` --add-header "referer:https://www.instagram.com/"`;
    } else {
        args += ` --add-header "user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36"`;
    }

    return args;
}

app.get('/health', (req, res) => {
    const hasCookies = syncCookies();
    res.json({
        status: 'ok',
        cookies_loaded: hasCookies,
        yt_dlp_bin: ytdlpBin,
        time: new Date()
    });
});

app.post('/api/download', async (req, res) => {
    const { url, format } = req.body;

    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }

    try {
        console.log(`\n========================================`);
        console.log(`Processing media request: ${url} (${format})`);
        console.log(`========================================`);

        const isYouTube = /youtu(\.be|be\.com)/i.test(url);
        const hasCookies = syncCookies();

        const modes = isYouTube
            ? (hasCookies ? ['cookies_web', 'cookies_android', 'no_cookies_android', 'no_cookies_mweb'] : ['no_cookies_android', 'no_cookies_mweb'])
            : ['default'];

        let info = null;
        let successfulMode = modes[0];

        // Step 1: Metadata extraction
        for (const mode of modes) {
            try {
                const platformArgs = getPlatformArgs(url, mode);
                console.log(`[Metadata] Trying mode '${mode}'...`);
                const jsonOutput = await runYtDlp(`"${url}" --dump-json ${platformArgs}`);
                info = JSON.parse(jsonOutput);
                if (info) {
                    successfulMode = mode;
                    console.log(`[Metadata] Success with mode '${mode}'`);
                    break;
                }
            } catch (err) {
                console.warn(`[Metadata] Mode '${mode}' failed:`, err.message ? err.message.substring(0, 120) : '');
            }
        }

        const rawTitle = (info && (info.title || info.fulltitle)) || 'media';
        const safeTitle = sanitizeFilename(rawTitle) || 'media';
        const extension = format === 'audio' ? 'mp3' : 'mp4';
        const finalDownloadName = `${safeTitle}.${extension}`;

        const duration = (info && info.duration) ? info.duration : 60;
        let originalSize = info ? (info.filesize || info.filesize_approx) : null;

        if (!originalSize) {
            console.log("[Info] Estimating filesize...");
            originalSize = (format === 'audio' ? 2 * 1024 * 1024 : 10 * 1024 * 1024) * (duration / 60);
        }

        console.log(`Title: "${safeTitle}", Duration: ${duration}s, Est Size: ${originalSize} bytes`);

        // Target 50% size reduction
        const targetSize = Math.max(originalSize / 2, 500 * 1024);
        const targetTotalBitrate = Math.floor((targetSize * 8) / duration);

        const timestamp = Date.now();
        const rawFileBase = path.join(tempDir, `raw_${timestamp}`);
        const rawFilePattern = `${rawFileBase}.%(ext)s`;
        const finalFilePath = path.join(tempDir, `processed_${timestamp}.${extension}`);

        // Step 2: Media Stream Download
        const downloadFormat = format === 'audio' ? 'ba/b' : 'bv*+ba/b';
        console.log(`[Download] Downloading stream format '${downloadFormat}'...`);

        let downloadSuccess = false;
        let lastError = null;

        const dlModes = [successfulMode, ...modes.filter(m => m !== successfulMode)];

        for (const dlMode of dlModes) {
            try {
                const currentArgs = getPlatformArgs(url, dlMode);
                console.log(`[Download] Attempting download with mode '${dlMode}'...`);

                try {
                    await runYtDlp(`"${url}" -o "${rawFilePattern}" -f "${downloadFormat}" ${currentArgs}`);
                } catch (fErr) {
                    console.warn(`[Download] Format-constrained attempt failed, retrying unconstrained...`);
                    await runYtDlp(`"${url}" -o "${rawFilePattern}" ${currentArgs}`);
                }

                downloadSuccess = true;
                console.log(`[Download] Stream download completed with mode '${dlMode}'`);
                break;
            } catch (err) {
                lastError = err;
                console.warn(`[Download] Download mode '${dlMode}' failed:`, err.message ? err.message.substring(0, 120) : '');
            }
        }

        if (!downloadSuccess) {
            throw lastError || new Error("Failed to download media stream.");
        }

        const files = fs.readdirSync(tempDir);
        // Find any file in tempDir created for this download, ignoring .part temporary files
        const downloadedFile = files.find(f => f.includes(String(timestamp)) && !f.endsWith('.part'));

        if (!downloadedFile) {
            const allFiles = fs.readdirSync(tempDir);
            console.error(`[Error] All files in tempDir:`, allFiles);
            throw new Error(`Downloaded file raw_${timestamp} not found in temp. Available: ${allFiles.join(', ')}`);
        }

        const downloadedFilePath = path.join(tempDir, downloadedFile);
        console.log(`[FFmpeg] Processing ${downloadedFilePath}...`);

        let ffmpegCmd = '';
        if (format === 'audio') {
            const audioBitrate = Math.max(targetTotalBitrate, 32000);
            ffmpegCmd = `"${ffmpegPath}" -y -i "${downloadedFilePath}" -b:a ${audioBitrate} -vn "${finalFilePath}"`;
        } else {
            let audioBitrate = 64000;
            let videoBitrate = targetTotalBitrate - audioBitrate;
            if (videoBitrate < 100000) videoBitrate = 150000;

            ffmpegCmd = `"${ffmpegPath}" -y -i "${downloadedFilePath}" -vf "scale=trunc(oh*a/2)*2:480" -c:v libx264 -preset fast -b:v ${videoBitrate} -b:a ${audioBitrate} -c:a aac "${finalFilePath}"`;
        }

        exec(ffmpegCmd, { timeout: 300000 }, (error, stdout, stderr) => {
            if (error) {
                console.error(`[FFmpeg] Error: ${error.message}`);
                return res.status(500).json({ error: `Media compression failed: ${error.message}` });
            }

            console.log(`[FFmpeg] Compression completed: ${finalFilePath}`);

            const encodedFilename = encodeURIComponent(finalDownloadName);
            res.setHeader('Content-Disposition', `attachment; filename="${encodedFilename}"`);
            res.setHeader('X-Filename', encodedFilename);

            const fileStream = fs.createReadStream(finalFilePath);
            fileStream.pipe(res);

            fileStream.on('close', () => {
                try {
                    if (fs.existsSync(downloadedFilePath)) fs.unlinkSync(downloadedFilePath);
                    if (fs.existsSync(finalFilePath)) fs.unlinkSync(finalFilePath);
                } catch (cleanupErr) {
                    console.error("Cleanup error:", cleanupErr);
                }
            });
        });

    } catch (err) {
        console.error("Error processing request:", err);
        res.status(500).json({ error: err.message || 'Failed to process media' });
    }
});

app.listen(port, () => {
    console.log(`Production backend running on port ${port}`);
});
