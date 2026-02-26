"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireAuth = requireAuth;
const supabase_js_1 = require("@supabase/supabase-js");
async function requireAuth(req, res, next) {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabasePublishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token || !supabaseUrl || !supabasePublishableKey) {
        res.status(401).json({ error: "Unauthorized" });
        return;
    }
    const supabase = (0, supabase_js_1.createClient)(supabaseUrl, supabasePublishableKey);
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) {
        res.status(401).json({ error: "Invalid or expired token" });
        return;
    }
    res.locals.userId = user.id;
    res.locals.accessToken = token;
    next();
}
