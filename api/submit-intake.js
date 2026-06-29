// Vercel サーバーレス関数: POST /api/submit-intake
// ヒアリング＋連絡先を受け取り、受付番号を発行して Google スプレッドシートに即追加する（高速）。
// 訴状のAI生成は行わない（別途 /api/generate-complaint がバックグラウンドで実行）。
//
// 必要な環境変数: GOOGLE_SHEETS_WEBHOOK（Apps Script Web App の /exec URL）
import crypto from "node:crypto";

const GOOGLE_SHEETS_WEBHOOK = (process.env.GOOGLE_SHEETS_WEBHOOK || "").trim();
const GOOGLE_SHEETS_TIMEOUT_MS = 12000;

const rateLimitMap = new Map();
const RL_WINDOW_MS = 60 * 1000;
const RL_MAX = 10;
function checkRateLimit(ip) {
  const now = Date.now();
  const entries = (rateLimitMap.get(ip) || []).filter((t) => now - t < RL_WINDOW_MS);
  if (entries.length >= RL_MAX) return false;
  entries.push(now);
  rateLimitMap.set(ip, entries);
  return true;
}

function validateEmail(email) {
  if (!email || typeof email !== "string") return false;
  if (email.length > 200) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
function sanitize(value, maxLength) {
  if (value === null || value === undefined || typeof value !== "string") return null;
  const t = value.trim();
  return t.length === 0 ? null : t.slice(0, maxLength);
}

async function forwardToGoogleSheets(entry) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GOOGLE_SHEETS_TIMEOUT_MS);
  try {
    const resp = await fetch(GOOGLE_SHEETS_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entry),
      redirect: "follow",
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!resp.ok) {
      console.warn(`Sheets appendIntake failed: HTTP ${resp.status} (ref=${entry.referenceId})`);
      return false;
    }
    let body;
    try { body = await resp.json(); } catch (_) { body = null; }
    return !!(body && body.status === "ok");
  } catch (err) {
    clearTimeout(timeoutId);
    console.warn(`Sheets appendIntake error (ref=${entry.referenceId}): ${err.message}`);
    return false;
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method_not_allowed", message: "POSTのみ対応しています。" });
  }

  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "unknown";
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: "rate_limit", message: "リクエストが多すぎます。しばらく時間をおいて再度お試しください。" });
  }

  const { email, name, phone, preferredContact, notes, diagnosisAnswers } = req.body || {};
  if (!validateEmail(email)) {
    return res.status(400).json({ error: "invalid_email", message: "有効なメールアドレスをご入力ください。" });
  }
  if (!GOOGLE_SHEETS_WEBHOOK) {
    console.error("GOOGLE_SHEETS_WEBHOOK が未設定のため受付を保存できません。");
    return res.status(500).json({ error: "no_storage", message: "サーバー側で受付先の設定が完了していません。管理者にお問い合わせください。" });
  }

  const validContact = ["email", "phone", "either"];
  const contact = validContact.includes(preferredContact) ? preferredContact : "email";
  const referenceId = "app_" + crypto.randomBytes(6).toString("hex");

  const entry = {
    action: "appendIntake",
    referenceId,
    timestamp: new Date().toISOString(),
    ip,
    email: email.trim().toLowerCase(),
    name: sanitize(name, 100),
    phone: sanitize(phone, 30),
    preferredContact: contact,
    notes: sanitize(notes, 2000),
    diagnosisAnswers: diagnosisAnswers || null,
    status: "訴状生成中",
    userAgent: sanitize(req.headers["user-agent"], 300),
  };

  console.log(`[${new Date().toISOString()}] INTAKE ${referenceId} email=${entry.email} caseType=${(diagnosisAnswers && diagnosisAnswers.caseType) || "—"}`);

  const ok = await forwardToGoogleSheets(entry);
  if (!ok) {
    return res.status(502).json({ error: "storage_error", message: "受付処理に失敗しました。お手数ですが時間をおいて再度お試しください。" });
  }
  return res.status(200).json({ status: "ok", referenceId });
}
