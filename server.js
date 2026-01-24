const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
require('dotenv').config();

const { 
    postOptimizerPrompt, 
    threadGeneratorPrompt, 
    replyAssistantPrompt 
} = require('./prompts');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Claude
const anthropic = new Anthropic({
    apiKey: process.env.CLAUDE_API_KEY,
});

// Middleware
app.use(cors({
    origin: process.env.FRONTEND_URL || '*'
}));
app.use(express.json());

// Simple in-memory rate limiting (replace with Redis in production)
const userUsage = new Map();

function checkRateLimit(userId) {
    const now = Date.now();
    const userRecord = userUsage.get(userId) || { count: 0, resetTime: now + 3600000 }; // 1 hour
    
    if (now > userRecord.resetTime) {
        userRecord.count = 0;
        userRecord.resetTime = now + 3600000;
    }
    
    if (userRecord.count >= 3) {
        return false;
    }
    
    userRecord.count++;
    userUsage.set(userId, userRecord);
    return true;
}

// Helper function to call Claude
async function callClaude(systemPrompt, userMessage) {
    try {
        const message = await anthropic.messages.create({
            model: "claude-sonnet-4-20250514",
            max_tokens: 1024,
            system: systemPrompt,
            messages: [
                {
                    role: "user",
                    content: userMessage
                }
            ]
        });
        
        return message.content[0].text;
    } catch (error) {
        console.error('Claude API Error:', error);
        throw new Error('AI service temporarily unavailable');
    }
}

// API Routes

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Optimize Post
app.post('/api/optimize', async (req, res) => {
    try {
        const { post, options, userId } = req.body;
        
        if (!post || !post.trim()) {
            return res.status(400).json({ error: 'Post content is required' });
        }
        
        // Check rate limit
        if (!checkRateLimit(userId)) {
            return res.status(429).json({ 
                error: 'Rate limit exceeded. Upgrade to Pro for unlimited use.' 
            });
        }
        
        // Build user message with options
        let userMessage = `Optimize this post for maximum X engagement:\n\n"${post}"\n\n`;
        
        if (options.addHook) userMessage += '- Add an attention-grabbing hook\n';
        if (options.optimizeDwell) userMessage += '- Maximize dwell time\n';
        if (options.encourageReply) userMessage += '- Encourage replies\n';
        
        userMessage += '\nReturn ONLY the optimized post text, nothing else.';
        
        const optimizedPost = await callClaude(postOptimizerPrompt, userMessage);
        
        res.json({ 
            optimizedPost: optimizedPost.trim(),
            success: true 
        });
        
    } catch (error) {
        console.error('Optimize error:', error);
        res.status(500).json({ error: 'Failed to optimize post' });
    }
});

// Generate Thread
app.post('/api/generate-thread', async (req, res) => {
    try {
        const { topic, options, userId } = req.body;
        
        if (!topic || !topic.trim()) {
            return res.status(400).json({ error: 'Thread topic is required' });
        }
        
        if (!checkRateLimit(userId)) {
            return res.status(429).json({ 
                error: 'Rate limit exceeded. Upgrade to Pro for unlimited use.' 
            });
        }
        
        let userMessage = `Create a viral thread about:\n\n"${topic}"\n\n`;
        
        if (options.addHooks) userMessage += '- Include hooks throughout the thread\n';
        if (options.threadCliffhanger) userMessage += '- Use cliffhangers between tweets\n';
        
        userMessage += '\nGenerate a complete thread with proper numbering (1/, 2/, etc.).';
        
        const thread = await callClaude(threadGeneratorPrompt, userMessage);
        
        res.json({ 
            thread: thread.trim(),
            success: true 
        });
        
    } catch (error) {
        console.error('Thread generation error:', error);
        res.status(500).json({ error: 'Failed to generate thread' });
    }
});

// Generate Reply
app.post('/api/generate-reply', async (req, res) => {
    try {
        const { originalPost, replyAngle, options, userId } = req.body;
        
        if (!originalPost || !originalPost.trim()) {
            return res.status(400).json({ error: 'Original post is required' });
        }
        
        if (!checkRateLimit(userId)) {
            return res.status(429).json({ 
                error: 'Rate limit exceeded. Upgrade to Pro for unlimited use.' 
            });
        }
        
        let userMessage = `Generate an engaging reply to this post:\n\n"${originalPost}"\n\n`;
        
        if (replyAngle && replyAngle.trim()) {
            userMessage += `My perspective/angle: ${replyAngle}\n\n`;
        }
        
        if (options.addValue) userMessage += '- Add genuine value to the conversation\n';
        if (options.avoidSpam) userMessage += '- Avoid spam signals\n';
        
        userMessage += '\nReturn ONLY the reply text, nothing else.';
        
        const reply = await callClaude(replyAssistantPrompt, userMessage);
        
        res.json({ 
            reply: reply.trim(),
            success: true 
        });
        
    } catch (error) {
        console.error('Reply generation error:', error);
        res.status(500).json({ error: 'Failed to generate reply' });
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`📡 API available at http://localhost:${PORT}/api`);
    console.log(`🤖 Claude API configured: ${!!process.env.CLAUDE_API_KEY}`);
});