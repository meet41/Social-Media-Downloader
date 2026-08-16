const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function getFfmpegPath() {
    try {
        const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
        if (ffmpegInstaller && ffmpegInstaller.path && fs.existsSync(ffmpegInstaller.path)) {
            console.log(`[FFmpeg] Using binary at: ${ffmpegInstaller.path}`);
            return ffmpegInstaller.path;
        }
    } catch (e) {}
    return 'ffmpeg';
}

const ffmpegPath = getFfmpegPath();

function runYtDlp(argsArray) {
    return new Promise((resolve, reject) => {
        const isWin = process.platform === 'win32';
        const cmd = isWin ? 'python' : 'python3';
        const fullArgs = ['-m', 'yt_dlp', ...argsArray];

        console.log(`[yt-dlp] Spawning: ${cmd} ${fullArgs.join(' ').substring(0, 150)}...`);
        const child = spawn(cmd, fullArgs, { shell: false });

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', data => { stdout += data.toString(); });
        child.stderr.on('data', data => { stderr += data.toString(); });

        child.on('close', code => {
            if (code !== 0) {
                console.error(`[yt-dlp error] Code: ${code}, Stderr:`, stderr.substring(0, 300));
                return reject(new Error(stderr || stdout || `yt-dlp process exited with code ${code}`));
            }
            resolve(stdout);
        });

        child.on('error', err => reject(err));
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

function sanitizeFilename(name) {
    if (!name) return 'media';
    const cleaned = name
        .replace(/[\\/:*?"<>|\0]/g, '')
        .replace(/[\r\n\t]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return cleaned.substring(0, 150) || 'media';
}

function getPlatformArgsArray(url, clientMode = 'android') {
    const isYouTube = /youtu(\.be|be\.com)/i.test(url);
    const args = ['--no-warnings', '--no-check-certificates'];

    if (isYouTube) {
        args.push('--no-cookies');
        if (clientMode === 'android') {
            args.push('--extractor-args', 'youtube:player_client=android,mweb');
        } else if (clientMode === 'mweb') {
            args.push('--extractor-args', 'youtube:player_client=mweb,android');
        } else {
            args.push('--extractor-args', 'youtube:player_client=android,mweb,web_creator');
        }
    } else {
        args.push('--add-header', 'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36');
    }

    return args;
}

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        yt_dlp_bin: 'python -m yt_dlp',
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
        const timestamp = Date.now();
        const downloadedFilePath = path.join(tempDir, `raw_${timestamp}.media`);

        // Step 1: Metadata extraction
        let info = null;
        try {
            const jsonOutput = await runYtDlp([url, '--dump-json', ...getPlatformArgsArray(url, 'android')]);
            info = JSON.parse(jsonOutput);
        } catch (e) {
            console.warn('[Metadata] android mode notice, trying mweb:', e.message ? e.message.substring(0, 100) : '');
            try {
                const jsonOutput = await runYtDlp([url, '--dump-json', ...getPlatformArgsArray(url, 'mweb')]);
                info = JSON.parse(jsonOutput);
            } catch (err2) {
                console.warn('[Metadata] mweb fallback notice:', err2.message ? err2.message.substring(0, 100) : '');
            }
        }

        const rawTitle = (info && (info.title || info.fulltitle)) || 'media';
        const safeTitle = sanitizeFilename(rawTitle) || 'media';
        const extension = format === 'audio' ? 'mp3' : 'mp4';
        const finalDownloadName = `${safeTitle}.${extension}`;

        const duration = (info && info.duration) ? info.duration : 60;
        let originalSize = info ? (info.filesize || info.filesize_approx) : null;

        if (!originalSize) {
            console.log('[Info] Estimating filesize...');
            originalSize = (format === 'audio' ? 2 * 1024 * 1024 : 10 * 1024 * 1024) * (duration / 60);
        }

        console.log(`Title: "${safeTitle}", Duration: ${duration}s, Est Size: ${originalSize} bytes`);

        const targetSize = Math.max(originalSize / 2, 500 * 1024);
        const targetTotalBitrate = Math.floor((targetSize * 8) / duration);
        const finalFilePath = path.join(tempDir, `processed_${timestamp}.${extension}`);

        // Step 2: Stream Download
        const downloadArgs = [
            url,
            '-o', downloadedFilePath,
            '-f', 'b/best[height<=480]/best',
            '--no-part',
            ...getPlatformArgsArray(url, 'android')
        ];

        console.log(`[Download] Downloading stream...`);
        try {
            await runYtDlp(downloadArgs);
        } catch (dlErr) {
            console.warn('[Download] Retrying with mweb client...', dlErr.message ? dlErr.message.substring(0, 100) : '');
            const fallbackArgs = [
                url,
                '-o', downloadedFilePath,
                '-f', 'b/best[height<=480]/best',
                '--no-part',
                ...getPlatformArgsArray(url, 'mweb')
            ];
            await runYtDlp(fallbackArgs);
        }

        if (!fs.existsSync(downloadedFilePath) || fs.statSync(downloadedFilePath).size === 0) {
            throw new Error('Failed to download media stream to server disk.');
        }

        console.log(`[FFmpeg] Processing ${downloadedFilePath}...`);

        let ffmpegArgs = [];
        if (format === 'audio') {
            const audioBitrate = Math.max(targetTotalBitrate, 32000);
            ffmpegArgs = ['-y', '-i', downloadedFilePath, '-b:a', `${audioBitrate}`, '-c:a', 'mp3', '-vn', finalFilePath];
        } else {
            let audioBitrate = 64000;
            let videoBitrate = Math.max(targetTotalBitrate - audioBitrate, 150000);
            ffmpegArgs = ['-y', '-i', downloadedFilePath, '-vf', 'scale=trunc(oh*a/2)*2:480', '-c:v', 'libx264', '-preset', 'fast', '-b:v', `${videoBitrate}`, '-b:a', `${audioBitrate}`, '-c:a', 'aac', finalFilePath];
        }

        const ffmpegChild = spawn(ffmpegPath, ffmpegArgs, { shell: false });
        let ffmpegErr = '';

        ffmpegChild.stderr.on('data', data => { ffmpegErr += data.toString(); });

        ffmpegChild.on('close', code => {
            if (code !== 0 || !fs.existsSync(finalFilePath)) {
                console.error(`[FFmpeg Error] Code ${code}:`, ffmpegErr.substring(0, 300));
                return res.status(500).json({ error: `FFmpeg compression failed with code ${code}` });
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
        res.status(500).json({ error: err.message || 'Failed to process media' });
    }
});

app.listen(port, () => {
    console.log(`Production backend running on port ${port}`);
});
