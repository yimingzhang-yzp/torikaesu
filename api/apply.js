// Vercel サーバーレス関数: POST /api/apply
// 申し込み受付。受付データを Google スプレッドシート（Apps Script Web App）へ転送する。
//
// 注意: Vercel のサーバーレス環境はファイルシステムが読み取り専用（/tmp 以外は永続化されない）
// ため、ローカル版（server/server.js）の applications.json への保存は行わない。
// 受付データの保存先は Google スプレッドシートが唯一の本番ストレージとなる。
//
// 必要な環境変数: GOOGLE_SHEETS_WEBHOOK
//   = Apps Script Web App の /exec URL（Vercelのプロジェクト設定で登録）
//   セットアップ手順は server/SHEETS_SETUP.md を参照。
import crypto from "node:crypto";

const GOOGLE_SHEETS_WEBHOOK = (process.env.GOOGLE_SHEETS_WEBHOOK || "").trim();
const GOOGLE_SHEETS_TIMEOUT_MS = 12000;

// ============ 簡易レート制限（IP単位・ベストエフォート） ============
const rateLimitMap = new Map();
const RL_WINDOW_MS = 60 * 1000;
const RL_MAX = 10;

function checkRateLimit(ip) {
  const now = Date.now();
  const entries = (rateLimitMap.get(ip) || []).filter(
    (t) => now - t < RL_WINDOW_MS,
  );
  if (entries.length >= RL_MAX) return false;
  entries.push(now);
  rateLimitMap.set(ip, entries);
  return true;
}

function validateEmailServer(email) {
  if (!email || typeof email !== "string") return false;
  if (email.length > 200) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function sanitizeString(value, maxLength) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, maxLength);
}

// Google スプレッドシートへ転送し、成否を返す。
// サーバーレスでは応答後にインスタンスが凍結されるため、必ず完了を await する。
async function forwardToGoogleSheets(entry) {
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    GOOGLE_SHEETS_TIMEOUT_MS,
  );
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
      console.warn(
        `Google Sheets forwarding failed: HTTP ${resp.status} (ref=${entry.referenceId})`,
      );
      return false;
    }
    let body;
    try {
      body = await resp.json();
    } catch (_) {
      body = null;
    }
    if (body && body.status === "ok") {
      console.log(`Google Sheets forwarded: ${entry.referenceId}`);
      return true;
    }
    console.warn(
      `Google Sheets forwarded but response unexpected: ${entry.referenceId} body=${JSON.stringify(body)}`,
    );
    return false;
  } catch (err) {
    clearTimeout(timeoutId);
    console.warn(
      `Google Sheets forwarding error (ref=${entry.referenceId}): ${err.message}`,
    );
    return false;
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method_not_allowed", message: "POSTのみ対応しています。" });
  }

  const ip =
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "unknown";

  if (!checkRateLimit(ip)) {
    return res.status(429).json({
      error: "rate_limit",
      message:
        "リクエストが多すぎます。しばらく時間をおいて再度お試しください。",
    });
  }

  const {
    email,
    name,
    phone,
    preferredContact,
    notes,
    diagnosisResult,
    diagnosisAnswers,
  } = req.body || {};

  if (!validateEmailServer(email)) {
    return res.status(400).json({
      error: "invalid_email",
      message: "有効なメールアドレスをご入力ください。",
    });
  }

  if (!GOOGLE_SHEETS_WEBHOOK) {
    console.error("GOOGLE_SHEETS_WEBHOOK が未設定のため受付を保存できません。");
    return res.status(500).json({
      error: "no_storage",
      message:
        "サーバー側で受付先の設定が完了していません。管理者にお問い合わせください。",
    });
  }

  const validContact = ["email", "phone", "either"];
  const contact = validContact.includes(preferredContact)
    ? preferredContact
    : "email";

  const referenceId = "app_" + crypto.randomBytes(6).toString("hex");

  const entry = {
    referenceId,
    timestamp: new Date().toISOString(),
    ip,
    email: email.trim().toLowerCase(),
    name: sanitizeString(name, 100),
    phone: sanitizeString(phone, 30),
    preferredContact: contact,
    notes: sanitizeString(notes, 2000),
    diagnosisResult: diagnosisResult || null,
    diagnosisAnswers: diagnosisAnswers || null,
    userAgent: sanitizeString(req.headers["user-agent"], 300),
  };

  console.log(
    `[${new Date().toISOString()}] APPLICATION ${referenceId} ` +
      `email=${entry.email} preferred=${contact} ` +
      `caseType=${(diagnosisAnswers && diagnosisAnswers.caseType) || "—"} ` +
      `amount=${(diagnosisAnswers && diagnosisAnswers.amount) || "—"}`,
  );

  const forwarded = await forwardToGoogleSheets(entry);
  if (!forwarded) {
    return res.status(502).json({
      error: "storage_error",
      message:
        "送信処理に失敗しました。お手数ですがメールで再度ご連絡ください。",
    });
  }

  return res.status(200).json({ status: "ok", referenceId });
}
