const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');

// ===== FFmpeg Setup =====
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

// ===== yt-dlp Helper (used for non-YouTube platforms) =====
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

// ===== FFmpeg as Promise =====
function runFfmpeg(args) {
    return new Promise((resolve, reject) => {
        console.log(`[FFmpeg] Running: ffmpeg ${args.slice(0, 6).join(' ')}...`);
        const child = spawn(ffmpegPath, args, { shell: false });
        let stderr = '';
        child.stderr.on('data', d => { stderr += d.toString(); });
        child.on('close', code => {
            if (code !== 0) {
                console.error(`[FFmpeg] Error code ${code}:`, stderr.substring(0, 300));
                return reject(new Error(`FFmpeg failed with code ${code}`));
            }
            resolve();
        });
        child.on('error', reject);
    });
}

// ===== Express Setup =====
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

// ===== Utility Functions =====
function sanitizeFilename(name) {
    if (!name) return 'media';
    const cleaned = name
        .replace(/[\\/:*?"<>|\0]/g, '')
        .replace(/[\r\n\t]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return cleaned.substring(0, 150) || 'media';
}

function cleanup(...files) {
    for (const f of files) {
        try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch (e) {}
    }
}

// ===== YouTube Piped API Layer =====
// Piped is an open-source YouTube proxy that handles bot-detection bypass.
// We dynamically discover working instances from the official registry.

let cachedPipedInstances = [];
let instancesCacheTime = 0;
const INSTANCE_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

async function getWorkingPipedInstances() {
    // Return cached if fresh
    if (cachedPipedInstances.length > 0 && (Date.now() - instancesCacheTime) < INSTANCE_CACHE_TTL) {
        return cachedPipedInstances;
    }

    // Fallback hardcoded list (in case registry is down)
    const fallbackList = [
        'https://api.piped.private.coffee',
        'https://pipedapi.kavin.rocks',
        'https://pipedapi.adminforge.de',
    ];

    try {
        console.log('[Piped] Fetching instance registry...');
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        const res = await fetch('https://piped-instances.kavin.rocks/', {
            signal: controller.signal,
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        clearTimeout(timeout);

        if (res.ok) {
            const data = await res.json();
            // Filter to instances with decent uptime, sorted best first
            const good = data
                .filter(i => i.api_url && (i.uptime_24h || 0) > 50)
                .sort((a, b) => (b.uptime_7d || 0) - (a.uptime_7d || 0))
                .map(i => i.api_url);

            if (good.length > 0) {
                cachedPipedInstances = good.slice(0, 8);
                instancesCacheTime = Date.now();
                console.log(`[Piped] Discovered ${cachedPipedInstances.length} instances`);
                return cachedPipedInstances;
            }
        }
    } catch (e) {
        console.warn('[Piped] Registry fetch failed:', e.message);
    }

    console.log('[Piped] Using fallback instance list');
    return fallbackList;
}

function extractYouTubeVideoId(url) {
    const patterns = [
        /(?:youtu\.be\/)([a-zA-Z0-9_-]{11})/,
        /(?:youtube\.com\/watch\?.*v=)([a-zA-Z0-9_-]{11})/,
        /(?:youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
        /(?:youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    ];
    for (const pat of patterns) {
        const m = url.match(pat);
        if (m) return m[1];
    }
    return null;
}

async function fetchPipedStreams(videoId) {
    const instances = await getWorkingPipedInstances();

    for (const apiUrl of instances) {
        try {
            console.log(`[Piped] Trying ${apiUrl}/streams/${videoId}...`);
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 12000);

            const res = await fetch(`${apiUrl}/streams/${videoId}`, {
                signal: controller.signal,
                headers: { 'User-Agent': 'Mozilla/5.0' }
            });
            clearTimeout(timeout);

            if (!res.ok) {
                console.warn(`[Piped] ${apiUrl} → HTTP ${res.status}`);
                continue;
            }

            const data = await res.json();
            if (data.error) {
                console.warn(`[Piped] ${apiUrl} → ${data.error}`);
                continue;
            }

            const hasStreams = (data.videoStreams?.length > 0) || (data.audioStreams?.length > 0);
            if (!hasStreams) {
                console.warn(`[Piped] ${apiUrl} → no streams`);
                continue;
            }

            console.log(`[Piped] ✓ Got data from ${apiUrl} (${data.videoStreams?.length || 0}v, ${data.audioStreams?.length || 0}a)`);
            return data;
        } catch (e) {
            console.warn(`[Piped] ${apiUrl} → ${e.message?.substring(0, 60)}`);
        }
    }
    return null;
}

async function downloadStreamToFile(streamUrl, outputPath) {
    console.log(`[Stream] Downloading to ${path.basename(outputPath)}...`);
    const res = await fetch(streamUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        redirect: 'follow',
    });
    if (!res.ok) throw new Error(`Stream download failed: HTTP ${res.status}`);

    const nodeStream = Readable.fromWeb(res.body);
    const fileWrite = fs.createWriteStream(outputPath);
    await pipeline(nodeStream, fileWrite);

    const size = fs.statSync(outputPath).size;
    console.log(`[Stream] ✓ Downloaded ${(size / 1024 / 1024).toFixed(1)} MB`);
    return size;
}

// ===== Routes =====

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

    const timestamp = Date.now();
    const extension = format === 'audio' ? 'mp3' : 'mp4';
    const rawFile = path.join(tempDir, `raw_${timestamp}.media`);
    const audioFile = path.join(tempDir, `audio_${timestamp}.media`);
    const finalFile = path.join(tempDir, `out_${timestamp}.${extension}`);

    try {
        console.log(`\n========================================`);
        console.log(`Processing: ${url} (${format})`);
        console.log(`========================================`);

        let title = 'media';
        let duration = 60;
        let downloadedFile = null;
        let downloadedAudioFile = null;
        let needsMerge = false;

        const videoId = extractYouTubeVideoId(url);
        const isYouTube = !!videoId;

        // ===== YOUTUBE: Use Piped API (bypasses cloud bot detection) =====
        if (isYouTube) {
            console.log(`[YouTube] Video ID: ${videoId}`);

            const pipedData = await fetchPipedStreams(videoId);

            if (pipedData) {
                title = pipedData.title || title;
                duration = pipedData.duration || duration;

                if (format === 'audio') {
                    // Pick highest bitrate audio stream
                    const audioStream = (pipedData.audioStreams || [])
                        .filter(s => s.url && s.mimeType?.startsWith('audio/'))
                        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];

                    if (audioStream) {
                        console.log(`[Piped] Audio: ${audioStream.mimeType} @ ${audioStream.bitrate}bps`);
                        await downloadStreamToFile(audioStream.url, rawFile);
                        downloadedFile = rawFile;
                    }
                } else {
                    // Try combined stream (audio+video) ≤ 480p first
                    const combined = (pipedData.videoStreams || [])
                        .filter(s => s.url && !s.videoOnly && s.height && s.height <= 480)
                        .sort((a, b) => (b.height || 0) - (a.height || 0))[0];

                    if (combined) {
                        console.log(`[Piped] Combined: ${combined.height}p ${combined.mimeType}`);
                        await downloadStreamToFile(combined.url, rawFile);
                        downloadedFile = rawFile;
                    } else {
                        // Download video-only + audio separately, merge later
                        const videoStream = (pipedData.videoStreams || [])
                            .filter(s => s.url && s.videoOnly && s.height && s.height <= 480)
                            .sort((a, b) => (b.height || 0) - (a.height || 0))[0];
                        const audioStream = (pipedData.audioStreams || [])
                            .filter(s => s.url && s.mimeType?.startsWith('audio/'))
                            .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];

                        if (videoStream && audioStream) {
                            console.log(`[Piped] VideoOnly: ${videoStream.height}p + Audio: ${audioStream.bitrate}bps`);
                            await downloadStreamToFile(videoStream.url, rawFile);
                            await downloadStreamToFile(audioStream.url, audioFile);
                            downloadedFile = rawFile;
                            downloadedAudioFile = audioFile;
                            needsMerge = true;
                        } else if (videoStream) {
                            console.log(`[Piped] VideoOnly: ${videoStream.height}p (no separate audio)`);
                            await downloadStreamToFile(videoStream.url, rawFile);
                            downloadedFile = rawFile;
                        }
                    }
                }

                if (downloadedFile) {
                    console.log('[Piped] ✓ YouTube download successful via Piped');
                }
            }
        }

        // ===== NON-YOUTUBE or PIPED FAILURE: Use yt-dlp =====
        if (!downloadedFile) {
            console.log(`[yt-dlp] Falling back to yt-dlp...`);

            const baseArgs = ['--no-warnings', '--no-check-certificates'];
            if (!isYouTube) {
                baseArgs.push('--add-header', 'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36');
            }

            // Metadata
            try {
                const metaArgs = ['--dump-json', ...baseArgs, '--', url];
                const jsonOutput = await runYtDlp(metaArgs);
                const info = JSON.parse(jsonOutput);
                title = info.title || info.fulltitle || title;
                duration = info.duration || duration;
            } catch (e) {
                console.warn(`[yt-dlp] Metadata failed: ${e.message?.substring(0, 100)}`);
            }

            // Download
            const dlArgs = ['-o', rawFile, '-f', 'b/best[height<=480]/best', '--no-part', ...baseArgs, '--', url];
            await runYtDlp(dlArgs);

            // Check for dynamic extension files
            if (!fs.existsSync(rawFile) || fs.statSync(rawFile).size === 0) {
                const files = fs.readdirSync(tempDir);
                const match = files.find(f => f.startsWith(`raw_${timestamp}`));
                if (match) downloadedFile = path.join(tempDir, match);
            } else {
                downloadedFile = rawFile;
            }
        }

        // ===== Verify we have a file =====
        if (!downloadedFile || !fs.existsSync(downloadedFile) || fs.statSync(downloadedFile).size === 0) {
            throw new Error('Failed to download media. The content may be unavailable, private, or region-locked.');
        }

        // ===== FFmpeg Compression =====
        const safeTitle = sanitizeFilename(title);
        const finalDownloadName = `${safeTitle}.${extension}`;
        const fileSize = fs.statSync(downloadedFile).size;
        const targetSize = Math.max(fileSize / 2, 500 * 1024);
        const targetBitrate = Math.floor((targetSize * 8) / Math.max(duration, 1));

        let ffmpegArgs;
        if (format === 'audio') {
            const abr = Math.max(targetBitrate, 32000);
            ffmpegArgs = ['-y', '-i', downloadedFile, '-b:a', `${abr}`, '-c:a', 'mp3', '-vn', finalFile];
        } else if (needsMerge && downloadedAudioFile) {
            // Merge separate video + audio streams
            const abr = 64000;
            const vbr = Math.max(targetBitrate - abr, 150000);
            ffmpegArgs = [
                '-y', '-i', downloadedFile, '-i', downloadedAudioFile,
                '-vf', 'scale=trunc(oh*a/2)*2:480',
                '-c:v', 'libx264', '-preset', 'fast', '-b:v', `${vbr}`,
                '-c:a', 'aac', '-b:a', `${abr}`,
                finalFile
            ];
        } else {
            const abr = 64000;
            const vbr = Math.max(targetBitrate - abr, 150000);
            ffmpegArgs = [
                '-y', '-i', downloadedFile,
                '-vf', 'scale=trunc(oh*a/2)*2:480',
                '-c:v', 'libx264', '-preset', 'fast', '-b:v', `${vbr}`,
                '-b:a', `${abr}`, '-c:a', 'aac',
                finalFile
            ];
        }

        await runFfmpeg(ffmpegArgs);

        if (!fs.existsSync(finalFile)) {
            throw new Error('FFmpeg processing produced no output file.');
        }

        // ===== Serve File =====
        console.log(`[Done] Serving: ${finalDownloadName}`);
        const encodedFilename = encodeURIComponent(finalDownloadName);
        res.setHeader('Content-Disposition', `attachment; filename="${encodedFilename}"; filename*=UTF-8''${encodedFilename}`);
        res.setHeader('X-Filename', encodedFilename);

        const fileStream = fs.createReadStream(finalFile);
        fileStream.pipe(res);
        fileStream.on('close', () => cleanup(downloadedFile, downloadedAudioFile, finalFile));

    } catch (err) {
        console.error('Error processing request:', err);
        cleanup(rawFile, audioFile, finalFile);

        let msg = err.message || 'Failed to process media';
        if (msg.includes('Video unavailable')) {
            msg = 'This video is unavailable, deleted, or private.';
        } else if (msg.includes('Sign in to confirm') || msg.includes('not a bot')) {
            msg = 'Unable to access this video. YouTube may be blocking cloud requests. Try a different video.';
        } else if (msg.includes('Requested format is not available')) {
            msg = 'No compatible format found for this content.';
        }
        res.status(500).json({ error: msg });
    }
});

app.listen(port, () => {
    console.log(`Production backend running on port ${port}`);
});
