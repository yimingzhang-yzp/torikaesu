(function () {
  'use strict';

  // バックエンドAPIエンドポイント（同一オリジンのVercelサーバーレス関数 /api/apply）。
  // ローカル開発でExpressサーバー（server/）を使う場合は 'http://localhost:3000/api/apply' に変更するか、
  // `vercel dev` で静的配信とAPIを同一オリジンで起動する。
  const API_ENDPOINT = '/api/apply';
  const API_TIMEOUT_MS = 15000;

  const CASE_TYPE_LABELS = {
    deposit: '敷金・保証金の返還',
    freelance: '業務委託・フリーランスの未払い報酬',
    loan: '個人間の金銭貸借',
    online: 'ネット取引・フリマアプリ取引トラブル',
    wage: '給与・残業代の未払い',
    damage: '物品の損害・破損賠償',
    other: 'その他の金銭請求',
  };

  function init() {
    loadDiagnosisContext();

    const form = document.getElementById('applyForm');
    if (form) form.addEventListener('submit', handleSubmit);

    const retryBtn = document.getElementById('retryBtn');
    if (retryBtn) retryBtn.addEventListener('click', resetToForm);
  }

  function loadDiagnosisContext() {
    try {
      const storedResult = sessionStorage.getItem('lastDiagnosisResult');
      const storedAnswers = sessionStorage.getItem('lastDiagnosisAnswers');
      if (!storedResult && !storedAnswers) return;

      const result = storedResult ? JSON.parse(storedResult) : {};
      const answers = storedAnswers ? JSON.parse(storedAnswers) : {};

      const contextEl = document.getElementById('diagContext');
      const bodyEl = document.getElementById('diagContextBody');
      if (!contextEl || !bodyEl) return;

      const items = [];

      if (answers.caseType) {
        items.push({ label: '事件類型', value: CASE_TYPE_LABELS[answers.caseType] || answers.caseType });
      }
      if (typeof answers.amount === 'number') {
        items.push({ label: '請求金額', value: '¥' + answers.amount.toLocaleString('ja-JP') });
      }
      if (typeof result.score === 'number') {
        items.push({ label: '診断スコア', value: result.score + ' 点' });
      }
      if (result.verdict) {
        items.push({ label: 'AI判定', value: result.verdict, verdict: true });
      }
      if (typeof result.estimatedAmount === 'number' && result.estimatedAmount > 0) {
        items.push({ label: '予想手取り額', value: '¥' + result.estimatedAmount.toLocaleString('ja-JP') });
      }

      if (items.length === 0) return;

      bodyEl.innerHTML = '';
      items.forEach(function (it) {
        const row = document.createElement('div');
        row.className = 'diag-context-item';
        const lbl = document.createElement('span');
        lbl.className = 'diag-context-label';
        lbl.textContent = it.label;
        const val = document.createElement('span');
        val.className = 'diag-context-value' + (it.verdict ? ' verdict' : '');
        val.textContent = it.value;
        row.appendChild(lbl);
        row.appendChild(val);
        bodyEl.appendChild(row);
      });

      contextEl.hidden = false;
    } catch (e) {
      console.warn('診断内容の読み込みに失敗:', e);
    }
  }

  function validateEmail(email) {
    if (!email || typeof email !== 'string') return false;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  function clearErrors() {
    document.querySelectorAll('.form-error').forEach(function (el) {
      el.textContent = '';
      el.hidden = true;
    });
  }

  function showFieldError(fieldId, message) {
    const errEl = document.getElementById(fieldId);
    if (errEl) {
      errEl.textContent = message;
      errEl.hidden = false;
    }
  }

  function showGlobalError(message) {
    const errEl = document.getElementById('globalError');
    if (errEl) {
      errEl.textContent = message;
      errEl.hidden = false;
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    clearErrors();

    const form = e.target;
    const submitBtn = document.getElementById('submitBtn');

    const email = form.email.value.trim();
    const name = form.name.value.trim();
    const phone = form.phone.value.trim();
    const preferredContact = form.preferredContact.value;
    const notes = form.notes.value.trim();
    const consented = document.getElementById('privacyConsent').checked;

    // 検証
    if (!validateEmail(email)) {
      showFieldError('emailError', '有効なメールアドレスをご入力ください');
      form.email.focus();
      return;
    }
    if (!consented) {
      showGlobalError('プライバシーポリシーへの同意が必要です');
      return;
    }

    // Google広告のコンバージョン計測（送信ボタン押下＝検証通過時に着火）
    if (typeof gtag_report_conversion === 'function') {
      try { gtag_report_conversion(); } catch (_) {}
    }

    // 診断コンテキストを取得
    let diagnosisResult = null;
    let diagnosisAnswers = null;
    try {
      const storedResult = sessionStorage.getItem('lastDiagnosisResult');
      const storedAnswers = sessionStorage.getItem('lastDiagnosisAnswers');
      if (storedResult) diagnosisResult = JSON.parse(storedResult);
      if (storedAnswers) diagnosisAnswers = JSON.parse(storedAnswers);
    } catch (_) {}

    const payload = {
      email: email,
      name: name || null,
      phone: phone || null,
      preferredContact: preferredContact,
      notes: notes || null,
      diagnosisResult: diagnosisResult,
      diagnosisAnswers: diagnosisAnswers,
    };

    submitBtn.disabled = true;
    submitBtn.textContent = '送信中...';

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(function () { controller.abort(); }, API_TIMEOUT_MS);

      const resp = await fetch(API_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!resp.ok) {
        let detail = '';
        try {
          const body = await resp.json();
          detail = (body && body.message) ? body.message : ('HTTP ' + resp.status);
        } catch (_) {
          detail = 'HTTP ' + resp.status;
        }
        throw new Error(detail);
      }

      const result = await resp.json();
      showSuccess(result.referenceId || '受付済み');
      try {
        sessionStorage.removeItem('lastDiagnosisResult');
        sessionStorage.removeItem('lastDiagnosisAnswers');
      } catch (_) {}
    } catch (err) {
      console.error('送信失敗:', err);
      showFallback();
    }
  }

  function showSuccess(referenceId) {
    document.getElementById('formSection').hidden = true;
    const ctx = document.getElementById('diagContext');
    if (ctx) ctx.hidden = true;
    const successEl = document.getElementById('applySuccess');
    const refEl = document.getElementById('referenceId');
    if (refEl) refEl.textContent = referenceId;
    successEl.hidden = false;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function showFallback() {
    document.getElementById('formSection').hidden = true;
    document.getElementById('applyFallback').hidden = false;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function resetToForm() {
    document.getElementById('applyFallback').hidden = true;
    document.getElementById('formSection').hidden = false;
    const submitBtn = document.getElementById('submitBtn');
    submitBtn.disabled = false;
    submitBtn.textContent = '送信する →';
    clearErrors();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
