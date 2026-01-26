const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
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

// MySQL Connection Pool
const pool = mysql.createPool({
    host: 'localhost',
    port: 3306,
    user: 'u440148778_bloksi',
    password: 'A127456@a',
    database: 'u440148778_bloksi',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Initialize database table
async function initDatabase() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS subscriptions (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id VARCHAR(255) UNIQUE NOT NULL,
                user_email VARCHAR(255),
                user_name VARCHAR(255),
                plan VARCHAR(50) DEFAULT 'free',
                stripe_customer_id VARCHAR(255),
                stripe_subscription_id VARCHAR(255),
                subscription_status VARCHAR(50) DEFAULT 'active',
                daily_count INT DEFAULT 0,
                monthly_count INT DEFAULT 0,
                daily_reset_time BIGINT,
                monthly_reset_time BIGINT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_user_id (user_id),
                INDEX idx_stripe_customer (stripe_customer_id)
            )
        `);
        console.log('✅ Database table ready');
    } catch (error) {
        console.error('❌ Database init error:', error);
    }
}

initDatabase();

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
            const plan = session.metadata.plan;
            
            // Update database
            await pool.query(`
                INSERT INTO subscriptions (user_id, plan, stripe_customer_id, stripe_subscription_id, monthly_count, daily_count)
                VALUES (?, ?, ?, ?, 0, 0)
                ON DUPLICATE KEY UPDATE 
                    plan = ?,
                    stripe_customer_id = ?,
                    stripe_subscription_id = ?,
                    subscription_status = 'active',
                    monthly_count = 0,
                    daily_count = 0
            `, [userId, plan, session.customer, session.subscription, plan, session.customer, session.subscription]);
            
            console.log(`✅ User ${userId} upgraded to ${plan}`);
        }
        
        if (event.type === 'customer.subscription.deleted') {
            const subscription = event.data.object;
            await pool.query(`
                UPDATE subscriptions 
                SET subscription_status = 'canceled', plan = 'free'
                WHERE stripe_subscription_id = ?
            `, [subscription.id]);
            console.log(`❌ Subscription canceled: ${subscription.id}`);
        }
        
        res.json({ received: true });
    } catch (err) {
        console.error('Webhook error:', err);
        res.status(400).send(`Webhook Error: ${err.message}`);
    }
});

app.use(express.json());

// Plan limits
const PLAN_LIMITS = {
    free: { daily: 3, monthly: null },
    starter: { daily: null, monthly: 300 },
    pro: { daily: null, monthly: 700 },
    unlimited: { daily: null, monthly: null },
    yearly: { daily: null, monthly: null }
};

async function checkRateLimit(userId, userPlan = 'free') {
    const now = Date.now();
    const oneDayMs = 12 * 60 * 60 * 1000;
    const oneMonthMs = 30 * 24 * 60 * 60 * 1000;
    
    // Get or create user record
    const [rows] = await pool.query(
        'SELECT * FROM subscriptions WHERE user_id = ?',
        [userId]
    );
    
    let userRecord;
    if (rows.length === 0) {
        // Create new record
        await pool.query(`
            INSERT INTO subscriptions (user_id, plan, daily_count, monthly_count, daily_reset_time, monthly_reset_time)
            VALUES (?, ?, 0, 0, ?, ?)
        `, [userId, userPlan, now + oneDayMs, now + oneMonthMs]);
        
        userRecord = {
            daily_count: 0,
            monthly_count: 0,
            daily_reset_time: now + oneDayMs,
            monthly_reset_time: now + oneMonthMs,
            plan: userPlan
        };
    } else {
        userRecord = rows[0];
    }
    
    // Reset counters if needed
    let needsUpdate = false;
    if (now > userRecord.daily_reset_time) {
        userRecord.daily_count = 0;
        userRecord.daily_reset_time = now + oneDayMs;
        needsUpdate = true;
    }
    
    if (now > userRecord.monthly_reset_time) {
        userRecord.monthly_count = 0;
        userRecord.monthly_reset_time = now + oneMonthMs;
        needsUpdate = true;
    }
    
    if (needsUpdate) {
        await pool.query(`
            UPDATE subscriptions 
            SET daily_count = ?, monthly_count = ?, daily_reset_time = ?, monthly_reset_time = ?
            WHERE user_id = ?
        `, [userRecord.daily_count, userRecord.monthly_count, userRecord.daily_reset_time, userRecord.monthly_reset_time, userId]);
    }
    
    const limits = PLAN_LIMITS[userPlan];
    
    // Check limits
    if (limits.daily !== null && userRecord.daily_count >= limits.daily) {
        return { allowed: false, reason: 'daily_limit' };
    }
    
    if (limits.monthly !== null && userRecord.monthly_count >= limits.monthly) {
        return { allowed: false, reason: 'monthly_limit' };
    }
    
    // Increment counters
    await pool.query(`
        UPDATE subscriptions 
        SET daily_count = daily_count + 1, monthly_count = monthly_count + 1
        WHERE user_id = ?
    `, [userId]);
    
    return { 
        allowed: true, 
        remaining: {
            daily: limits.daily ? limits.daily - userRecord.daily_count - 1 : null,
            monthly: limits.monthly ? limits.monthly - userRecord.monthly_count - 1 : null
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
            messages: [{ role: "user", content: userMessage }]
        });
        return message.content[0].text;
    } catch (error) {
        console.error('Claude API Error:', error);
        throw new Error('AI service temporarily unavailable');
    }
}

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Get user usage stats - RETURNS CURRENT PLAN FROM DATABASE
app.post('/api/usage', async (req, res) => {
    try {
        const { userId, userPlan = 'free' } = req.body;
        
        const [rows] = await pool.query(
            'SELECT * FROM subscriptions WHERE user_id = ?',
            [userId]
        );
        
        if (rows.length === 0) {
            const limits = PLAN_LIMITS[userPlan];
            return res.json({
                plan: userPlan,
                dailyUsed: 0,
                monthlyUsed: 0,
                dailyLimit: limits.daily,
                monthlyLimit: limits.monthly
            });
        }
        
        const userRecord = rows[0];
        const limits = PLAN_LIMITS[userRecord.plan];
        
        res.json({
            plan: userRecord.plan, // This will be the ACTUAL plan from database
            dailyUsed: userRecord.daily_count,
            monthlyUsed: userRecord.monthly_count,
            dailyLimit: limits.daily,
            monthlyLimit: limits.monthly
        });
    } catch (error) {
        console.error('Usage stats error:', error);
        res.status(500).json({ error: 'Failed to fetch usage stats' });
    }
});

// Optimize Post
app.post('/api/optimize', async (req, res) => {
    try {
        const { post, options, userId, userPlan = 'free' } = req.body;
        
        if (!post || !post.trim()) {
            return res.status(400).json({ error: 'Post content is required' });
        }
        
        const limitCheck = await checkRateLimit(userId, userPlan);
        if (!limitCheck.allowed) {
            const message = limitCheck.reason === 'daily_limit' 
                ? 'Daily limit reached. Upgrade to get more uses!' 
                : 'Monthly limit reached. Upgrade for more uses!';
            return res.status(429).json({ error: message });
        }
        
        let userMessage = `Optimize this post for maximum X engagement:\n\n"${post}"\n\n`;
        
        if (options.postAngle && options.postAngle.trim()) {
            userMessage += `Post angle/goal: ${options.postAngle}\n\n`;
        }
        
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
        
        const limitCheck = await checkRateLimit(userId, userPlan);
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
        
        const limitCheck = await checkRateLimit(userId, userPlan);
        if (!limitCheck.allowed) {
            const message = limitCheck.reason === 'daily_limit' 
                ? 'Daily limit reached. Upgrade to get more uses!' 
                : 'Monthly limit reached. Upgrade for more uses!';
            return res.status(429).json({ error: message });
        }
        
        let userMessage = `Generate an engaging reply to this post:\n\n"${originalPost}"\n\n`;
        
        if (replyAngle && replyAngle.trim()) {
            userMessage += `CRITICAL INSTRUCTIONS FROM USER: "${replyAngle}"\n`;
            userMessage += `You MUST follow these instructions EXACTLY. If they say "1-2 lines", give MAXIMUM 2 sentences (120-180 characters). If they say "short", give 1-3 sentences max.\n\n`;
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
        
        let priceId;
        if (plan === 'starter') priceId = process.env.STRIPE_STARTER_PRICE_ID;
        else if (plan === 'pro') priceId = process.env.STRIPE_PRO_PRICE_ID;
        else if (plan === 'unlimited') priceId = process.env.STRIPE_UNLIMITED_PRICE_ID;
        else if (plan === 'yearly') priceId = process.env.STRIPE_YEARLY_PRICE_ID;
        else return res.status(400).json({ error: 'Invalid plan' });
        
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{ price: priceId, quantity: 1 }],
            mode: 'subscription',
            success_url: `${process.env.FRONTEND_URL}?success=true&plan=${plan}`,
            cancel_url: `${process.env.FRONTEND_URL}?canceled=true`,
            client_reference_id: userId,
            metadata: { userId, plan }
        });
        
        res.json({ url: session.url });
    } catch (error) {
        console.error('Stripe error:', error);
        res.status(500).json({ error: 'Failed to create checkout session' });
    }
});

// Create NOWPayments Crypto Checkout
app.post('/api/create-crypto-checkout', async (req, res) => {
    try {
        const { userId, plan } = req.body;
        
        let price;
        if (plan === 'starter') price = 4.99;
        else if (plan === 'pro') price = 9.99;
        else if (plan === 'unlimited') price = 19.99;
        else if (plan === 'yearly') price = 199.00;
        else return res.status(400).json({ error: 'Invalid plan' });
        
        const response = await fetch('https://api.nowpayments.io/v1/invoice', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': process.env.NOWPAYMENTS_API_KEY
            },
            body: JSON.stringify({
                price_amount: price,
                price_currency: 'usd',
                pay_currency: 'usdcsol',
                order_id: `${userId}_${plan}_${Date.now()}`,
                order_description: `Bloksi ${plan} plan`,
                success_url: `${process.env.FRONTEND_URL}?success=true&plan=${plan}`,
                cancel_url: `${process.env.FRONTEND_URL}?canceled=true`
            })
        });
        
        const data = await response.json();
        res.json({ url: data.invoice_url });
        
    } catch (error) {
        console.error('NOWPayments error:', error);
        res.status(500).json({ error: 'Failed to create crypto checkout' });
    }
});

// NOWPayments webhook
app.post('/api/nowpayments-webhook', express.json(), async (req, res) => {
    try {
        const payment = req.body;
        
        if (payment.payment_status === 'finished') {
            const orderId = payment.order_id;
            const [userId, plan] = orderId.split('_');
            
            await pool.query(`
                INSERT INTO subscriptions (user_id, plan, monthly_count, daily_count)
                VALUES (?, ?, 0, 0)
                ON DUPLICATE KEY UPDATE plan = ?, monthly_count = 0, daily_count = 0
            `, [userId, plan, plan]);
            
            console.log(`✅ Crypto payment successful for ${userId}, plan: ${plan}`);
        }
        
        res.status(200).send('OK');
    } catch (error) {
        console.error('Webhook error:', error);
        res.status(400).send('Webhook error');
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`📡 API available at http://localhost:${PORT}/api`);
    console.log(`🤖 Claude API configured: ${!!process.env.CLAUDE_API_KEY}`);
    console.log(`💳 Stripe configured: ${!!process.env.STRIPE_SECRET_KEY}`);
    console.log(`💎 NOWPayments configured: ${!!process.env.NOWPAYMENTS_API_KEY}`);
    console.log(`🗄️  MySQL connected`);
});
