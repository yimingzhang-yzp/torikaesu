// トリカエス LP — インタラクション

document.addEventListener('DOMContentLoaded', function () {
  // FAQ アコーディオン
  var questions = document.querySelectorAll('.faq-q');
  questions.forEach(function (btn) {
    btn.addEventListener('click', function () {
      this.parentElement.classList.toggle('open');
    });
  });
});
