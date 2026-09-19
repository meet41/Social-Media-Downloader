const { extractFacebookVideoUrl } = require('./fb_extractor');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

async function test() {
    const cookiesFile = path.join(__dirname, 'facebook_cookies.txt');
    const testUrl = 'https://www.facebook.com/share/v/19NoXGKhYa/';
    
    console.log('Intercepting URL for:', testUrl);
    const videoUrl = await extractFacebookVideoUrl(testUrl, cookiesFile);
    console.log('Intercepted URL:', videoUrl);
    
    if (videoUrl) {
        console.log('Fetching first 1MB to check streams...');
        try {
            const res = await fetch(videoUrl, { headers: { 'Range': 'bytes=0-1048576' } });
            const buffer = await res.arrayBuffer();
            fs.writeFileSync('test_chunk.mp4', Buffer.from(buffer));
            
            console.log('Running ffprobe...');
            const ffprobe = spawn('node_modules\\@ffprobe-installer\\win32-x64\\ffprobe.exe', [
                '-v', 'error',
                '-show_entries', 'stream=codec_type',
                '-of', 'default=noprint_wrappers=1:nokey=1',
                'test_chunk.mp4'
            ]);
            
            ffprobe.stdout.on('data', data => console.log('Streams found:', data.toString().trim()));
            ffprobe.stderr.on('data', data => console.error('ffprobe error:', data.toString()));
            
        } catch (e) {
            console.error('Error:', e.message);
        }
    }
}
test();
