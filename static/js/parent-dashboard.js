const API = "https://emalashira-primary-school.onrender.com";
let currentUser = null, children = [];

// ── Auth ──────────────────────────────────────────────────────
function logout() {
  sessionStorage.removeItem('currentUser');
  window.location.replace('login.html');
}

// ── Tab switching ─────────────────────────────────────────────
function switchTab(name, btn) {
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  btn.classList.add('active');
}

// ── Formatters ────────────────────────────────────────────────
function fmt(n)     { return 'KSh ' + Number(n || 0).toLocaleString(); }
function fmtDate(d) { return d ? new Date(d).toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' }) : '—'; }

// ── Load children from backend ────────────────────────────────
async function loadChildren() {
  const email = currentUser && currentUser.email;
  if (!email) {
    console.warn('loadChildren: no email on currentUser, skipping fetch');
    children = [];
    return;
  }
  try {
    const r = await fetch(`${API}/api/parent/children`, {
      headers: { 'X-User-Email': email }
    });
    if (r.ok) {
      children = await r.json();
      return;
    }
    const err = await r.json().catch(() => ({}));
    console.warn('Could not load children, status:', r.status, err.message || '');
  } catch (e) {
    console.warn('Network error loading children:', e);
  }
  children = [];
}

// ── Build child-selector buttons for each tab ─────────────────
function buildSelectors() {
  document.getElementById('statChildren').textContent = children.length;

  ['grades', 'attendance', 'fees'].forEach(tab => {
    const el = document.getElementById(tab + 'ChildSelector');
    if (!el) return;

    if (!children.length) {
      el.innerHTML = '<p style="padding:1rem;color:#6b7280;">No children linked to your account. Please contact the school administrator.</p>';
      return;
    }

    // Warn about any children whose admission numbers didn't match a student record
    const unresolved = children.filter(ch => ch.id_resolved === false);
    if (unresolved.length) {
      const names = unresolved.map(ch => `${ch.name} (${ch.admissionNumber})`).join(', ');
      console.warn('Children not found in students table:', names);
    }

    el.innerHTML = children.map((c, i) =>
      `<button class="child-btn ${i === 0 ? 'active' : ''}"
        onclick="selectChild('${c.id}','${tab}',this)">
        ${c.name} (${c.class})
      </button>`
    ).join('');
  });
}

// ── Child selector click ──────────────────────────────────────
function selectChild(id, tab, btn) {
  document.querySelectorAll(`#${tab}ChildSelector .child-btn`).forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  if (tab === 'grades')     loadGrades(id);
  if (tab === 'attendance') loadAttendance(id);
  if (tab === 'fees')       loadFees(id);
}

// ── Grades ────────────────────────────────────────────────────
async function loadGrades(childId) {
  const tbody = document.getElementById('gradesBody');
  tbody.innerHTML = '<tr><td colspan="8" class="empty-cell">Loading...</td></tr>';

  // Hide summary banner while loading
  const banner = document.getElementById('gradesSummaryBanner');
  if (banner) banner.style.display = 'none';

  let data = [];
  try {
    const r = await fetch(`${API}/api/grades?student_id=${encodeURIComponent(childId)}`);
    if (r.ok) data = await r.json();
  } catch (e) { console.warn('Grades fetch failed:', e); }

  if (!data.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty-cell">No grades posted yet for this student.</td></tr>';
    document.getElementById('statAvgGrade').textContent = '—';
    return;
  }

  // ── Calculate this child's average ──
  const myAvg = parseFloat(
    (data.reduce((s, g) => s + (g.score || 0), 0) / data.length).toFixed(1)
  );
  document.getElementById('statAvgGrade').textContent = myAvg + '%';

  // ── Normalise rows ──
  const norm = data.map(g => ({
    subject:     g.subject      || '—',
    score:       g.score        ?? null,
    grade:       g.grade        || '—',
    performance: g.performance  || '—',
    term:        g.term         || '—',
    examType:    g.exam_type    || g.examType    || '—',
    teacherName: g.teacher_name || g.teacherName || '—',
    datePosted:  g.date_posted  || g.datePosted  || g.created_at || '',
  }));

  tbody.innerHTML = norm.map(g => `<tr>
    <td>${g.subject}</td>
    <td><strong>${g.score != null ? g.score + '%' : '—'}</strong></td>
    <td><span class="badge badge-${g.grade}">${g.grade}</span></td>
    <td><span class="badge badge-${g.performance.toLowerCase()}">${g.performance}</span></td>
    <td>${g.term}</td>
    <td>${g.examType}</td>
    <td>${g.teacherName}</td>
    <td>${fmtDate(g.datePosted)}</td>
  </tr>`).join('');

  // ── Work out this child's class from the children array ──
  const child     = children.find(c => c.id === childId);
  const childClass = child ? (child.class || child.studentClass || '—') : '—';

  // ── Update summary banner — show class straight away ──
  if (banner) {
    document.getElementById('summaryClass').textContent    = childClass;
    document.getElementById('summaryPosition').textContent = 'Calculating…';
    document.getElementById('summaryClassAvg').textContent = '…';
    document.getElementById('summaryClassSize').textContent = '…';
    banner.style.display = 'flex';
  }

  // ── Fetch all grades for every student in the same class to rank ──
  // We need all students in the class, then their grades
  try {
    // Step 1: get all students in this class
    const studRes = await fetch(
      `${API}/api/students?class=${encodeURIComponent(childClass)}`
    );
    if (!studRes.ok) throw new Error('students fetch failed');
    const classStudents = await studRes.json();
    const studentList   = Array.isArray(classStudents)
      ? classStudents
      : (classStudents.students || []);

    if (!studentList.length) throw new Error('no students returned');

    // Step 2: fetch grades for each student in parallel
    const allGradeResults = await Promise.all(
      studentList.map(async s => {
        try {
          const gr = await fetch(
            `${API}/api/grades?student_id=${encodeURIComponent(s.id)}`
          );
          if (!gr.ok) return { id: s.id, avg: 0 };
          const gdata = await gr.json();
          if (!gdata.length) return { id: s.id, avg: 0 };
          const avg = gdata.reduce((sum, g) => sum + (g.score || 0), 0) / gdata.length;
          return { id: s.id, avg: parseFloat(avg.toFixed(1)) };
        } catch {
          return { id: s.id, avg: 0 };
        }
      })
    );

    // Step 3: sort descending by average, find this child's rank
    allGradeResults.sort((a, b) => b.avg - a.avg);
    const rank       = allGradeResults.findIndex(r => r.id === childId) + 1;
    const classSize  = allGradeResults.length;
    const classAvg   = classSize > 0
      ? (allGradeResults.reduce((s, r) => s + r.avg, 0) / classSize).toFixed(1)
      : '—';

    // Step 4: ordinal suffix (1st, 2nd, 3rd …)
    const ordinal = (n) => {
      const s = ['th','st','nd','rd'];
      const v = n % 100;
      return n + (s[(v - 20) % 10] || s[v] || s[0]);
    };

    const posText = rank > 0
      ? `${ordinal(rank)} out of ${classSize}`
      : '—';

    document.getElementById('summaryPosition').textContent  = posText;
    document.getElementById('summaryClassAvg').textContent  = classAvg + '%';
    document.getElementById('summaryClassSize').textContent = classSize + ' student' + (classSize !== 1 ? 's' : '');

    // Colour-code the position tile: top 3 = gold/silver/bronze, rest = default
    const posTile = document.getElementById('summaryPosition');
    if (rank === 1) posTile.style.color = '#d97706';       // gold
    else if (rank === 2) posTile.style.color = '#6b7280';  // silver
    else if (rank === 3) posTile.style.color = '#92400e';  // bronze
    else posTile.style.color = '#1f2937';

  } catch (err) {
    // Position calculation not critical — show a graceful fallback
    console.warn('Could not calculate class position:', err);
    document.getElementById('summaryPosition').textContent  = 'N/A';
    document.getElementById('summaryClassAvg').textContent  = 'N/A';
    document.getElementById('summaryClassSize').textContent = 'N/A';
  }
}

// ── Attendance ────────────────────────────────────────────────
async function loadAttendance(childId) {
  const tbody = document.getElementById('attendanceBody');
  tbody.innerHTML = '<tr><td colspan="5" class="empty-cell">Loading...</td></tr>';
  let data = [];
  try {
    const r = await fetch(`${API}/api/attendance?student_id=${encodeURIComponent(childId)}`);
    if (r.ok) data = await r.json();
  } catch (e) { console.warn('Attendance fetch failed:', e); }

  if (!data.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty-cell">No attendance records found for this student.</td></tr>';
    document.getElementById('statAttendance').textContent = '—';
    return;
  }

  const present = data.filter(a => (a.status || '').toLowerCase() === 'present').length;
  document.getElementById('statAttendance').textContent = Math.round(present / data.length * 100) + '%';

  // Normalise backend snake_case fields
  const norm = data.map(a => ({
    date:        a.date           || '',
    status:      a.status         || '—',
    remarks:     a.remarks        || '—',
    teacherName: a.teacher_name   || a.teacherName || '—',
    class:       a.student_class  || a.class        || '—',
  }));

  tbody.innerHTML = norm.map(a => {
    const statusLower = (a.status || '').toLowerCase();
    return `<tr>
      <td>${fmtDate(a.date)}</td>
      <td>${a.class}</td>
      <td><span class="badge badge-${statusLower}">${a.status}</span></td>
      <td>${a.teacherName}</td>
      <td>${a.remarks}</td>
    </tr>`;
  }).join('');
}

// ── Fees ──────────────────────────────────────────────────────
async function loadFees(childId) {
  const tbody = document.getElementById('feesBody');
  tbody.innerHTML = '<tr><td colspan="6" class="empty-cell">Loading...</td></tr>';
  let data = [];
  try {
    const r = await fetch(`${API}/api/fees?student_id=${encodeURIComponent(childId)}`);
    if (r.ok) data = await r.json();
  } catch (e) { console.warn('Fees fetch failed:', e); }

  const total = data[0]?.total || 0;
  // Only count rows that are actual payments (have an id and amount > 0)
  const realPayments = data.filter(f => f.id && f.amount > 0);
  const paid    = realPayments.reduce((s, f) => s + (f.amount || 0), 0);
  const balance = Math.max(0, total - paid);

  document.getElementById('feeTotalAmt').textContent   = fmt(total);
  document.getElementById('feePaidAmt').textContent    = fmt(paid);
  document.getElementById('feeBalanceAmt').textContent = fmt(balance);
  document.getElementById('statBalance').textContent   = fmt(balance);

  if (!realPayments.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-cell">No payment records found for this student.</td></tr>';
    return;
  }

  tbody.innerHTML = realPayments.map(f => `<tr>
    <td>${fmtDate(f.date || f.created_at)}</td>
    <td>${f.term || '—'}</td>
    <td><strong>${fmt(f.amount)}</strong></td>
    <td>${f.method || '—'}</td>
    <td><code>${f.ref || f.reference || '—'}</code></td>
    <td><span class="badge badge-${(f.status || 'completed').toLowerCase()}">${f.status || 'Completed'}</span></td>
  </tr>`).join('');
}


// ── Payment Modal ─────────────────────────────────────────────
let payFeeData = {}; // { childId: { total, paid, balance } }

function openPayModal() {
  const overlay = document.getElementById('payModal');
  const sel = document.getElementById('payChildSelect');

  // Populate child selector
  sel.innerHTML = '<option value="">-- Select a child --</option>';
  children.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = `${c.name} (${c.class})`;
    sel.appendChild(opt);
  });

  // Reset fields
  document.getElementById('payAmount').value   = '';
  document.getElementById('payNotes').value    = '';
  document.getElementById('payError').style.display   = 'none';
  document.getElementById('paySuccess').style.display = 'none';
  document.getElementById('payFeeInfo').style.display    = 'none';
  document.getElementById('payBalanceZero').style.display = 'none';
  document.getElementById('payFormFields').style.display  = 'block';
  document.getElementById('paySubmitBtn').disabled = false;

  overlay.classList.add('open');
}

function closePayModal() {
  document.getElementById('payModal').classList.remove('open');
}

function handlePayOverlay(e) {
  if (e.target === document.getElementById('payModal')) closePayModal();
}

async function onPayChildChange() {
  const childId = document.getElementById('payChildSelect').value;
  if (!childId) {
    document.getElementById('payFeeInfo').style.display    = 'none';
    document.getElementById('payBalanceZero').style.display = 'none';
    document.getElementById('payFormFields').style.display  = 'block';
    return;
  }

  // Fetch fee data for this child
  try {
    const r = await fetch(`${API}/api/fees?student_id=${encodeURIComponent(childId)}`);
    const data = r.ok ? await r.json() : [];

    const total  = data[0]?.total || 0;
    const paid   = data.filter(p => p.id && p.amount).reduce((s, p) => s + (p.amount || 0), 0);
    const balance = Math.max(0, total - paid);

    payFeeData[childId] = { total, paid, balance };

    document.getElementById('payTotalFee').textContent   = fmt(total);
    document.getElementById('payPaidSoFar').textContent  = fmt(paid);
    document.getElementById('payBalance').textContent    = fmt(balance);
    document.getElementById('payFeeInfo').style.display  = 'flex';
    document.getElementById('payFeeInfo').style.flexDirection = 'column';

    if (balance <= 0 && total > 0) {
      document.getElementById('payBalanceZero').style.display = 'block';
      document.getElementById('payFormFields').style.display  = 'none';
      document.getElementById('paySubmitBtn').disabled = true;
    } else {
      document.getElementById('payBalanceZero').style.display = 'none';
      document.getElementById('payFormFields').style.display  = 'block';
      document.getElementById('paySubmitBtn').disabled = false;
      // Pre-fill amount with balance
      if (balance > 0) document.getElementById('payAmount').value = balance;
    }
  } catch (e) {
    console.warn('Fee fetch failed:', e);
  }
}

async function submitPayment() {
  const childId = document.getElementById('payChildSelect').value;
  const amount  = parseFloat(document.getElementById('payAmount').value);
  const method  = document.getElementById('payMethod').value;
  const term    = document.getElementById('payTerm').value;
  const notes   = document.getElementById('payNotes').value.trim();

  const errEl  = document.getElementById('payError');
  const succEl = document.getElementById('paySuccess');
  errEl.style.display  = 'none';
  succEl.style.display = 'none';

  if (!childId) { errEl.textContent = 'Please select a child.'; errEl.style.display = 'block'; return; }
  if (!amount || amount <= 0) { errEl.textContent = 'Please enter a valid amount.'; errEl.style.display = 'block'; return; }

  const btn = document.getElementById('paySubmitBtn');
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processing...';

  try {
    const res = await fetch(`${API}/api/fees/pay`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ student_id: childId, amount, method, term, notes, year: new Date().getFullYear() })
    });
    const data = await res.json();

    if (!res.ok) {
      errEl.textContent = data.message || 'Payment failed.';
      errEl.style.display = 'block';
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-paper-plane"></i> Submit Payment';
      return;
    }

    // Success
    succEl.innerHTML = `✅ Payment of <strong>${fmt(amount)}</strong> recorded!<br>
      Reference: <code>${data.reference}</code><br>
      New Balance: <strong>${fmt(data.balance)}</strong>`;
    succEl.style.display = 'block';
    btn.innerHTML = '<i class="fas fa-check"></i> Paid!';

    // Refresh fee display in fees tab after 1.5s then close
    setTimeout(async () => {
      await loadFees(childId);
      // Also refresh child selector active child if on fees tab
      const activeChildBtn = document.querySelector('#feesChildSelector .child-btn.active');
      if (!activeChildBtn) {
        // re-select first child in fees tab if already there
        const firstBtn = document.querySelector('#feesChildSelector .child-btn');
        if (firstBtn) firstBtn.click();
      }
      closePayModal();
    }, 2200);

  } catch (e) {
    errEl.textContent = 'Network error. Please try again.';
    errEl.style.display = 'block';
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-paper-plane"></i> Submit Payment';
  }
}

// ── Boot ──────────────────────────────────────────────────────
window.addEventListener('load', async () => {
  const raw = sessionStorage.getItem('currentUser');
  if (!raw) { logout(); return; }
  currentUser = JSON.parse(raw);

  // Always fetch fresh role from backend to heal stale localStorage sessions
  try {
    const res = await fetch(`${API}/api/profile?email=${encodeURIComponent(currentUser.email)}`);
    if (res.ok) {
      const fresh = await res.json();
      currentUser = { ...currentUser, id: fresh.id || currentUser.id, role: fresh.role };
      sessionStorage.setItem('currentUser', JSON.stringify(currentUser));
    }
  } catch (e) {
    console.warn('Could not refresh user from backend:', e);
  }

  if ((currentUser.role || '').toLowerCase() !== 'parent') {
    alert('Access denied. This portal is for parents only.');
    logout();
    return;
  }

  document.getElementById('userName').textContent    = currentUser.fullName || currentUser.email;
  document.getElementById('welcomeName').textContent = (currentUser.fullName || 'Parent').split(' ')[0];

  await loadChildren();
  buildSelectors();
  loadAnnouncements();

  if (children.length) {
    const firstId = children[0].id;
    loadGrades(firstId);
    loadAttendance(firstId);
    loadFees(firstId);
  } else {
    document.getElementById('gradesBody').innerHTML     = '<tr><td colspan="8" class="empty-cell">No children linked to your account.</td></tr>';
    document.getElementById('attendanceBody').innerHTML = '<tr><td colspan="4" class="empty-cell">No children linked to your account.</td></tr>';
    document.getElementById('feesBody').innerHTML       = '<tr><td colspan="6" class="empty-cell">No children linked to your account.</td></tr>';
    ['statAvgGrade', 'statAttendance', 'statBalance'].forEach(id => {
      document.getElementById(id).textContent = '—';
    });
  }
});
// ── Announcements ─────────────────────────────────────────────

// Convert plain text to paragraphs — respects double-newline and single-newline breaks
function annTextToHtml(text) {
  if (!text) return '';
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return escaped
    .split(/\n{2,}/)
    .map(para => `<p style="margin:0 0 0.75rem;line-height:1.75;color:#374151;">${para.replace(/\n/g,'<br>')}</p>`)
    .join('');
}

async function loadAnnouncements() {
  const container = document.getElementById('announcementsContainer');
  const countEl   = document.getElementById('annCount');
  if (!container) return;

  container.innerHTML = `<div style="text-align:center;padding:2rem;color:#9ca3af;">Loading announcements...</div>`;

  try {
    const res = await fetch(`${API}/api/announcements`);
    if (!res.ok) throw new Error('Failed to load');
    const list = await res.json();

    if (countEl) countEl.textContent = list.length ? `${list.length} announcement${list.length>1?'s':''}` : '';

    if (!list.length) {
      container.innerHTML = `
        <div style="text-align:center;padding:3rem 1rem;color:#9ca3af;">
          <i class="fas fa-bullhorn" style="font-size:2rem;display:block;margin-bottom:0.75rem;opacity:0.4;"></i>
          <p style="font-size:0.95rem;">No announcements yet. Check back later.</p>
        </div>`;
      return;
    }

    const priConfig = {
      normal: { dot: '#10b981', bg: '#d1fae5', color: '#065f46', label: 'Normal',  border: '#10b981' },
      high:   { dot: '#ef4444', bg: '#fee2e2', color: '#991b1b', label: 'High',    border: '#ef4444' },
      urgent: { dot: '#7c3aed', bg: '#ede9fe', color: '#5b21b6', label: 'Urgent',  border: '#7c3aed' }
    };

    container.innerHTML = '';
    list.forEach(a => {
      const pri  = priConfig[a.priority] || priConfig.normal;
      const date = a.created_at
        ? new Date(a.created_at).toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'})
        : '';
      const edited = a.updated_at
        ? ` · <span style="color:#d97706;">Edited ${new Date(a.updated_at).toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'})}</span>`
        : '';
      const audience = a.audience && a.audience !== 'all'
        ? `<span style="margin-left:0.25rem;"><i class="fas fa-users" style="margin-right:3px;"></i>${a.audience}</span>` : '';

      const card = document.createElement('div');
      card.style.cssText = [
        'background:#fff',
        'border:1px solid #e5e7eb',
        `border-left:4px solid ${pri.border}`,
        'border-radius:12px',
        'padding:1.25rem 1.4rem',
        'margin-bottom:1rem',
        'box-shadow:0 2px 8px rgba(0,0,0,0.05)',
        'transition:box-shadow 0.2s'
      ].join(';');
      card.onmouseenter = () => card.style.boxShadow = '0 4px 16px rgba(0,0,0,0.1)';
      card.onmouseleave = () => card.style.boxShadow = '0 2px 8px rgba(0,0,0,0.05)';

      card.innerHTML = `
        <!-- Title row -->
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:1rem;margin-bottom:0.5rem;flex-wrap:wrap;">
          <div style="font-size:1rem;font-weight:700;color:#1f2937;flex:1;">${a.title}</div>
          <span style="display:inline-flex;align-items:center;gap:5px;background:${pri.bg};color:${pri.color};
                       font-size:0.74rem;font-weight:700;padding:3px 11px;border-radius:20px;white-space:nowrap;flex-shrink:0;">
            <span style="width:7px;height:7px;border-radius:50%;background:${pri.dot};display:inline-block;"></span>
            ${pri.label}
          </span>
        </div>
        <!-- Meta row -->
        <div style="font-size:0.79rem;color:#9ca3af;margin-bottom:1rem;display:flex;flex-wrap:wrap;gap:0.4rem 0.75rem;align-items:center;">
          <span><i class="fas fa-user-shield" style="margin-right:3px;"></i>${a.author || 'School Admin'}${a.author_role ? ' ('+a.author_role+')' : ''}</span>
          <span style="color:#d1d5db;">·</span>
          <span><i class="fas fa-calendar-alt" style="margin-right:3px;"></i>${date}${edited}</span>
          ${audience ? `<span style="color:#d1d5db;">·</span>${audience}` : ''}
        </div>
        <!-- Body -->
        <div style="font-size:0.91rem;">${annTextToHtml(a.content)}</div>
      `;
      container.appendChild(card);
    });

  } catch(e) {
    container.innerHTML = `
      <div style="text-align:center;padding:2rem;color:#9ca3af;">
        <i class="fas fa-exclamation-circle" style="font-size:1.5rem;display:block;margin-bottom:0.5rem;"></i>
        <p>Could not load announcements. Please try again later.</p>
      </div>`;
  }
}

// ── Prevent browser back button from leaving the dashboard ────
// Push two states so there is always one to intercept
history.pushState({ page: 'parent-dashboard' }, '', window.location.href);
history.pushState({ page: 'parent-dashboard' }, '', window.location.href);

window.addEventListener('popstate', function (e) {
  // Push forward again so the back button never actually navigates away
  history.pushState({ page: 'parent-dashboard' }, '', window.location.href);
});









