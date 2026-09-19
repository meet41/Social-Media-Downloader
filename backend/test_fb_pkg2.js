const getFbVideoInfo = require('fb-video-downloader');

async function test() {
    try {
        console.log('Testing fb-video-downloader...');
        const result = await getFbVideoInfo('https://www.facebook.com/share/v/14nedEpC9HH/');
        console.log('Result:', JSON.stringify(result, null, 2));
    } catch (e) {
        console.error('Error:', e.message);
    }
}

test();
