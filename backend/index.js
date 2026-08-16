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
        console.log(`[yt-dlp] Running command...`);
        exec(cmd, { maxBuffer: 1024 * 1024 * 50, timeout: 180000 }, (error, stdout, stderr) => {
            if (error) {
                return reject(new Error(stderr || stdout || error.message));
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
    if (process.env.YOUTUBE_COOKIES) {
        try {
            let content = process.env.YOUTUBE_COOKIES;
            if (content.includes('\\n')) {
                content = content.replace(/\\n/g, '\n');
            }
            if (content.includes('\\t')) {
                content = content.replace(/\\t/g, '\t');
            }
            fs.writeFileSync(cookiesFile, content.trim(), 'utf8');
            return true;
        } catch (e) {
            console.error("Failed to sync cookies from env:", e);
        }
    }
    return fs.existsSync(cookiesFile);
}

syncCookies();

function sanitizeFilename(name) {
    if (!name) return 'media';
    return name
        .replace(/[\/\\:*?"<>|]/g, '')
        .replace(/[\x00-\x1F\x7F]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, 100);
}

function getPlatformArgs(url, clientMode = 'mobile_cascade') {
    const isYouTube = /youtu(\.be|be\.com)/i.test(url);
    const isFacebook = /facebook\.com|fb\.watch/i.test(url);
    const isInstagram = /instagram\.com/i.test(url);

    let args = `--no-warnings --no-check-certificates`;

    const hasCookies = syncCookies();
    if (hasCookies) {
        args += ` --cookies "${cookiesFile}"`;
    }

    if (isYouTube) {
        if (clientMode === 'mobile_cascade') {
            args += ` --extractor-args "youtube:player_client=mweb,android,ios"`;
        } else if (clientMode === 'tv_cascade') {
            args += ` --extractor-args "youtube:player_client=tv_embedded,tv,mweb"`;
        } else if (clientMode === 'web_cascade') {
            args += ` --extractor-args "youtube:player_client=web_embedded,web"`;
        }
        args += ` --add-header "user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36"`;
        args += ` --add-header "accept-language:en-US,en;q=0.9"`;
    } else if (isFacebook) {
        args += ` --add-header "user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36"`;
        args += ` --add-header "referer:https://www.facebook.com/"`;
    } else if (isInstagram) {
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
        const modes = isYouTube ? ['mobile_cascade', 'tv_cascade', 'web_cascade'] : ['default'];

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

        const rawTitle = (info && (info.title || info.fulltitle)) || 'download';
        const safeTitle = sanitizeFilename(rawTitle) || 'download';
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
        const rawFilePath = path.join(tempDir, `raw_${timestamp}.%(ext)s`);
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
                    await runYtDlp(`"${url}" -o "${rawFilePath}" -f "${downloadFormat}" ${currentArgs}`);
                } catch (fErr) {
                    console.warn(`[Download] Format-constrained attempt failed, retrying unconstrained...`);
                    await runYtDlp(`"${url}" -o "${rawFilePath}" ${currentArgs}`);
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
        const downloadedFile = files.find(f => f.startsWith(`raw_${timestamp}`));

        if (!downloadedFile) {
            throw new Error("Downloaded file not found on server.");
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
                return res.status(500).json({ error: 'Media compression failed.' });
            }

            console.log(`[FFmpeg] Compression completed: ${finalFilePath}`);

            const encodedFilename = encodeURIComponent(finalDownloadName);
            res.setHeader('Content-Disposition', `attachment; filename="${encodedFilename}"; filename*=UTF-8''${encodedFilename}`);
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
        let userMessage = err.message || 'Failed to process media';

        if (userMessage.includes('No video formats found') || userMessage.includes('share/p/')) {
            userMessage = 'This Facebook link is a Group/Private post. Please provide a direct public video or reel link.';
        }

        res.status(500).json({ error: userMessage });
    }
});

app.listen(port, () => {
    console.log(`Production backend running on port ${port}`);
});
