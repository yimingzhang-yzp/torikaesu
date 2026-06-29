// Vercel サーバーレス関数: POST /api/admin
// 弁護士事務所向け管理画面のバックエンド。パスワード認証のうえ、案件一覧を返す。
// GAS の共有トークンはサーバー側のみで保持し、ブラウザには出さない。
//
// 必要な環境変数:
//   ADMIN_PASSWORD      … 管理画面ログイン用パスワード
//   ADMIN_SHARED_TOKEN  … GAS doGet 用の共有トークン（GASのScript Propertyと同値）
//   GOOGLE_SHEETS_WEBHOOK … Apps Script Web App の /exec URL

const GOOGLE_SHEETS_WEBHOOK = (process.env.GOOGLE_SHEETS_WEBHOOK || "").trim();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const ADMIN_SHARED_TOKEN = process.env.ADMIN_SHARED_TOKEN || "";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method_not_allowed", message: "POSTのみ対応しています。" });
  }

  const { password } = req.body || {};
  if (!ADMIN_PASSWORD) {
    return res.status(500).json({ error: "not_configured", message: "管理者パスワードが未設定です（ADMIN_PASSWORD）。" });
  }
  if (!password || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "unauthorized", message: "パスワードが正しくありません。" });
  }
  if (!GOOGLE_SHEETS_WEBHOOK || !ADMIN_SHARED_TOKEN) {
    return res.status(500).json({ error: "not_configured", message: "サーバー側の連携設定が未完了です（GOOGLE_SHEETS_WEBHOOK / ADMIN_SHARED_TOKEN）。" });
  }

  try {
    const url = GOOGLE_SHEETS_WEBHOOK + "?action=list&token=" + encodeURIComponent(ADMIN_SHARED_TOKEN);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000);
    const resp = await fetch(url, { method: "GET", redirect: "follow", signal: controller.signal });
    clearTimeout(timeoutId);
    const body = await resp.json();
    if (!body || body.status !== "ok") {
      return res.status(502).json({ error: "upstream_error", message: "一覧の取得に失敗しました。" });
    }
    return res.status(200).json({ status: "ok", items: body.items || [] });
  } catch (err) {
    console.error("admin list error:", err);
    return res.status(502).json({ error: "upstream_error", message: "一覧の取得に失敗しました。" });
  }
}
