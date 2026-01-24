const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
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

// Stripe webhook needs raw body
app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    
    try {
        const event = stripe.webhooks.constructEvent(
            req.body,
            sig,
            process.env.STRIPE_WEBHOOK_SECRET
        );
        
        if (event.type === 'checkout.session.completed') {
            const session = event.data.object;
            const userId = session.client_reference_id;
            const priceId = session.line_items?.data[0]?.price?.id;
            
            // Determine plan based on price ID
            let plan = 'free';
            if (priceId === process.env.STRIPE_STARTER_PRICE_ID) {
                plan = 'starter';
            } else if (priceId === process.env.STRIPE_PRO_PRICE_ID) {
                plan = 'pro';
            } else if (priceId === process.env.STRIPE_UNLIMITED_PRICE_ID) {
                plan = 'unlimited';
            }
            
            // Store this in your database
            // For now, just log it
            console.log(`User ${userId} upgraded to ${plan} plan`);
            
            // TODO: Update database with user's plan
        }
        
        res.json({ received: true });
    } catch (err) {
        console.error('Webhook error:', err);
        res.status(400).send(`Webhook Error: ${err.message}`);
    }
});

app.use(express.json());

// Simple in-memory usage tracking (replace with database in production)
const userUsage = new Map();

// Plan limits
const PLAN_LIMITS = {
    free: { daily: 3, monthly: null },
    starter: { daily: null, monthly: 100 },
    pro: { daily: null, monthly: 300 },
    unlimited: { daily: null, monthly: null }
};

function checkRateLimit(userId, userPlan = 'free') {
    const now = Date.now();
    const oneDayMs = 24 * 60 * 60 * 1000;
    const oneMonthMs = 30 * 24 * 60 * 60 * 1000;
    
    const userRecord = userUsage.get(userId) || { 
        dailyCount: 0, 
        monthlyCount: 0,
        dailyResetTime: now + oneDayMs,
        monthlyResetTime: now + oneMonthMs,
        plan: userPlan
    };
    
    // Reset daily counter if needed
    if (now > userRecord.dailyResetTime) {
        userRecord.dailyCount = 0;
        userRecord.dailyResetTime = now + oneDayMs;
    }
    
    // Reset monthly counter if needed
    if (now > userRecord.monthlyResetTime) {
        userRecord.monthlyCount = 0;
        userRecord.monthlyResetTime = now + oneMonthMs;
    }
    
    const limits = PLAN_LIMITS[userPlan];
    
    // Check limits based on plan
    if (limits.daily !== null && userRecord.dailyCount >= limits.daily) {
        return { allowed: false, reason: 'daily_limit' };
    }
    
    if (limits.monthly !== null && userRecord.monthlyCount >= limits.monthly) {
        return { allowed: false, reason: 'monthly_limit' };
    }
    
    // Increment counters
    userRecord.dailyCount++;
    userRecord.monthlyCount++;
    userRecord.plan = userPlan;
    userUsage.set(userId, userRecord);
    
    return { 
        allowed: true, 
        remaining: {
            daily: limits.daily ? limits.daily - userRecord.dailyCount : null,
            monthly: limits.monthly ? limits.monthly - userRecord.monthlyCount : null
        }
    };
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

// Get user usage stats
app.post('/api/usage', (req, res) => {
    const { userId, userPlan = 'free' } = req.body;
    const userRecord = userUsage.get(userId);
    const limits = PLAN_LIMITS[userPlan];
    
    if (!userRecord) {
        return res.json({
            plan: userPlan,
            dailyUsed: 0,
            monthlyUsed: 0,
            dailyLimit: limits.daily,
            monthlyLimit: limits.monthly
        });
    }
    
    res.json({
        plan: userPlan,
        dailyUsed: userRecord.dailyCount,
        monthlyUsed: userRecord.monthlyCount,
        dailyLimit: limits.daily,
        monthlyLimit: limits.monthly
    });
});

// Optimize Post
app.post('/api/optimize', async (req, res) => {
    try {
        const { post, options, userId, userPlan = 'free' } = req.body;
        
        if (!post || !post.trim()) {
            return res.status(400).json({ error: 'Post content is required' });
        }
        
        // Check rate limit
        const limitCheck = checkRateLimit(userId, userPlan);
        if (!limitCheck.allowed) {
            const message = limitCheck.reason === 'daily_limit' 
                ? 'Daily limit reached. Upgrade to get more uses!' 
                : 'Monthly limit reached. Upgrade for more uses!';
            return res.status(429).json({ error: message });
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
            success: true,
            remaining: limitCheck.remaining
        });
        
    } catch (error) {
        console.error('Optimize error:', error);
        res.status(500).json({ error: 'Failed to optimize post' });
    }
});

// Generate Thread
app.post('/api/generate-thread', async (req, res) => {
    try {
        const { topic, options, userId, userPlan = 'free' } = req.body;
        
        if (!topic || !topic.trim()) {
            return res.status(400).json({ error: 'Thread topic is required' });
        }
        
        const limitCheck = checkRateLimit(userId, userPlan);
        if (!limitCheck.allowed) {
            const message = limitCheck.reason === 'daily_limit' 
                ? 'Daily limit reached. Upgrade to get more uses!' 
                : 'Monthly limit reached. Upgrade for more uses!';
            return res.status(429).json({ error: message });
        }
        
        let userMessage = `Create a viral thread about:\n\n"${topic}"\n\n`;
        
        if (options.addHooks) userMessage += '- Include hooks throughout the thread\n';
        if (options.threadCliffhanger) userMessage += '- Use cliffhangers between tweets\n';
        
        userMessage += '\nGenerate a complete thread with proper numbering (1/, 2/, etc.).';
        
        const thread = await callClaude(threadGeneratorPrompt, userMessage);
        
        res.json({ 
            thread: thread.trim(),
            success: true,
            remaining: limitCheck.remaining
        });
        
    } catch (error) {
        console.error('Thread generation error:', error);
        res.status(500).json({ error: 'Failed to generate thread' });
    }
});

// Generate Reply
app.post('/api/generate-reply', async (req, res) => {
    try {
        const { originalPost, replyAngle, options, userId, userPlan = 'free' } = req.body;
        
        if (!originalPost || !originalPost.trim()) {
            return res.status(400).json({ error: 'Original post is required' });
        }
        
        const limitCheck = checkRateLimit(userId, userPlan);
        if (!limitCheck.allowed) {
            const message = limitCheck.reason === 'daily_limit' 
                ? 'Daily limit reached. Upgrade to get more uses!' 
                : 'Monthly limit reached. Upgrade for more uses!';
            return res.status(429).json({ error: message });
        }
        
        // BUILD USER MESSAGE - THIS IS THE PART YOU NEED TO UPDATE
        let userMessage = `Generate an engaging reply to this post:\n\n"${originalPost}"\n\n`;
        
        // If user provided specific angle/instructions, make it CRITICAL
        if (replyAngle && replyAngle.trim()) {
            userMessage += `CRITICAL INSTRUCTIONS: "${replyAngle}"\n`;
            userMessage += `You MUST follow these instructions EXACTLY, especially any length requirements like "1-2 lines", "short", "brief".\n\n`;
        }
        
        if (options.addValue) userMessage += '- Add genuine value to the conversation\n';
        if (options.avoidSpam) userMessage += '- Avoid spam signals\n';
        
        userMessage += '\nReturn ONLY the reply text, nothing else.';
        
        const reply = await callClaude(replyAssistantPrompt, userMessage);
        
        res.json({ 
            reply: reply.trim(),
            success: true,
            remaining: limitCheck.remaining
        });
        
    } catch (error) {
        console.error('Reply generation error:', error);
        res.status(500).json({ error: 'Failed to generate reply' });
    }
});

// Create Stripe Checkout Session
app.post('/api/create-checkout', async (req, res) => {
    try {
        const { userId, plan } = req.body;
        
        // Determine which price ID to use
        let priceId;
        if (plan === 'starter') {
            priceId = process.env.STRIPE_STARTER_PRICE_ID;
        } else if (plan === 'pro') {
            priceId = process.env.STRIPE_PRO_PRICE_ID;
        } else if (plan === 'unlimited') {
            priceId = process.env.STRIPE_UNLIMITED_PRICE_ID;
        } else {
            return res.status(400).json({ error: 'Invalid plan' });
        }
        
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [
                {
                    price: priceId,
                    quantity: 1,
                },
            ],
            mode: 'subscription',
            success_url: `${process.env.FRONTEND_URL}?success=true&session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${process.env.FRONTEND_URL}?canceled=true`,
            client_reference_id: userId,
            metadata: {
                userId: userId,
                plan: plan
            }
        });
        
        res.json({ url: session.url });
    } catch (error) {
        console.error('Stripe error:', error);
        res.status(500).json({ error: 'Failed to create checkout session' });
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`📡 API available at http://localhost:${PORT}/api`);
    console.log(`🤖 Claude API configured: ${!!process.env.CLAUDE_API_KEY}`);
    console.log(`💳 Stripe configured: ${!!process.env.STRIPE_SECRET_KEY}`);
});

