const fs = require('fs');

async function testDownload(url, format, name) {
    console.log(`\nTesting ${name}: ${url} (format: ${format})`);
    try {
        const res = await fetch('http://localhost:3001/api/download', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, format })
        });
        
        if (!res.ok) {
            const err = await res.text();
            console.error(`❌ Failed: HTTP ${res.status} - ${err}`);
            return;
        }
        
        const filename = res.headers.get('x-filename') || 'test_download.mp4';
        console.log(`✅ Success! Received file: ${decodeURIComponent(filename)}`);
        console.log(`Content-Type: ${res.headers.get('content-type')}`);
        
        // We won't save the full file to avoid hanging the script, just check headers
        const reader = res.body.getReader();
        const { value, done } = await reader.read();
        console.log(`Received first chunk of ${value?.length || 0} bytes. Download is working!`);
        reader.cancel();
    } catch (e) {
        console.error(`❌ Error: ${e.message}`);
    }
}

async function runTests() {
    const ytUrl = 'https://www.youtube.com/watch?v=jNQXAC9IVRw'; // "Me at the zoo" (short video)
    const fbUrl = 'https://www.facebook.com/share/v/19NoXGKhYa/'; // User provided Facebook link
    
    await testDownload(ytUrl, 'video', 'YouTube Video');
    await testDownload(fbUrl, 'audio', 'Facebook Audio');
}

runTests();
