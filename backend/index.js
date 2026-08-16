const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

// Determine ffmpeg path
let ffmpegPath = 'ffmpeg';
try {
    const installer = require('@ffmpeg-installer/ffmpeg');
    if (installer && installer.path && fs.existsSync(installer.path)) {
        ffmpegPath = installer.path;
    }
} catch (e) {
    ffmpegPath = 'ffmpeg';
}

// Determine yt-dlp binary
let ytdlpBin = 'yt-dlp';
const localYtDlp = path.join(__dirname, 'node_modules', 'yt-dlp-exec', 'bin', 'yt-dlp.exe');
if (fs.existsSync(localYtDlp)) {
    ytdlpBin = localYtDlp;
}

function runYtDlp(args) {
    return new Promise((resolve, reject) => {
        exec(`"${ytdlpBin}" ${args}`, { maxBuffer: 1024 * 1024 * 50 }, (error, stdout, stderr) => {
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

// Check for cookies file (supports cookies.txt or YOUTUBE_COOKIES env var on Render)
const cookiesFile = path.join(__dirname, 'cookies.txt');

if (process.env.YOUTUBE_COOKIES && !fs.existsSync(cookiesFile)) {
    try {
        fs.writeFileSync(cookiesFile, process.env.YOUTUBE_COOKIES, 'utf8');
        console.log("Loaded cookies from YOUTUBE_COOKIES environment variable.");
    } catch (e) {
        console.error("Failed to write cookies from env:", e);
    }
}

function sanitizeFilename(name) {
    if (!name) return 'media';
    return name
        .replace(/[\/\\:*?"<>|]/g, '')
        .replace(/[\x00-\x1F\x7F]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, 100);
}

function getPlatformArgs(url, clientType = 'default') {
    const isYouTube = /youtu(\.be|be\.com)/i.test(url);
    const isFacebook = /facebook\.com|fb\.watch/i.test(url);
    const isInstagram = /instagram\.com/i.test(url);

    let args = `--no-warnings`;

    if (fs.existsSync(cookiesFile)) {
        args += ` --cookies "${cookiesFile}"`;
    }

    if (isYouTube) {
        if (clientType === 'ios') {
            args += ` --extractor-args "youtube:player_client=ios" --add-header "user-agent:Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"`;
        } else if (clientType === 'android') {
            args += ` --extractor-args "youtube:player_client=android" --add-header "user-agent:Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36"`;
        } else if (clientType === 'mweb') {
            args += ` --extractor-args "youtube:player_client=mweb" --add-header "user-agent:Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36"`;
        } else {
            args += ` --extractor-args "youtube:player_client=ios,android,mweb"`;
        }
        args += ` --add-header "accept-language:en-US,en;q=0.9"`;
    } else if (isFacebook) {
        args += ` --add-header "user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36" --add-header "referer:https://www.facebook.com/"`;
    } else if (isInstagram) {
        args += ` --add-header "user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36" --add-header "referer:https://www.instagram.com/"`;
    } else {
        args += ` --add-header "user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"`;
    }

    return args;
}

app.get('/health', (req, res) => {
    res.json({ status: 'ok', time: new Date() });
});

app.post('/api/download', async (req, res) => {
    const { url, format } = req.body;

    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }

    try {
        console.log(`Processing media request for: ${url}`);

        const isYouTube = /youtu(\.be|be\.com)/i.test(url);
        let platformArgs = getPlatformArgs(url, 'default');

        let info = null;
        const clientFallbacks = isYouTube ? ['default', 'ios', 'android', 'mweb'] : ['default'];

        for (const client of clientFallbacks) {
            try {
                platformArgs = getPlatformArgs(url, client);
                const jsonOutput = await runYtDlp(`"${url}" --dump-json ${platformArgs}`);
                info = JSON.parse(jsonOutput);
                if (info) break;
            } catch (err) {
                console.warn(`Extraction attempt with client '${client}' failed:`, err.message.substring(0, 120));
            }
        }

        const rawTitle = (info && (info.title || info.fulltitle)) || 'download';
        const safeTitle = sanitizeFilename(rawTitle) || 'download';
        const extension = format === 'audio' ? 'mp3' : 'mp4';
        const finalDownloadName = `${safeTitle}.${extension}`;

        const duration = (info && info.duration) ? info.duration : 60;
        let originalSize = info ? (info.filesize || info.filesize_approx) : null;

        if (!originalSize) {
            console.log("Could not determine exact filesize from metadata. Estimating...");
            originalSize = (format === 'audio' ? 2 * 1024 * 1024 : 10 * 1024 * 1024) * (duration / 60);
        }

        console.log(`Title: "${safeTitle}", Duration: ${duration}s, Original Size: ${originalSize} bytes`);

        // Target: 50% size reduction
        const targetSize = Math.max(originalSize / 2, 500 * 1024);
        const targetTotalBitrate = Math.floor((targetSize * 8) / duration);

        const timestamp = Date.now();
        const rawFilePath = path.join(tempDir, `raw_${timestamp}.%(ext)s`);
        const finalFilePath = path.join(tempDir, `processed_${timestamp}.${extension}`);

        // Flexible fallback formats to ensure yt-dlp always finds a match
        const downloadFormat = format === 'audio' 
            ? 'bestaudio/best[height<=480]/best' 
            : 'bestvideo[height<=720]+bestaudio/best[height<=720]/bestvideo+bestaudio/best';

        console.log("Downloading stream from source...");

        let downloadSuccess = false;
        let lastDownloadError = null;

        for (const client of clientFallbacks) {
            try {
                const currentArgs = getPlatformArgs(url, client);
                await runYtDlp(`"${url}" -o "${rawFilePath}" -f "${downloadFormat}" ${currentArgs}`);
                downloadSuccess = true;
                break;
            } catch (dlErr) {
                lastDownloadError = dlErr;
                console.warn(`Download with client '${client}' failed, trying next fallback...`);
            }
        }

        if (!downloadSuccess) {
            throw lastDownloadError || new Error("Failed to download video stream from source.");
        }

        const files = fs.readdirSync(tempDir);
        const downloadedFile = files.find(f => f.startsWith(`raw_${timestamp}`));

        if (!downloadedFile) {
            throw new Error("Downloaded media file was not created on the server.");
        }

        const downloadedFilePath = path.join(tempDir, downloadedFile);
        console.log(`Downloaded to ${downloadedFilePath}. Starting FFmpeg compression...`);

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

        exec(ffmpegCmd, (error, stdout, stderr) => {
            if (error) {
                console.error(`ffmpeg error: ${error.message}`);
                console.error(`ffmpeg stderr: ${stderr}`);
                return res.status(500).json({ error: 'Media compression failed.' });
            }

            console.log(`Compression successful: ${finalFilePath}`);

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
