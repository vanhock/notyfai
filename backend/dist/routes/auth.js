"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const supabase_js_1 = require("../lib/supabase.js");
const router = (0, express_1.Router)();
/**
 * POST /api/auth/otp/send
 * Request body: { email: string }
 * Sends a 6-digit OTP to the email via Supabase.
 * Configure the Magic Link email template in Supabase to include {{ .Token }} for OTP instead of a link.
 */
router.post("/otp/send", async (req, res) => {
    const email = typeof req.body?.email === "string" ? req.body.email.trim() : "";
    if (!email) {
        res.status(400).json({ error: "email is required" });
        return;
    }
    const supabase = (0, supabase_js_1.getSupabaseAuth)();
    const { error } = await supabase.auth.signInWithOtp({
        email,
        options: { shouldCreateUser: true },
    });
    if (error) {
        res.status(400).json({ error: error.message });
        return;
    }
    res.status(200).json({ message: "OTP sent to email" });
});
/**
 * POST /api/auth/otp/verify
 * Request body: { email: string, token: string }
 * Verifies the 6-digit OTP and returns the session (access_token, refresh_token, user).
 */
router.post("/otp/verify", async (req, res) => {
    const email = typeof req.body?.email === "string" ? req.body.email.trim() : "";
    const token = typeof req.body?.token === "string" ? req.body.token.trim() : "";
    if (!email || !token) {
        res.status(400).json({ error: "email and token are required" });
        return;
    }
    const supabase = (0, supabase_js_1.getSupabaseAuth)();
    const { data, error } = await supabase.auth.verifyOtp({
        email,
        token,
        type: "email",
    });
    if (error) {
        res.status(400).json({ error: error.message });
        return;
    }
    if (!data.session) {
        res.status(400).json({ error: "No session returned" });
        return;
    }
    res.status(200).json({
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_in: data.session.expires_in,
        user: data.user,
    });
});
exports.default = router;
