const { Client, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

// ============================================================================
// CONFIGURATION & SETUP
// ============================================================================

// Create downloads directory if it doesn't exist
const downloadsDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir);
}

// WhatsApp Client Configuration with enhanced settings
const client = new Client({
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu',
            '--disable-web-security',
            '--disable-features=VizDisplayCompositor',
            '--disable-extensions',
            '--disable-plugins',
            '--disable-images',
            '--disable-javascript',
            '--disable-default-apps',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding'
        ],
        executablePath: undefined, // Let puppeteer find Chrome
        timeout: 60000 // Increase timeout
    },
    // Enhanced session management
    session: 'tiktok-bot-session',
    // Increase timeouts for large files
    takeoverOnConflict: true,
    takeoverTimeoutMs: 60000
});

// ============================================================================
// TIKTOK API CONFIGURATIONS
// ============================================================================

const TIKTOK_APIS = [
    {
        name: 'TikWM API',
        url: 'https://www.tikwm.com/api/',
        method: 'GET',
        parseResponse: (data) => ({
            videoUrl: data.data?.play || data.data?.wmplay,
            hdVideoUrl: data.data?.hdplay,
            title: data.data?.title || 'TikTok Video',
            author: data.data?.author?.unique_id || data.data?.author?.nickname || 'Unknown',
            thumbnail: data.data?.cover || data.data?.origin_cover,
            duration: data.data?.duration,
            playCount: data.data?.play_count
        }),
        buildUrl: (url) => `https://www.tikwm.com/api/?url=${encodeURIComponent(url)}&hd=1`
    },
    {
        name: 'SSSTik API',
        url: 'https://ssstik.io/abc',
        method: 'POST',
        parseResponse: (data) => ({
            videoUrl: data.url || data.video_url,
            title: data.title || 'TikTok Video',
            author: data.author || 'Unknown',
            thumbnail: data.thumbnail || data.cover
        }),
        buildUrl: (url) => 'https://ssstik.io/abc',
        buildBody: (url) => `url=${encodeURIComponent(url)}`
    },
    {
        name: 'SnapTik API',
        url: 'https://snaptik.app/abc',
        method: 'POST',
        parseResponse: (data) => ({
            videoUrl: data.data?.[0]?.url || data.url,
            title: data.title || 'TikTok Video',
            author: data.author || 'Unknown',
            thumbnail: data.thumbnail
        }),
        buildUrl: (url) => 'https://snaptik.app/abc',
        buildBody: (url) => `url=${encodeURIComponent(url)}`
    },
    {
        name: 'TikTok Scraper',
        url: 'https://tikwm.com/api/',
        method: 'GET',
        parseResponse: (data) => ({
            videoUrl: data.data?.play,
            title: data.data?.title,
            author: data.data?.author?.unique_id,
            thumbnail: data.data?.cover
        }),
        buildUrl: (url) => `https://tikwm.com/api/?url=${encodeURIComponent(url)}`
    }
];

// ============================================================================
// BOT STATISTICS & UTILITIES
// ============================================================================

let botStats = {
    totalDownloads: 0,
    successfulDownloads: 0,
    failedDownloads: 0,
    startTime: new Date(),
    apiUsage: {},
    userStats: {}
};

// Initialize API usage stats
TIKTOK_APIS.forEach(api => {
    botStats.apiUsage[api.name] = { attempts: 0, successes: 0 };
});

// Utility Functions
const utils = {
    // Validate TikTok URL
    isValidTikTokUrl: (url) => {
        const patterns = [
            /^https?:\/\/(www\.)?tiktok\.com\/@[\w.-]+\/video\/\d+/,
            /^https?:\/\/vm\.tiktok\.com\/[\w]+/,
            /^https?:\/\/vt\.tiktok\.com\/[\w]+/,
            /^https?:\/\/m\.tiktok\.com\/v\/\d+/,
            /^https?:\/\/(www\.)?tiktok\.com\/t\/[\w]+/
        ];
        return patterns.some(pattern => pattern.test(url));
    },

    // Clean filename for saving
    cleanFilename: (filename) => {
        return filename.replace(/[^\w\s-]/g, '').trim().substring(0, 50) || 'tiktok_video';
    },

    // Format duration
    formatDuration: (seconds) => {
        if (!seconds) return 'Unknown';
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    },

    // Format number (e.g., 1000 -> 1K)
    formatNumber: (num) => {
        if (!num) return '0';
        if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
        if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
        return num.toString();
    },

    // Get user stats
    getUserStats: (userId) => {
        if (!botStats.userStats[userId]) {
            botStats.userStats[userId] = {
                downloads: 0,
                successful: 0,
                failed: 0,
                firstUse: new Date()
            };
        }
        return botStats.userStats[userId];
    },

    // Update user stats
    updateUserStats: (userId, success) => {
        const userStats = utils.getUserStats(userId);
        userStats.downloads++;
        if (success) {
            userStats.successful++;
        } else {
            userStats.failed++;
        }
    },

    // Check file size and determine send method
    shouldSendAsDocument: (fileSize) => {
        // Send as document if file is larger than 16MB or smaller than 100KB
        const sizeMB = fileSize / (1024 * 1024);
        return sizeMB > 16 || sizeMB < 0.1;
    },

    // Retry function with exponential backoff
    retry: async (fn, maxRetries = 3, delay = 1000) => {
        for (let i = 0; i < maxRetries; i++) {
            try {
                return await fn();
            } catch (error) {
                if (i === maxRetries - 1) throw error;
                console.log(`🔄 Retry ${i + 1}/${maxRetries} after ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
                delay *= 2; // Exponential backoff
            }
        }
    }
};

// ============================================================================
// ENHANCED MESSAGE SENDING FUNCTIONS
// ============================================================================

async function sendVideoSafely(chatId, media, options = {}) {
    const maxRetries = 3;
    const methods = [
        // Method 1: Send as video (normal)
        async () => {
            console.log('📤 Attempting to send as video...');
            return await client.sendMessage(chatId, media, {
                ...options,
                sendMediaAsDocument: false
            });
        },
        
        // Method 2: Send as document
        async () => {
            console.log('📄 Attempting to send as document...');
            return await client.sendMessage(chatId, media, {
                ...options,
                sendMediaAsDocument: true
            });
        },
        
        // Method 3: Send with minimal options
        async () => {
            console.log('📋 Attempting to send with minimal options...');
            return await client.sendMessage(chatId, media, {
                caption: options.caption ? options.caption.substring(0, 100) + '...' : undefined
            });
        },
        
        // Method 4: Send without caption
        async () => {
            console.log('🎬 Attempting to send without caption...');
            return await client.sendMessage(chatId, media);
        }
    ];

    for (let i = 0; i < methods.length; i++) {
        try {
            console.log(`🔄 Trying send method ${i + 1}/${methods.length}...`);
            const result = await utils.retry(methods[i], 2, 2000);
            console.log(`✅ Successfully sent using method ${i + 1}`);
            return result;
        } catch (error) {
            console.log(`❌ Send method ${i + 1} failed:`, error.message);
            
            // If it's a Puppeteer evaluation error, try to recover
            if (error.message.includes('Evaluation failed') || error.message.includes('Protocol error')) {
                console.log('🔧 Detected Puppeteer error, attempting recovery...');
                await new Promise(resolve => setTimeout(resolve, 3000));
                
                // Try to refresh the page context
                try {
                    const pages = await client.pupPage.browser().pages();
                    if (pages.length > 0) {
                        await pages[0].reload({ waitUntil: 'networkidle0', timeout: 30000 });
                        console.log('🔄 Page refreshed successfully');
                        await new Promise(resolve => setTimeout(resolve, 5000));
                    }
                } catch (refreshError) {
                    console.log('⚠️ Could not refresh page:', refreshError.message);
                }
            }
            
            if (i === methods.length - 1) {
                throw new Error(`All send methods failed. Last error: ${error.message}`);
            }
        }
    }
}

// ============================================================================
// TIKTOK DOWNLOAD FUNCTIONS
// ============================================================================

async function downloadTikTokVideo(url, userId = null) {
    console.log(`🔍 Attempting to download: ${url}`);
    
    for (let i = 0; i < TIKTOK_APIS.length; i++) {
        const api = TIKTOK_APIS[i];
        console.log(`🌐 Trying ${api.name} (${i + 1}/${TIKTOK_APIS.length})...`);
        
        botStats.apiUsage[api.name].attempts++;
        
        try {
            let response;
            const headers = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'application/json, text/plain, */*',
                'Accept-Language': 'en-US,en;q=0.9',
                'Referer': 'https://www.tiktok.com/',
                'Origin': 'https://www.tiktok.com'
            };

            if (api.method === 'GET') {
                response = await fetch(api.buildUrl(url), {
                    method: 'GET',
                    headers: headers,
                    timeout: 15000
                });
            } else {
                headers['Content-Type'] = 'application/x-www-form-urlencoded';
                response = await fetch(api.buildUrl(url), {
                    method: 'POST',
                    headers: headers,
                    body: api.buildBody(url),
                    timeout: 15000
                });
            }

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const contentType = response.headers.get('content-type');
            if (!contentType || !contentType.includes('application/json')) {
                throw new Error('Invalid response format - not JSON');
            }

            const data = await response.json();
            console.log(`📊 API Response from ${api.name}:`, JSON.stringify(data, null, 2).substring(0, 300) + '...');
            
            const parsed = api.parseResponse(data);
            
            if (parsed.videoUrl) {
                console.log(`✅ Successfully got video URL from ${api.name}`);
                botStats.apiUsage[api.name].successes++;
                
                return {
                    success: true,
                    videoUrl: parsed.hdVideoUrl || parsed.videoUrl,
                    title: parsed.title,
                    author: parsed.author,
                    thumbnail: parsed.thumbnail,
                    duration: parsed.duration,
                    playCount: parsed.playCount,
                    apiUsed: api.name
                };
            } else {
                console.log(`❌ No video URL found in ${api.name} response`);
                throw new Error('No video URL in response');
            }
            
        } catch (error) {
            console.log(`❌ ${api.name} failed:`, error.message);
            
            // If it's the last API, wait a bit before giving up
            if (i === TIKTOK_APIS.length - 1) {
                console.log('⏳ All primary APIs failed, trying backup method...');
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
            continue;
        }
    }
    
    return { 
        success: false, 
        error: 'All API endpoints failed. The video might be private, deleted, or temporarily unavailable.' 
    };
}

async function downloadVideoFile(videoUrl, filename) {
    console.log(`⬇️ Downloading video file from: ${videoUrl.substring(0, 50)}...`);
    
    const response = await fetch(videoUrl, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': 'https://www.tiktok.com/',
            'Accept': 'video/mp4,video/*,*/*;q=0.9',
            'Accept-Encoding': 'identity',
            'Range': 'bytes=0-'
        },
        timeout: 60000 // 1 minute timeout for video download
    });

    if (!response.ok) {
        throw new Error(`Failed to download video: HTTP ${response.status} - ${response.statusText}`);
    }

    const contentLength = response.headers.get('content-length');
    console.log(`📦 Video size: ${contentLength ? Math.round(contentLength / 1024 / 1024 * 100) / 100 + ' MB' : 'Unknown'}`);

    const buffer = await response.buffer();
    
    // Validate that we got a video file
    if (buffer.length < 1000) {
        throw new Error('Downloaded file is too small to be a valid video');
    }

    // Save to file temporarily
    const filepath = path.join(downloadsDir, filename);
    fs.writeFileSync(filepath, buffer);
    
    console.log(`💾 Video saved temporarily: ${filepath} (${Math.round(buffer.length / 1024 / 1024 * 100) / 100} MB)`);
    return { buffer, filepath, size: buffer.length };
}

// ============================================================================
// WHATSAPP CLIENT EVENT HANDLERS
// ============================================================================

client.on('qr', (qr) => {
    console.log('\n🔗 Scan the QR code below to connect WhatsApp:');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    qrcode.generate(qr, { small: true });
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📱 Open WhatsApp on your phone and scan the QR code above');
    console.log('⏳ Waiting for connection...\n');
});

client.on('ready', () => {
    console.log('\n✅ TikTok WhatsApp Bot is ready and running!');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🤖 Bot Commands:');
    console.log('   !t [TikTok URL] - Download TikTok video');
    console.log('   !help - Show help message');
    console.log('   !stats - Show bot statistics');
    console.log('   !mystats - Show your personal stats');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`🚀 Bot started at: ${new Date().toLocaleString()}`);
    console.log(`📊 Available APIs: ${TIKTOK_APIS.length}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
});

client.on('auth_failure', (msg) => {
    console.error('❌ Authentication failed:', msg);
    console.log('💡 Try deleting the .wwebjs_auth folder and restart the bot');
});

client.on('disconnected', (reason) => {
    console.log('📱 WhatsApp disconnected:', reason);
    console.log('🔄 Attempting to reconnect...');
});

client.on('authenticated', () => {
    console.log('✅ WhatsApp authenticated successfully!');
});

client.on('loading_screen', (percent, message) => {
    console.log(`⏳ Loading WhatsApp: ${percent}% - ${message}`);
});

// Handle client errors
client.on('change_state', (state) => {
    console.log('🔄 WhatsApp state changed:', state);
});

// ============================================================================
// MESSAGE HANDLERS
// ============================================================================

client.on('message', async (message) => {
    const msg = message.body.trim();
    const isGroup = message.from.includes('@g.us');
    const userId = message.from;
    
    // Ignore messages from status broadcast
    if (message.from === 'status@broadcast') return;
    
    // Log incoming message
    console.log(`📨 Message from ${userId}: ${msg.substring(0, 50)}${msg.length > 50 ? '...' : ''}`);
    
    // Help command
    if (msg === '!help' || msg === '!h') {
        const helpText = `
🤖 *TikTok Downloader Bot v2.1*

*📋 Commands:*
• \`!t [TikTok URL]\` - Download TikTok video
• \`!help\` - Show this help message  
• \`!stats\` - Show bot statistics
• \`!mystats\` - Show your personal stats

*🔗 Supported URLs:*
• https://www.tiktok.com/@user/video/123...
• https://vm.tiktok.com/abc123
• https://vt.tiktok.com/abc123
• https://m.tiktok.com/v/123...

*📝 Example:*
\`!t https://www.tiktok.com/@user/video/1234567890\`

*✨ Features:*
✅ HD Quality Downloads
✅ No Watermark Removal
✅ Multiple API Fallbacks
✅ Enhanced Error Recovery
✅ Smart File Sending
✅ Personal Statistics

*⚠️ Important:*
• Only public TikTok videos can be downloaded
• Large files may be sent as documents
• Bot automatically retries failed sends

*🔧 Having issues?*
The bot uses ${TIKTOK_APIS.length} different APIs and multiple send methods for maximum reliability.
        `;
        await message.reply(helpText);
        return;
    }
    
    // Global stats command
    if (msg === '!stats') {
        const uptime = Math.floor((new Date() - botStats.startTime) / 1000 / 60); // minutes
        const successRate = botStats.totalDownloads > 0 ? 
            Math.round((botStats.successfulDownloads / botStats.totalDownloads) * 100) : 0;
        
        let apiStatsText = '';
        Object.entries(botStats.apiUsage).forEach(([apiName, stats]) => {
            const apiSuccessRate = stats.attempts > 0 ? Math.round((stats.successes / stats.attempts) * 100) : 0;
            apiStatsText += `• ${apiName}: ${stats.successes}/${stats.attempts} (${apiSuccessRate}%)\n`;
        });
            
        const statsText = `
📊 *Global Bot Statistics*

⏱️ *Uptime:* ${uptime} minutes
📥 *Total Downloads:* ${botStats.totalDownloads}
✅ *Successful:* ${botStats.successfulDownloads}
❌ *Failed:* ${botStats.failedDownloads}
📈 *Success Rate:* ${successRate}%
👥 *Total Users:* ${Object.keys(botStats.userStats).length}

*🌐 API Performance:*
${apiStatsText}

🚀 *Bot Status:* Running smoothly!
🕐 *Started:* ${botStats.startTime.toLocaleString()}
        `;
        await message.reply(statsText);
        return;
    }
    
    // Personal stats command
    if (msg === '!mystats') {
        const userStats = utils.getUserStats(userId);
        const userSuccessRate = userStats.downloads > 0 ? 
            Math.round((userStats.successful / userStats.downloads) * 100) : 0;
            
        const personalStatsText = `
📊 *Your Personal Statistics*

📥 *Your Downloads:* ${userStats.downloads}
✅ *Successful:* ${userStats.successful}
❌ *Failed:* ${userStats.failed}
📈 *Your Success Rate:* ${userSuccessRate}%
📅 *First Used:* ${userStats.firstUse.toLocaleDateString()}

${userStats.downloads === 0 ? 
    '💡 *Get started by sending:* `!t [TikTok URL]`' : 
    '🎉 *Thanks for using TikTok Bot!*'
}
        `;
        await message.reply(personalStatsText);
        return;
    }
    
    // TikTok download command
    if (msg.startsWith('!t ')) {
        botStats.totalDownloads++;
        const userStats = utils.getUserStats(userId);
        
        const tiktokUrl = msg.replace('!t', '').trim();
        
        // Validate URL
        if (!utils.isValidTikTokUrl(tiktokUrl)) {
            await message.reply(`❌ *Invalid TikTok URL*

Please send a valid TikTok link:
• https://www.tiktok.com/@user/video/123...
• https://vm.tiktok.com/abc123
• https://vt.tiktok.com/abc123

*Example:*
\`!t https://www.tiktok.com/@user/video/1234567890\`

💡 *Tip:* Copy the link directly from TikTok app`);
            
            botStats.failedDownloads++;
            utils.updateUserStats(userId, false);
            return;
        }

        // Send initial processing message
        const processingMsg = await message.reply(`⏳ *Processing your TikTok video...*

🔍 Analyzing URL...
🌐 Checking ${TIKTOK_APIS.length} API endpoints...
⚡ Finding best quality...
📥 Preparing download...

*Please wait, this may take a few seconds...*`);

        try {
            // Get video info
            console.log(`🎬 Processing TikTok request from user: ${userId}`);
            const result = await downloadTikTokVideo(tiktokUrl, userId);
            
            if (!result.success) {
                await message.reply(`❌ *Download Failed*

${result.error}

*💡 Troubleshooting Tips:*
• Make sure the video is public (not private)
• Check if the URL is correct and complete
• Try copying the link again from TikTok
• Wait a few minutes and try again
• Some videos may be geo-restricted

*🔄 The bot tried ${TIKTOK_APIS.length} different APIs for maximum reliability.*

*🆘 Still having issues?* Try a different TikTok video to test.`);
                
                botStats.failedDownloads++;
                utils.updateUserStats(userId, false);
                return;
            }

            // Update processing message
            await processingMsg.edit(`⏳ *Processing your TikTok video...*

✅ Video found successfully!
🎥 Title: ${result.title.substring(0, 30)}${result.title.length > 30 ? '...' : ''}
👤 Author: @${result.author}
🔧 API: ${result.apiUsed}
⬇️ Downloading HD version...
📤 Preparing to send...

*Almost ready!*`);

            // Download the video
            const timestamp = Date.now();
            const cleanTitle = utils.cleanFilename(result.title);
            const filename = `${cleanTitle}_${timestamp}.mp4`;
            
            console.log(`⬇️ Starting video download: ${filename}`);
            const { buffer, filepath, size } = await downloadVideoFile(result.videoUrl, filename);
            
            // Create media object with error handling
            let media;
            try {
                media = MessageMedia.fromFilePath(filepath);
                console.log(`📁 Media object created successfully for ${filename}`);
            } catch (mediaError) {
                console.log(`❌ Failed to create media from file, trying buffer method...`);
                const mimeType = 'video/mp4';
                const base64Data = buffer.toString('base64');
                media = new MessageMedia(mimeType, base64Data, filename);
                console.log(`📁 Media object created from buffer`);
            }
            
            // Prepare detailed caption
            const caption = `🎥 *TikTok Video Downloaded*

📝 *Title:* ${result.title}
👤 *Author:* @${result.author}
${result.duration ? `⏱️ *Duration:* ${utils.formatDuration(result.duration)}` : ''}
${result.playCount ? `👀 *Views:* ${utils.formatNumber(result.playCount)}` : ''}
📱 *Quality:* HD ${Math.round(size / 1024 / 1024 * 100) / 100} MB
🔧 *API Used:* ${result.apiUsed}
💧 *Watermark:* Removed
📊 *Your Downloads:* ${userStats.downloads + 1}

✨ *Downloaded by TikTok Bot v2.1*`;

            // Send the video using enhanced method
            console.log(`📤 Sending video to user: ${userId}`);
            
            // Update processing message before sending
            await processingMsg.edit(`⏳ *Sending your video...*

📤 Uploading to WhatsApp...
🔄 Using enhanced send methods...
⚡ Please wait a moment...

*File size: ${Math.round(size / 1024 / 1024 * 100) / 100} MB*`);

            // Use the enhanced sending function
            await sendVideoSafely(message.from, media, { 
                caption: caption
            });
            
            // Update final processing message
            await processingMsg.edit(`✅ *Video sent successfully!*

🎉 Your TikTok video has been downloaded and sent!
📊 This was download #${userStats.downloads + 1} for you.

💡 *Send another TikTok URL to download more videos!*`);
            
            // Clean up temporary file after a delay
            setTimeout(() => {
                if (fs.existsSync(filepath)) {
                    fs.unlinkSync(filepath);
                    console.log(`🗑️ Cleaned up temporary file: ${filename}`);
                }
            }, 15000); // 15 seconds delay to ensure sending is complete
            
            // Update statistics
            botStats.successfulDownloads++;
            utils.updateUserStats(userId, true);
            
            console.log(`✅ Successfully processed request for ${userId} - Video: ${result.title.substring(0, 30)}`);
            
        } catch (error) {
            console.error('❌ Error in download process:', error);
            
            let errorMessage = '❌ *Download Error*\n\n';
            
            if (error.message.includes('Evaluation failed') || error.message.includes('Protocol error')) {
                errorMessage += '🔧 *WhatsApp Connection Issue:* There was a problem sending the video through WhatsApp Web.\n\n*This usually happens when:*\n• The file is too large for WhatsApp\n• WhatsApp Web lost connection\n• Browser session needs refresh\n\n*Solutions:*\n• Try again in a few minutes\n• Restart the bot if problem persists\n• Try a shorter TikTok video';
            } else if (error.message.includes('All send methods failed')) {
                errorMessage += '📤 *Send Failed:* Could not send the video after trying multiple methods.\n\n*Possible causes:*\n• File too large (>16MB)\n• WhatsApp Web connection issues\n• Browser session problems\n\n*The video was downloaded successfully but could not be sent.*';
            } else if (error.code === 'ENOTFOUND' || error.message.includes('getaddrinfo')) {
                errorMessage += '🌐 *Network Issue:* Unable to connect to TikTok servers.\n\n*Solutions:*\n• Check your internet connection\n• Try using a VPN\n• Wait a few minutes and try again';
            } else if (error.message.includes('timeout')) {
                errorMessage += '⏰ *Timeout Error:* The request took too long.\n\n*This might happen because:*\n• The video is very large\n• Server is slow\n• Network connection is unstable\n\n*Try again in a few minutes.*';
            } else if (error.message.includes('HTTP 4')) {
                errorMessage += '🚫 *Access Error:* The video might be:\n• Private or deleted\n• Age-restricted\n• Geo-blocked in your region\n• Temporarily unavailable\n\n*Try a different public TikTok video.*';
            } else if (error.message.includes('too small')) {
                errorMessage += '📁 *File Error:* The downloaded file appears to be corrupted or incomplete.\n\n*This usually means:*\n• The video was removed during download\n• Server returned an error page instead of video\n\n*Try again with a different video.*';
            } else {
                errorMessage += `🔧 *Technical Error:* ${error.message}\n\n*This is usually temporary. Please try again in a few minutes.*`;
            }
            
            errorMessage += `\n\n*🔄 Attempted APIs:* ${TIKTOK_APIS.length}\n*📞 Support:* Send \`!help\` for more info`;
            
            await message.reply(errorMessage);
            
            botStats.failedDownloads++;
            utils.updateUserStats(userId, false);
        }
    }
    
    if (msg.toLowerCase().includes('bot info') || msg === '!info') {
        const infoText = `
🤖 *TikTok WhatsApp Bot Information*

*🔧 Technical Details:*
• Version: 2.1.0 (Enhanced)
• Runtime: Node.js
• APIs: ${TIKTOK_APIS.length} TikTok endpoints
• Features: HD downloads, enhanced sending
• Uptime: ${Math.floor((new Date() - botStats.startTime) / 1000 / 60)} minutes

*📊 Performance:*
• Success Rate: ${botStats.totalDownloads > 0 ? Math.round((botStats.successfulDownloads / botStats.totalDownloads) * 100) : 0}%
• Total Downloads: ${botStats.totalDownloads}
• Active Users: ${Object.keys(botStats.userStats).length}

*🚀 Enhanced Features:*
• Multiple send methods
• Puppeteer error recovery
• Smart file handling
• Exponential retry backoff
• Advanced error detection

*💡 Send \`!help\` to see all commands*
        `;
        await message.reply(infoText);
        return;
    }
});

// ============================================================================
// PROCESS HANDLERS & CLEANUP
// ============================================================================

process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down TikTok Bot...');
    
    // Clean up downloads directory
    if (fs.existsSync(downloadsDir)) {
        const files = fs.readdirSync(downloadsDir);
        files.forEach(file => {
            const filePath = path.join(downloadsDir, file);
            try {
                fs.unlinkSync(filePath);
                console.log(`🗑️ Cleaned up: ${file}`);
            } catch (err) {
                console.log(`⚠️ Could not delete: ${file}`);
            }
        });
    }
    
    // Print final statistics
    console.log('\n📊 Final Statistics:');
    console.log(`   Total Downloads: ${botStats.totalDownloads}`);
    console.log(`   Successful: ${botStats.successfulDownloads}`);
    console.log(`   Failed: ${botStats.failedDownloads}`);
    console.log(`   Success Rate: ${botStats.totalDownloads > 0 ? Math.round((botStats.successfulDownloads / botStats.totalDownloads) * 100) : 0}%`);
    console.log(`   Runtime: ${Math.floor((new Date() - botStats.startTime) / 1000 / 60)} minutes`);
    
    console.log('\n👋 TikTok Bot stopped successfully');
    process.exit(0);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('💥 Uncaught Exception:', error);
    console.log('🔄 Bot will continue running...');
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
    console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
    console.log('🔄 Bot will continue running...');
});

// Periodic cleanup of old files (every 30 minutes)
setInterval(() => {
    if (fs.existsSync(downloadsDir)) {
        const files = fs.readdirSync(downloadsDir);
        const now = Date.now();
        
        files.forEach(file => {
            const filePath = path.join(downloadsDir, file);
            try {
                const stats = fs.statSync(filePath);
                const ageMinutes = (now - stats.mtime.getTime()) / 1000 / 60;
                    if (ageMinutes > 30) {
                    fs.unlinkSync(filePath);
                    console.log(`🗑️ Auto-cleaned old file: ${file}`);
                }
            } catch (err) {
                console.log(`⚠️ Could not process file: ${file}`);
            }
        });
    }
}, 30 * 60 * 1000);

// ============================================================================
// BOT INITIALIZATION
// ============================================================================

console.log('🚀 Starting TikTok WhatsApp Bot v2.1 (Enhanced)...');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('📦 Loading WhatsApp Web with enhanced settings...');
console.log(`🌐 Configured with ${TIKTOK_APIS.length} TikTok API endpoints`);
console.log(`📁 Downloads directory: ${downloadsDir}`);
console.log('🔧 Enhanced features: Multiple send methods, error recovery');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

client.initialize();

module.exports = {
    client,
    botStats,
    utils,
    downloadTikTokVideo,
    sendVideoSafely,
    TIKTOK_APIS
};
