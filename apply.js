(function () {
  'use strict';

  // ヒアリング受付 → 訴状作成依頼。
  // 1) /api/submit-intake にヒアリング＋連絡先を送信（高速）。受付番号を得て「受付完了」を即表示。
  // 2) 受付完了後、裏で /api/generate-complaint を起動（UIはブロックしない）。失敗時は管理画面で再生成可能。
  var SUBMIT_ENDPOINT = '/api/submit-intake';
  var GENERATE_ENDPOINT = '/api/generate-complaint';
  var API_TIMEOUT_MS = 15000;

  var CASE_TYPE_LABELS = {
    loan: '個人間の金銭貸借', deposit: '敷金・保証金の返還', freelance: '業務委託・フリーランス報酬',
    online: 'ネット取引・フリマ', wage: '給与・残業代未払い', damage: '物品損害・賠償', other: 'その他の金銭請求',
  };

  function init() {
    loadHearingContext();
    var form = document.getElementById('applyForm');
    if (form) form.addEventListener('submit', handleSubmit);
    var retryBtn = document.getElementById('retryBtn');
    if (retryBtn) retryBtn.addEventListener('click', resetToForm);
  }

  function getAnswers() {
    try {
      var s = sessionStorage.getItem('lastDiagnosisAnswers');
      return s ? JSON.parse(s) : null;
    } catch (_) { return null; }
  }

  function loadHearingContext() {
    var answers = getAnswers();
    if (!answers) return;
    var contextEl = document.getElementById('diagContext');
    var bodyEl = document.getElementById('diagContextBody');
    if (!contextEl || !bodyEl) return;

    var items = [];
    if (answers.caseType) items.push({ label: '事件類型', value: CASE_TYPE_LABELS[answers.caseType] || answers.caseType });
    if (typeof answers.amount === 'number') items.push({ label: '請求金額', value: '¥' + answers.amount.toLocaleString('ja-JP') });
    if (answers.plaintiff && answers.plaintiff.name) items.push({ label: '原告（あなた）', value: answers.plaintiff.name });
    if (answers.defendantInfo && answers.defendantInfo.name) items.push({ label: '被告（相手方）', value: answers.defendantInfo.name });

    if (items.length === 0) return;
    bodyEl.innerHTML = '';
    items.forEach(function (it) {
      var row = document.createElement('div');
      row.className = 'diag-context-item';
      var lbl = document.createElement('span');
      lbl.className = 'diag-context-label';
      lbl.textContent = it.label;
      var val = document.createElement('span');
      val.className = 'diag-context-value';
      val.textContent = it.value;
      row.appendChild(lbl); row.appendChild(val);
      bodyEl.appendChild(row);
    });
    contextEl.hidden = false;
  }

  function validateEmail(email) {
    if (!email || typeof email !== 'string') return false;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  function clearErrors() {
    document.querySelectorAll('.form-error').forEach(function (el) { el.textContent = ''; el.hidden = true; });
  }
  function showFieldError(id, msg) { var el = document.getElementById(id); if (el) { el.textContent = msg; el.hidden = false; } }
  function showGlobalError(msg) { var el = document.getElementById('globalError'); if (el) { el.textContent = msg; el.hidden = false; } }

  async function handleSubmit(e) {
    e.preventDefault();
    clearErrors();
    var form = e.target;
    var submitBtn = document.getElementById('submitBtn');

    var email = form.email.value.trim();
    var preferredContact = form.preferredContact.value;
    var notes = form.notes.value.trim();
    var consented = document.getElementById('privacyConsent').checked;

    if (!validateEmail(email)) { showFieldError('emailError', '有効なメールアドレスをご入力ください'); form.email.focus(); return; }
    if (!consented) { showGlobalError('プライバシーポリシーへの同意が必要です'); return; }

    if (typeof gtag_report_conversion === 'function') { try { gtag_report_conversion(); } catch (_) {} }

    var diagnosisAnswers = getAnswers();
    // 氏名・電話はヒアリング（原告情報）から引き継ぐ（二重入力を避ける）
    var name = (diagnosisAnswers && diagnosisAnswers.plaintiff && diagnosisAnswers.plaintiff.name) || null;
    var phone = (diagnosisAnswers && diagnosisAnswers.plaintiff && diagnosisAnswers.plaintiff.phone) || null;

    var payload = {
      email: email, name: name || null, phone: phone || null,
      preferredContact: preferredContact, notes: notes || null,
      diagnosisAnswers: diagnosisAnswers,
    };

    submitBtn.disabled = true;
    submitBtn.textContent = '送信中...';

    try {
      var controller = new AbortController();
      var timeoutId = setTimeout(function () { controller.abort(); }, API_TIMEOUT_MS);
      var resp = await fetch(SUBMIT_ENDPOINT, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload), signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (!resp.ok) {
        var detail = '';
        try { var b = await resp.json(); detail = (b && b.message) ? b.message : ('HTTP ' + resp.status); } catch (_) { detail = 'HTTP ' + resp.status; }
        throw new Error(detail);
      }
      var result = await resp.json();
      var referenceId = result.referenceId || '受付済み';
      showSuccess(referenceId);
      // 受付完了を表示したうえで、裏で訴状生成を起動（UIはブロックしない）
      triggerGenerate(referenceId, diagnosisAnswers);
      try {
        sessionStorage.removeItem('lastDiagnosisAnswers');
        sessionStorage.removeItem('lastDiagnosisResult');
      } catch (_) {}
    } catch (err) {
      console.error('受付送信失敗:', err);
      showFallback();
    }
  }

  // 訴状生成をバックグラウンドで起動（応答は待たない＝ユーザーを待たせない）
  function triggerGenerate(referenceId, answers) {
    try {
      fetch(GENERATE_ENDPOINT, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true,
        body: JSON.stringify({ referenceId: referenceId, diagnosisAnswers: answers }),
      }).catch(function () { /* 失敗時は管理画面の「再生成」で復旧 */ });
    } catch (_) {}
  }

  function showSuccess(referenceId) {
    document.getElementById('formSection').hidden = true;
    var ctx = document.getElementById('diagContext');
    if (ctx) ctx.hidden = true;
    var successEl = document.getElementById('applySuccess');
    var refEl = document.getElementById('referenceId');
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
    var submitBtn = document.getElementById('submitBtn');
    submitBtn.disabled = false;
    submitBtn.textContent = 'この内容で訴状作成を依頼する →';
    clearErrors();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
