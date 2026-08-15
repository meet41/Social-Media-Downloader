const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const ytdlp = require('yt-dlp-exec');
let ffmpegPath;
try {
    ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
} catch (e) {
    ffmpegPath = 'ffmpeg'; // fallback to system ffmpeg on Linux/Docker
}

const app = express();
const port = process.env.PORT || 3001;

// Expose custom headers so the browser can read the filename accurately in Unicode
app.use(cors({
    origin: '*',
    exposedHeaders: ['Content-Disposition', 'X-Filename']
}));
app.use(express.json());

// Ensure temp directory exists
const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir);
}

const cookiesFile = path.join(__dirname, 'cookies.txt');

// Helper to sanitize title for Windows/Linux filenames
function sanitizeFilename(name) {
    if (!name) return 'media';
    return name
        .replace(/[\/\\:*?"<>|]/g, '') // remove forbidden characters
        .replace(/[\x00-\x1F\x7F]/g, '') // remove control chars
        .replace(/\s+/g, ' ')           // collapse extra whitespace
        .trim()
        .substring(0, 100);             // limit length
}

function getPlatformOptions(url) {
    const isYouTube = /youtu(\.be|be\.com)/i.test(url);
    const isFacebook = /facebook\.com|fb\.watch/i.test(url);
    const isInstagram = /instagram\.com/i.test(url);

    const options = {
        noWarnings: true,
        addHeader: [
            'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            'accept-language:en-US,en;q=0.9'
        ]
    };

    if (fs.existsSync(cookiesFile)) {
        options.cookies = cookiesFile;
    }

    if (isYouTube) {
        options.addHeader.push('referer:https://www.youtube.com/');
        options.extractorArgs = 'youtube:player_client=android,web';
    } else if (isFacebook) {
        options.addHeader.push('referer:https://www.facebook.com/');
    } else if (isInstagram) {
        options.addHeader.push('referer:https://www.instagram.com/');
    }

    return options;
}

// Health check endpoint for cloud platforms (Render/Railway/Koyeb)
app.get('/health', (req, res) => {
    res.json({ status: 'ok', time: new Date() });
});

app.post('/api/download', async (req, res) => {
    const { url, format } = req.body;

    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }

    try {
        console.log(`Fetching metadata for ${url}...`);

        const platformOpts = getPlatformOptions(url);

        let info;
        try {
            info = await ytdlp(url, {
                ...platformOpts,
                dumpJson: true,
            });
        } catch (metaErr) {
            console.warn("Metadata dump with JSON failed, attempting fallback download...", metaErr.message);
        }

        const rawTitle = (info && (info.title || info.fulltitle)) || 'download';
        const safeTitle = sanitizeFilename(rawTitle) || 'download';
        const extension = format === 'audio' ? 'mp3' : 'mp4';
        const finalDownloadName = `${safeTitle}.${extension}`;

        const duration = (info && info.duration) ? info.duration : 60;
        let originalSize = info ? (info.filesize || info.filesize_approx) : null;

        if (!originalSize) {
            console.log("Could not determine original filesize from yt-dlp. Estimating...");
            originalSize = (format === 'audio' ? 2 * 1024 * 1024 : 10 * 1024 * 1024) * (duration / 60);
        }

        console.log(`Title: "${safeTitle}", Duration: ${duration}s, Original Size: ${originalSize} bytes`);

        // 50% size reduction target
        const targetSize = Math.max(originalSize / 2, 500 * 1024);
        const targetTotalBitrate = Math.floor((targetSize * 8) / duration);

        console.log(`Target Size: ${targetSize} bytes, Target Bitrate: ${targetTotalBitrate} bps`);

        const timestamp = Date.now();
        const rawFilePath = path.join(tempDir, `raw_${timestamp}.%(ext)s`);
        const finalFilePath = path.join(tempDir, `processed_${timestamp}.${extension}`);

        console.log("Downloading best available source...");

        const downloadOptions = {
            ...platformOpts,
            output: rawFilePath,
            format: format === 'audio' ? 'bestaudio/best' : 'bestvideo+bestaudio/best',
        };

        await ytdlp(url, downloadOptions);

        const files = fs.readdirSync(tempDir);
        const downloadedFile = files.find(f => f.startsWith(`raw_${timestamp}`));

        if (!downloadedFile) {
            throw new Error("Downloaded media file not found on server.");
        }

        const downloadedFilePath = path.join(tempDir, downloadedFile);
        console.log(`Downloaded to ${downloadedFilePath}. Starting ffmpeg compression...`);

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
                return res.status(500).json({ error: 'Compression failed' });
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
            userMessage = 'This Facebook post link does not contain a public downloadable video or is a private/group post. Please provide a direct public video or reel link.';
        }

        res.status(500).json({ error: userMessage });
    }
});

app.listen(port, () => {
    console.log(`Backend server running at port ${port}`);
});
