import React, { useState } from 'react';
import { Link2, Music, Video, Download, Loader2, CheckCircle2, AlertCircle, Zap, Shield, HardDrive } from 'lucide-react';
import './index.css';

// Auto-detect environment backend URL (Vite environment variable or localhost fallback)
const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001';

function App() {
    const [url, setUrl] = useState('');
    const [format, setFormat] = useState('video'); // 'video' or 'audio'
    const [status, setStatus] = useState('idle'); // 'idle', 'loading', 'success', 'error'
    const [errorMessage, setErrorMessage] = useState('');

    const handleDownload = async () => {
        if (!url) {
            setErrorMessage('Please enter a valid URL');
            setStatus('error');
            return;
        }

        try {
            setStatus('loading');
            setErrorMessage('');

            // Send request to backend
            const response = await fetch(`${BACKEND_URL}/api/download`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ url, format }),
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || 'Download failed');
            }

            // Extract filename from custom X-Filename or Content-Disposition
            let filename = `download.${format === 'audio' ? 'mp3' : 'mp4'}`;
            const customFilename = response.headers.get('x-filename');
            const disposition = response.headers.get('content-disposition');

            if (customFilename) {
                try {
                    filename = decodeURIComponent(customFilename);
                } catch (e) {
                    filename = customFilename;
                }
            } else if (disposition) {
                const filenameStarRegex = /filename\*=UTF-8''([^;]+)/i;
                const starMatch = filenameStarRegex.exec(disposition);
                if (starMatch && starMatch[1]) {
                    try {
                        filename = decodeURIComponent(starMatch[1]);
                    } catch (e) {
                        filename = starMatch[1];
                    }
                } else {
                    const regularRegex = /filename="?([^";]+)"?/i;
                    const match = regularRegex.exec(disposition);
                    if (match && match[1]) {
                        try {
                            filename = decodeURIComponent(match[1]);
                        } catch (e) {
                            filename = match[1];
                        }
                    }
                }
            }

            // Handle file download in browser
            const blob = await response.blob();
            const downloadUrl = window.URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = downloadUrl;
            link.setAttribute('download', filename);
            document.body.appendChild(link);
            link.click();
            link.remove();
            window.URL.revokeObjectURL(downloadUrl);

            setStatus('success');

            // Reset after 3 seconds
            setTimeout(() => {
                setStatus('idle');
                setUrl('');
            }, 3000);

        } catch (err) {
            console.error(err);
            setStatus('error');
            setErrorMessage(err.message || 'An unexpected error occurred. Please try again.');
        }
    };

    return (
        <div className="app-container">
            <div className="glass-panel">
                <div className="header">
                    <h1>Meet - Social Media Downloader</h1>
                    <p>Extract media from anywhere with 50% size compression</p>
                </div>

                <div className="input-group">
                    <Link2 className="input-icon" size={20} />
                    <input
                        type="text"
                        className="url-input"
                        placeholder="Paste YouTube, Instagram, or Facebook link..."
                        value={url}
                        onChange={(e) => setUrl(e.target.value)}
                        disabled={status === 'loading'}
                    />
                </div>

                <div className="format-selector">
                    <button
                        className={`format-btn ${format === 'video' ? 'active' : ''}`}
                        onClick={() => setFormat('video')}
                        disabled={status === 'loading'}
                    >
                        <Video size={20} />
                        Video (480p)
                    </button>
                    <button
                        className={`format-btn ${format === 'audio' ? 'active' : ''}`}
                        onClick={() => setFormat('audio')}
                        disabled={status === 'loading'}
                    >
                        <Music size={20} />
                        Audio (MP3)
                    </button>
                </div>

                <button
                    className={`download-btn ${status === 'loading' ? 'loading' : ''}`}
                    onClick={handleDownload}
                    disabled={status === 'loading' || !url}
                >
                    {status === 'loading' ? (
                        <>
                            <Loader2 className="loader" size={24} />
                            Processing & Compressing...
                        </>
                    ) : (
                        <>
                            <Download size={24} />
                            Download & Compress
                        </>
                    )}
                </button>

                {status === 'error' && (
                    <div className="status-message error">
                        <AlertCircle size={20} />
                        {errorMessage}
                    </div>
                )}

                {status === 'success' && (
                    <div className="status-message success">
                        <CheckCircle2 size={20} />
                        Download complete! File saved to your device.
                    </div>
                )}

                <div className="features">
                    <div className="feature">
                        <Zap size={16} /> Fast Processing
                    </div>
                    <div className="feature">
                        <HardDrive size={16} /> 50% Less Space
                    </div>
                    <div className="feature">
                        <Shield size={16} /> 100% Secure
                    </div>
                </div>
            </div>
        </div>
    );
}

export default App;
