/**
 * Facebook video extractor using Playwright.
 * 
 * Facebook loads video URLs dynamically via XHR — there's nothing in the initial HTML.
 * We launch a headless Chromium browser, intercept network requests, and capture
 * the real video CDN URLs that the page fetches.
 */

const fs = require('fs');
const path = require('path');

// Parse Netscape cookies format into an array of Playwright cookie objects
function parseCookieString(cookieContent) {
    if (!cookieContent) return [];
    return cookieContent
        .split('\n')
        .filter(l => l && !l.startsWith('#') && l.includes('\t'))
        .map(l => {
            const p = l.trim().split('\t');
            if (p.length < 7) return null;
            return {
                domain: p[0],
                httpOnly: false,
                path: p[2],
                secure: p[3] === 'TRUE',
                expires: parseInt(p[4]) || -1,
                name: p[5],
                value: p[6] || '',
            };
        })
        .filter(Boolean);
}

// Helper to get cookies from either env var or local file
function getCookies() {
    // 1. Try env variable first (used in production)
    if (process.env.FB_COOKIES_BASE64) {
        try {
            const decoded = Buffer.from(process.env.FB_COOKIES_BASE64, 'base64').toString('utf8');
            return parseCookieString(decoded);
        } catch (e) {
            console.warn('[Facebook] Failed to decode FB_COOKIES_BASE64');
        }
    }
    
    // 2. Fallback to local file (used in dev)
    const fbCookiesFile = path.join(__dirname, 'facebook_cookies.txt');
    if (fs.existsSync(fbCookiesFile)) {
        const content = fs.readFileSync(fbCookiesFile, 'utf8');
        return parseCookieString(content);
    }
    
    return [];
}

/**
 * Use Playwright to intercept Facebook video CDN URLs.
 * Returns the best available video URL (HD preferred over SD).
 */
async function extractFacebookVideoUrl(pageUrl) {
    let playwright;
    try {
        playwright = require('playwright');
    } catch (e) {
        throw new Error('playwright not installed. Run: npm install playwright');
    }

    const browser = await playwright.chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    try {
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
            locale: 'en-US',
        });

        // Inject cookies so we're logged in
        const cookies = getCookies();
        if (cookies.length > 0) {
            await context.addCookies(cookies);
            console.log(`[Playwright] Injected ${cookies.length} cookies`);
        }

        const page = await context.newPage();

        // Collect all video/CDN URLs from network requests
        const capturedUrls = { hd: null, sd: null, audio: null, dash: null };

        page.on('request', request => {
            let url = request.url();
            if (!url.includes('fbcdn.net') && !url.includes('fbcdn.com')) return;

            // Strip range parameters so we get the full video, not a tiny chunk
            url = url.replace(/&bytestart=\d+/, '').replace(/&byteend=\d+/, '');

            if (url.includes('.mp4') || url.includes('video')) {
                const isAudio = url.includes('audio') || url.includes('mp4a');
                
                if (isAudio) {
                    if (!capturedUrls.audio) capturedUrls.audio = url;
                } else if (url.includes('_n.mp4') || url.includes('hd') || url.includes('1080p') || url.includes('720p')) {
                    if (!capturedUrls.hd) {
                        console.log('[Playwright] Captured HD Video URL:', url.substring(0, 100));
                        capturedUrls.hd = url;
                    }
                } else {
                    if (!capturedUrls.sd) {
                        console.log('[Playwright] Captured SD Video URL:', url.substring(0, 100));
                        capturedUrls.sd = url;
                    }
                }
            }
            if (url.includes('dash') || url.includes('.mpd')) {
                if (!capturedUrls.dash) capturedUrls.dash = url;
            }
        });

        // Also intercept responses to find video URLs in JSON payloads
        page.on('response', async response => {
            const url = response.url();
            if (!url.includes('graphql') && !url.includes('api/graphql')) return;
            try {
                const body = await response.text();
                // Look for playable_url in GraphQL responses
                const hdMatch = body.match(/"playable_url_quality_hd"\s*:\s*"([^"]+)"/);
                const sdMatch = body.match(/"playable_url"\s*:\s*"([^"]+)"/);
                if (hdMatch && !capturedUrls.hd) {
                    capturedUrls.hd = hdMatch[1].replace(/\\u0025/g, '%').replace(/\\\//g, '/');
                    console.log('[Playwright] GraphQL HD URL:', capturedUrls.hd.substring(0, 100));
                }
                if (sdMatch && !capturedUrls.sd) {
                    capturedUrls.sd = sdMatch[1].replace(/\\u0025/g, '%').replace(/\\\//g, '/');
                    console.log('[Playwright] GraphQL SD URL:', capturedUrls.sd.substring(0, 100));
                }
            } catch (e) { /* ignore non-text responses */ }
        });

        console.log('[Playwright] Navigating to:', pageUrl);
        try {
            await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        } catch (e) {
            // Navigation timeout is OK — we just need the page to start loading and fire requests
            if (!e.message?.includes('Timeout')) throw e;
            console.warn('[Playwright] Navigation timed out, continuing with captured data...');
        }

        // Wait for video requests to fire (Facebook loads video URLs asynchronously)
        await page.waitForTimeout(8000);

        // Also try scrolling/clicking to trigger video load if nothing captured yet
        if (!capturedUrls.hd && !capturedUrls.sd) {
            try {
                await page.mouse.click(640, 400);
                await page.waitForTimeout(3000);
            } catch (e) { /* ignore */ }
        }

        // Prioritize GraphQL responses because they are fully muxed (video+audio)
        // Network intercepts might be DASH chunks (video-only or audio-only)
        const result = capturedUrls.hd || capturedUrls.sd || capturedUrls.dash || null;
        console.log('[Playwright] Final result:', result ? 'URL captured ✓' : 'no URL found');
        return result;

    } finally {
        await browser.close();
    }
}

module.exports = { extractFacebookVideoUrl };
