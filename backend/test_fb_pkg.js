const fbDownloader = require('@renpwn/fb-downloader');

async function test() {
    try {
        console.log('Testing @renpwn/fb-downloader...');
        const result = await fbDownloader('https://www.facebook.com/share/v/14nedEpC9HH/');
        console.log('Result:', JSON.stringify(result, null, 2));
    } catch (e) {
        console.error('Error:', e.message);
    }
}

test();
