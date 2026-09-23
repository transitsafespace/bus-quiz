// ใช้ร่วมกันระหว่างหน้าผู้เล่นและหน้าผู้จัด
const OPTION_COLORS = ['#D93B4A', '#1F66D1', '#B67C00', '#1C8C57', '#7446C9', '#0B8585'];
const colorOf = (i) => OPTION_COLORS[i % OPTION_COLORS.length];

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// เวลาของเครื่องเราอาจไม่ตรงกับเซิร์ฟเวอร์ เลยเก็บค่าต่างไว้
let clockOffset = 0;
function syncClock(state) {
  if (state && state.serverNow) clockOffset = state.serverNow - Date.now();
}
const serverNow = () => Date.now() + clockOffset;

// วงนับถอยหลัง: ใส่ data-ends-at และ data-seconds ไว้ที่ element แล้ว loop นี้จะอัปเดตเอง
function timerHTML(endsAt, seconds, big) {
  const r = 44;
  const c = 2 * Math.PI * r;
  return `<div class="timer${big ? ' timer-big' : ''}" data-ends-at="${endsAt}" data-seconds="${seconds}" role="timer" aria-label="เวลาที่เหลือ">
    <svg viewBox="0 0 100 100" aria-hidden="true">
      <circle class="timer-bg" cx="50" cy="50" r="${r}"></circle>
      <circle class="timer-fg" cx="50" cy="50" r="${r}" stroke-dasharray="${c}" stroke-dashoffset="0"></circle>
    </svg>
    <span class="timer-num">${seconds}</span>
  </div>`;
}

const timeUpListeners = [];
const firedTimeUps = new Set();
function onTimeUp(fn) { timeUpListeners.push(fn); }

(function tick() {
  document.querySelectorAll('.timer[data-ends-at]').forEach((el) => {
    const endsAt = Number(el.dataset.endsAt);
    const total = Number(el.dataset.seconds) * 1000;
    const left = Math.max(0, endsAt - serverNow());
    const fg = el.querySelector('.timer-fg');
    const c = Number(fg.getAttribute('stroke-dasharray'));
    fg.setAttribute('stroke-dashoffset', String(c * (1 - left / total)));
    el.querySelector('.timer-num').textContent = String(Math.ceil(left / 1000));
    el.classList.toggle('is-low', left <= 5000);
    if (left === 0 && !firedTimeUps.has(endsAt)) {
      firedTimeUps.add(endsAt); // แจ้งครั้งเดียวต่อ 1 ข้อ แม้หน้าจอจะวาดใหม่
      timeUpListeners.forEach((fn) => fn());
    }
  });
  requestAnimationFrame(tick);
})();

// ผลเฉลย: ข้อ poll = กราฟแท่ง, ข้อ multi = เฉลย + คำอธิบาย
function revealHTML(question, reveal, myChoices) {
  const mine = myChoices || [];
  if (question.type === 'poll') {
    const max = Math.max(1, ...reveal.counts);
    const rows = question.options.map((o, i) => {
      const n = reveal.counts[i];
      const isTop = reveal.top.includes(i);
      return `<div class="bar-row${isTop ? ' is-top' : ''}">
        <div class="bar-label">
          <span class="swatch" style="--c:${colorOf(i)}">${i + 1}</span>
          <span>${esc(o)}</span>
          ${isTop ? '<span class="tag tag-top">ตอบมากที่สุด</span>' : ''}
          ${mine.includes(i) ? '<span class="tag">คุณเลือก</span>' : ''}
        </div>
        <div class="bar-track">
          <div class="bar-fill" style="--c:${colorOf(i)};--w:${(n / max) * 100}%"></div>
          <span class="bar-count">${n} คน</span>
        </div>
      </div>`;
    }).join('');
    return `<div class="bars">${rows}</div>
      <p class="reveal-note">ข้อนี้ไม่มีคำตอบผิด ทุกคนที่ตอบได้ 1 คะแนน (ตอบแล้ว ${reveal.answered} คน)</p>`;
  }

  return `<div class="results">` + question.options.map((o, i) => {
    const ok = reveal.correct.includes(i);
    const ex = reveal.explanations[i];
    return `<div class="result ${ok ? 'is-ok' : 'is-no'}">
      <div class="result-head">
        <span class="mark" aria-label="${ok ? 'ถูก' : 'ไม่ใช่'}">${ok ? '✓' : '✕'}</span>
        <span class="result-text">${esc(o)}</span>
        <span class="result-count">${reveal.counts[i]} คน</span>
      </div>
      ${mine.includes(i) ? '<span class="tag tag-mine">คุณเลือกข้อนี้</span>' : ''}
      ${ex ? `<div class="explain"><strong>${esc(ex.title)}</strong><p>${esc(ex.body)}</p></div>` : ''}
    </div>`;
  }).join('') + `</div>`;
}

function bonusHTML(reveal) {
  if (!reveal.bonus) return '<p class="bonus is-empty">ข้อนี้ไม่มีใครได้โบนัสความไว</p>';
  return `<p class="bonus">⚡ โบนัส +2 ได้แก่ <strong>${esc(reveal.bonus.name)}</strong> ตอบถูกไวที่สุด (${esc(reveal.bonus.seconds)} วินาที)</p>`;
}

function routeBadge(qIndex, total) {
  return `<span class="route">ข้อ <b>${qIndex + 1}</b>/${total}</span>`;
}
