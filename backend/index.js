const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const { extractFacebookVideoUrl } = require('./fb_extractor');

// ===== FFmpeg Setup =====
function getFfmpegPath() {
    try {
        const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
        if (ffmpegInstaller && ffmpegInstaller.path && fs.existsSync(ffmpegInstaller.path)) {
            console.log(`[FFmpeg] Using binary at: ${ffmpegInstaller.path}`);
            return ffmpegInstaller.path;
        }
    } catch (e) { }
    return 'ffmpeg';
}

const ffmpegPath = getFfmpegPath();

// ===== Environment Setup =====
if (process.env.FB_COOKIES_BASE64) {
    try {
        const decoded = Buffer.from(process.env.FB_COOKIES_BASE64, 'base64').toString('utf8');
        fs.writeFileSync(path.join(__dirname, 'facebook_cookies.txt'), decoded, { encoding: 'utf8' });
        console.log('[Setup] Wrote FB_COOKIES_BASE64 to facebook_cookies.txt');
    } catch (e) {
        console.warn('[Setup] Failed to write FB_COOKIES_BASE64:', e.message);
    }
}
if (process.env.YT_COOKIES_BASE64) {
    try {
        const decoded = Buffer.from(process.env.YT_COOKIES_BASE64, 'base64').toString('utf8');
        fs.writeFileSync(path.join(__dirname, 'youtube_cookies.txt'), decoded, { encoding: 'utf8' });
        console.log('[Setup] Wrote YT_COOKIES_BASE64 to youtube_cookies.txt');
    } catch (e) {
        console.warn('[Setup] Failed to write YT_COOKIES_BASE64:', e.message);
    }
}

// ===== yt-dlp Helper =====
function runYtDlp(argsArray, timeoutMs = 0) {
    return new Promise((resolve, reject) => {
        const isWin = process.platform === 'win32';
        const cmd = isWin ? 'python' : 'python3';
        const fullArgs = ['-m', 'yt_dlp', ...argsArray];

        console.log(`[yt-dlp] Spawning: ${cmd} ${fullArgs.join(' ').substring(0, 150)}...`);
        const child = spawn(cmd, fullArgs, { shell: false });

        let stdout = '';
        let stderr = '';
        let killed = false;
        let timer = null;

        if (timeoutMs > 0) {
            timer = setTimeout(() => {
                killed = true;
                child.kill('SIGKILL');
                reject(new Error(`yt-dlp timed out after ${timeoutMs / 1000}s`));
            }, timeoutMs);
        }

        child.stdout.on('data', data => { stdout += data.toString(); });
        child.stderr.on('data', data => { stderr += data.toString(); });

        child.on('close', code => {
            if (timer) clearTimeout(timer);
            if (killed) return;
            if (code !== 0) {
                console.error(`[yt-dlp error] Code: ${code}, Stderr:`, stderr.substring(0, 300));
                return reject(new Error(stderr || stdout || `yt-dlp process exited with code ${code}`));
            }
            resolve(stdout);
        });

        child.on('error', err => {
            if (timer) clearTimeout(timer);
            if (!killed) reject(err);
        });
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

// ===== Temp Folder Cleanup Routine =====
// Runs every hour to clean up files older than 1 hour in case of crashes
setInterval(() => {
    try {
        const files = fs.readdirSync(tempDir);
        const now = Date.now();
        let deletedCount = 0;
        for (const file of files) {
            const filePath = path.join(tempDir, file);
            const stats = fs.statSync(filePath);
            const ageMs = now - stats.mtimeMs;
            if (ageMs > 60 * 60 * 1000) { // older than 1 hour
                fs.unlinkSync(filePath);
                deletedCount++;
            }
        }
        if (deletedCount > 0) {
            console.log(`[Cleanup] Deleted ${deletedCount} old temporary files`);
        }
    } catch (e) {
        console.warn(`[Cleanup] Failed: ${e.message}`);
    }
}, 60 * 60 * 1000);

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
        try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch (e) { }
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

    // Only try top 2 instances with a fast 2.5s timeout to avoid eating Render request budget
    for (const apiUrl of instances.slice(0, 2)) {
        try {
            console.log(`[Piped] Trying ${apiUrl}/streams/${videoId}...`);
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 2500);

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

app.get('/health', async (req, res) => {
    let ytDlpVersion = 'unknown';
    try {
        ytDlpVersion = await runYtDlp(['--version']);
        ytDlpVersion = ytDlpVersion.trim();
    } catch (e) { }

    const ytCookies = fs.existsSync(path.join(__dirname, 'youtube_cookies.txt'));
    const fbCookies = fs.existsSync(path.join(__dirname, 'facebook_cookies.txt'));

    res.json({
        status: 'ok',
        app_version: 'visionos-v1',
        yt_dlp_version: ytDlpVersion,
        youtube_cookies: ytCookies,
        facebook_cookies: fbCookies,
        time: new Date()
    });
});

app.get('/api/diag', async (req, res) => {
    const testUrl = req.query.url || 'https://youtu.be/q6qDYR0dSgc';
    const ytCookiesFile = path.join(__dirname, 'youtube_cookies.txt');
    const hasCookies = fs.existsSync(ytCookiesFile);
    let cookieStats = { exists: hasCookies };
    if (hasCookies) {
        try {
            const content = fs.readFileSync(ytCookiesFile, 'utf8');
            cookieStats.size = content.length;
            cookieStats.lines = content.split('\n').length;
            cookieStats.hasYoutube = content.includes('.youtube.com');
            cookieStats.hasConsent = content.includes('CONSENT');
        } catch (e) {
            cookieStats.error = e.message;
        }
    }

    const results = {};
    const tests = [
        { name: 'web_js_node', args: ['--js-runtimes', 'node', ...(hasCookies ? ['--cookies', ytCookiesFile] : []), '-s', testUrl] },
        { name: 'visionos', args: ['--extractor-args', 'youtube:player_client=visionos', ...(hasCookies ? ['--cookies', ytCookiesFile] : []), '-s', testUrl] },
        { name: 'tv', args: ['--extractor-args', 'youtube:player_client=tv', ...(hasCookies ? ['--cookies', ytCookiesFile] : []), '-s', testUrl] },
        { name: 'web_creator', args: ['--extractor-args', 'youtube:player_client=web_creator', ...(hasCookies ? ['--cookies', ytCookiesFile] : []), '-s', testUrl] },
        { name: 'mweb_js_node', args: ['--js-runtimes', 'node', '--extractor-args', 'youtube:player_client=mweb', ...(hasCookies ? ['--cookies', ytCookiesFile] : []), '-s', testUrl] }
    ];

    for (const t of tests) {
        if (!t.args) continue;
        try {
            const out = await runYtDlp(t.args, 10000);
            results[t.name] = { success: true, output: out.substring(0, 300) };
        } catch (e) {
            results[t.name] = { success: false, error: e.message.substring(0, 300) };
        }
    }

    res.json({ cookieStats, results });
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

            const isFacebook = /facebook\.com|fb\.watch/i.test(url);

            const baseArgs = ['--no-warnings', '--no-check-certificates'];
            baseArgs.push('--add-header', 'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36');

            const formatString = format === 'audio' ? 'ba/bestaudio/best' : 'bv*[height<=480]+ba/bv*[width<=480]+ba/bv*+ba/best';

            // Facebook: Use Playwright to intercept real CDN URLs for private/public videos
            if (isFacebook) {
                const fbCookiesFile = path.join(__dirname, 'facebook_cookies.txt');

                // Strategy 1: Playwright (captures CDN URLs from network requests, works for private videos if logged in)
                let playwrightSuccess = false;
                try {
                    console.log('[Facebook] Trying Playwright browser interception...');
                    const videoUrl = await extractFacebookVideoUrl(url);
                    if (videoUrl) {
                        console.log('[Facebook] ✓ CDN URL captured, downloading...');
                        await downloadStreamToFile(videoUrl, rawFile);
                        downloadedFile = rawFile;
                        title = 'facebook_video';
                        playwrightSuccess = true;
                        console.log('[Facebook] ✓ Download complete via Playwright');
                    } else {
                        console.warn('[Facebook] Playwright loaded page but found no video URL');
                    }
                } catch (e) {
                    console.warn(`[Facebook] Playwright error: ${e.message?.substring(0, 120)}`);
                }

                // Strategy 2: yt-dlp + cookies fallback
                if (!playwrightSuccess) {
                    console.log('[Facebook] Falling back to yt-dlp with cookies...');
                    const cookieArgs = fs.existsSync(fbCookiesFile) ? ['--cookies', fbCookiesFile] : [];
                    const mobileUrl = url.replace(/^(https?:\/\/)(?:www\.)?facebook\.com/, '$1m.facebook.com');
                    const urlsToTry = [url, ...(mobileUrl !== url ? [mobileUrl] : [])];

                    let dlError = null;
                    for (const tryUrl of urlsToTry) {
                        try {
                            console.log(`[Facebook] yt-dlp: ${tryUrl}`);
                            const dlArgs = ['-o', rawFile, '-f', formatString, '--no-part', ...baseArgs, ...cookieArgs, '--', tryUrl];
                            await runYtDlp(dlArgs);
                            dlError = null;
                            break;
                        } catch (e) {
                            console.warn(`[Facebook] yt-dlp failed: ${e.message?.substring(0, 100)}`);
                            dlError = e;
                        }
                    }
                    if (dlError) throw new Error('FACEBOOK_BROKEN');
                }
            } else if (isYouTube) {
                // YouTube yt-dlp fallback (Piped already failed above)
                // Use android client which reliably bypasses cloud datacenter IP blocks and SABR issues
                const ytCookiesFile = path.join(__dirname, 'youtube_cookies.txt');
                const hasCookies = fs.existsSync(ytCookiesFile);
                const cookieArgs = hasCookies ? ['--cookies', ytCookiesFile] : [];

                // Priority strategies for YouTube:
                // 1. visionos client: Bypasses cloud datacenter IP blocks and bot checks
                // 2. visionos + cookies
                // 3. web + cookies + node JS runtime
                // 4. android fallback
                const strategies = [
                    {
                        name: 'visionos',
                        args: ['--js-runtimes', 'node', '--extractor-args', 'youtube:player_client=visionos']
                    }
                ];

                if (hasCookies) {
                    strategies.push({
                        name: 'visionos+cookies',
                        args: [...cookieArgs, '--js-runtimes', 'node', '--extractor-args', 'youtube:player_client=visionos']
                    });
                    strategies.push({
                        name: 'web+cookies',
                        args: [...cookieArgs, '--js-runtimes', 'node', '--extractor-args', 'youtube:player_client=web']
                    });
                }

                strategies.push({
                    name: 'android',
                    args: ['--extractor-args', 'youtube:player_client=android']
                });

                let ytSuccess = false;
                for (const strat of strategies) {
                    try {
                        console.log(`[yt-dlp] Trying YouTube download (${strat.name})...`);
                        // CRITICAL: Must use --no-simulate when using --print, otherwise yt-dlp only simulates!
                        const dlArgs = [
                            '-o', rawFile, '-f', formatString, '--no-part',
                            '--no-simulate',
                            '--print', '%(title)s',
                            '--print', '%(duration)s',
                            ...baseArgs, ...strat.args, '--', url
                        ];
                        const output = await runYtDlp(dlArgs, 40000); // 40s timeout per attempt
                        ytSuccess = true;

                        // Parse title/duration from clean output lines (ignore warnings/progress)
                        const lines = output.trim().split('\n')
                            .map(l => l.trim())
                            .filter(l => l && !l.startsWith('WARNING:') && !l.startsWith('ERROR:') && !l.startsWith('['));

                        if (lines[0]) title = lines[0];
                        if (lines[1]) duration = parseFloat(lines[1]) || duration;

                        console.log(`[yt-dlp] ✓ YouTube download successful via ${strat.name}: "${title}" (duration: ${duration}s)`);
                        break;
                    } catch (e) {
                        console.warn(`[yt-dlp] YouTube (${strat.name}) failed: ${e.message?.substring(0, 100)}`);
                    }
                }

                if (!ytSuccess) {
                    throw new Error('Failed to extract any player response');
                }
            } else {
                // Non-Facebook, non-YouTube: standard yt-dlp path

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
                const dlArgs = ['-o', rawFile, '-f', formatString, '--no-part', ...baseArgs, '--', url];
                await runYtDlp(dlArgs);
            }

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
        } else if (msg.includes('Sign in to confirm') || msg.includes('not a bot') || msg.includes('403: Forbidden') || msg.includes('Failed to extract any player response')) {
            msg = 'YouTube is blocking requests from this server IP (common on Render/Vercel).\n\n' +
                'To fix this, you must provide YouTube cookies:\n' +
                '1. Use "Get cookies.txt LOCALLY" extension in Chrome on youtube.com\n' +
                '2. Export and convert the file contents to Base64\n' +
                '3. Add the Base64 string as "YT_COOKIES_BASE64" in your Render Environment Variables\n' +
                '4. Restart the server and try again.';
        } else if (msg.includes('Requested format is not available')) {
            msg = 'No compatible format found for this content.';
        } else if (msg === 'FACEBOOK_NEEDS_COOKIES' || msg.includes('Cannot parse data') || (msg.includes('facebook') && msg.includes('parse'))) {
            msg = 'Facebook requires login cookies to download videos.\n\n' +
                'To fix this:\n' +
                '1. Install the "Get cookies.txt LOCALLY" extension in Chrome or Edge\n' +
                '2. Go to facebook.com while logged in\n' +
                '3. Click the extension → Export → "facebook.com"\n' +
                '4. Save the file as "facebook_cookies.txt" in the backend folder\n' +
                '5. Restart the backend server and try again.';
        } else if (msg.includes('Private video') || msg.includes('private')) {
            msg = 'This video is private or requires a login to access.';
        }
        res.status(500).json({ error: msg });
    }
});

app.listen(port, () => {
    console.log(`Production backend running on port ${port}`);
});
