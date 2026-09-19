const { extractFacebookVideoUrl } = require('./fb_extractor');
const path = require('path');
const fs = require('fs');

async function test() {
    const cookiesFile = path.join(__dirname, 'facebook_cookies.txt');
    const testUrl = 'https://www.facebook.com/share/v/19NoXGKhYa/';
    
    console.log('Intercepting URL for:', testUrl);
    const videoUrl = await extractFacebookVideoUrl(testUrl, cookiesFile);
    console.log('Intercepted URL:', videoUrl);
    
    if (videoUrl) {
        console.log('Fetching first 100 bytes of the intercepted URL...');
        try {
            const res = await fetch(videoUrl, { headers: { 'Range': 'bytes=0-100' } });
            console.log('Status:', res.status, res.statusText);
            console.log('Content-Type:', res.headers.get('content-type'));
            const buffer = await res.arrayBuffer();
            console.log('Bytes:', Buffer.from(buffer).toString('hex'));
        } catch (e) {
            console.error('Fetch error:', e.message);
        }
    }
}
test();
