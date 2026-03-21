const API = "https://emalashira-primary-school.onrender.com";
let currentUser = null;
let allStudents  = [];   // from /api/fees/all  → {id, fullName, admissionNumber, studentClass, totalFee, paid, balance, status, term}
let allPayments  = [];   // from /api/fees/payments/all
let allStructures = [];  // from /api/fees/structure/all

// ── Auth ───────────────────────────────────────────────────────
function logout() {
  sessionStorage.removeItem('currentUser');
  window.location.href = 'login.html';
}

// ── Tab switching ──────────────────────────────────────────────
function switchTab(name, btn) {
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  btn.classList.add('active');
}

// ── Helpers ────────────────────────────────────────────────────
function fmt(n)     { return 'KSh ' + Number(n || 0).toLocaleString(); }
function fmtDate(d) { return d ? new Date(d).toLocaleDateString('en-GB', {day:'2-digit',month:'short',year:'numeric'}) : '—'; }
function statusPill(s) {
  const map = { Paid:'sp-paid', Partial:'sp-partial', Pending:'sp-pending', 'No Structure':'sp-none' };
  return `<span class="sp ${map[s]||'sp-none'}">${s||'—'}</span>`;
}

// ── Manual sync + reload (button click) ───────────────────────
async function syncAndReload() {
  const btn = document.getElementById('syncStudentsBtn');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Loading...';
  }
  try {
    // Fetch fresh student + fee data directly from the database
    const before = allStudents.length;
    await loadAll();
    const after  = allStudents.length;
    const diff   = after - before;
    showToast(
      diff > 0
        ? `✅ ${diff} new student(s) loaded from database`
        : `✅ ${after} student(s) refreshed from database`
    );
  } catch (e) {
    showToast('❌ Refresh failed — check server connection', true);
  } finally {
    if (btn) {
      btn.disabled  = false;
      btn.innerHTML = '<i class="fas fa-sync-alt"></i> Sync Students';
    }
  }
}


// Students now live solely in the students table — no cross-table sync needed.
async function syncStudents(silent = false) { return 0; }

// ── Toast helper ───────────────────────────────────────────────
function showToast(msg, isError = false) {
  let t = document.getElementById('finToast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'finToast';
    t.style.cssText = [
      'position:fixed', 'bottom:24px', 'right:24px',
      'padding:12px 20px', 'border-radius:10px', 'font-size:.9rem',
      'font-weight:600', 'z-index:99999', 'color:#fff',
      'box-shadow:0 4px 20px rgba(0,0,0,.2)',
      'transition:opacity .4s', 'max-width:340px', 'opacity:0'
    ].join(';');
    document.body.appendChild(t);
  }
  t.style.background = isError ? '#dc2626' : '#065f46';
  t.textContent = msg;
  t.style.opacity = '1';
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.style.opacity = '0'; }, 3500);
}

// ── Load all data ──────────────────────────────────────────────
async function loadAll() {
  try {
    const [r1, r2, r3] = await Promise.all([
      fetch(`${API}/api/fees/all`),
      fetch(`${API}/api/fees/payments/all`),
      fetch(`${API}/api/fees/structure/all`)
    ]);

    if (r1.ok) {
      const d = await r1.json();
      allStudents = d.students || [];
      document.getElementById('statCollected').textContent = fmt(d.totalCollected);
      document.getElementById('statArrears').textContent   = fmt(d.totalArrears);
      document.getElementById('statFullyPaid').textContent = d.fullyPaid;
      document.getElementById('statTotal').textContent     = d.totalStudents;
    }
    if (r2.ok) allPayments   = await r2.json();
    if (r3.ok) allStructures = await r3.json();
  } catch(e) {
    console.warn('Load error:', e);
  }

  renderOverview();
  renderPayments();
  renderStructure();
  renderArrears();
}

// ── OVERVIEW ───────────────────────────────────────────────────
function renderOverview() {
  const q      = (document.getElementById('overviewSearch')?.value || '').toLowerCase();
  const status = document.getElementById('overviewStatus')?.value  || '';
  const cls    = document.getElementById('overviewClass')?.value   || '';

  const rows = allStudents.filter(s =>
    (!q      || s.fullName.toLowerCase().includes(q) || (s.admissionNumber||'').toLowerCase().includes(q)) &&
    (!status || s.status === status) &&
    (!cls    || s.studentClass === cls)
  );

  const tbody = document.getElementById('overviewBody');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty-cell">No students found.</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(s => `
    <tr>
      <td><strong>${s.admissionNumber||'—'}</strong></td>
      <td>${s.fullName}</td>
      <td>${s.studentClass||'—'}</td>
      <td>${fmt(s.totalFee)}</td>
      <td style="color:#065f46;font-weight:600;">${fmt(s.paid)}</td>
      <td style="color:${s.balance>0?'#dc2626':'#065f46'};font-weight:600;">${fmt(s.balance)}</td>
      <td>${statusPill(s.status)}</td>
      <td>
        <div class="tbl-act">
          <button class="tbl-btn green" onclick="openRecordPayModal('${s.id}','${s.fullName.replace(/'/g,"\\'")}')">
            <i class="fas fa-plus"></i> Pay
          </button>
          <button class="tbl-btn amber" onclick="openSetFeeModal('${s.id}','${s.fullName.replace(/'/g,"\\'")}')">
            <i class="fas fa-sliders-h"></i> Set Fee
          </button>
        </div>
      </td>
    </tr>`).join('');
}

// ── PAYMENTS ───────────────────────────────────────────────────
function renderPayments() {
  const q      = (document.getElementById('paySearch')?.value || '').toLowerCase();
  const term   = document.getElementById('payTermFilter')?.value   || '';
  const method = document.getElementById('payMethodFilter')?.value || '';

  const rows = allPayments.filter(p =>
    (!q      || (p.fullName||'').toLowerCase().includes(q) || (p.reference||'').toLowerCase().includes(q) || (p.admissionNumber||'').toLowerCase().includes(q)) &&
    (!term   || p.term === term) &&
    (!method || p.method === method)
  );

  const tbody = document.getElementById('paymentsBody');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty-cell">No payment records found.</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(p => `
    <tr>
      <td>${fmtDate(p.created_at)}</td>
      <td>${p.admissionNumber||'—'}</td>
      <td>${p.fullName||'—'}</td>
      <td>${p.studentClass||'—'}</td>
      <td style="font-weight:700;color:#065f46;">${fmt(p.amount)}</td>
      <td>${p.method||'—'}</td>
      <td><code style="background:#f3f4f6;padding:2px 6px;border-radius:4px;font-size:.78rem;">${p.reference||'—'}</code></td>
      <td>${p.term||'—'}</td>
      <td>
        <button class="tbl-btn red" onclick="deletePayment('${p.id}','${(p.fullName||'').replace(/'/g,"\\'")}',${p.amount})">
          <i class="fas fa-trash"></i> Void
        </button>
      </td>
    </tr>`).join('');
}

// ── STRUCTURE ──────────────────────────────────────────────────
function renderStructure() {
  const q = (document.getElementById('structureSearch')?.value || '').toLowerCase();

  const rows = allStructures.filter(s =>
    !q || (s.fullName||'').toLowerCase().includes(q) || (s.admissionNumber||'').toLowerCase().includes(q)
  );

  const tbody = document.getElementById('structureBody');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-cell">No fee structures set yet. Use "Set / Update Fee" to add one.</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(s => `
    <tr>
      <td>${s.fullName||'—'}</td>
      <td>${s.admissionNumber||'—'}</td>
      <td>${s.studentClass||'—'}</td>
      <td>${s.term||'—'}</td>
      <td>${s.year||'—'}</td>
      <td style="font-weight:700;">${fmt(s.total_fee)}</td>
      <td>
        <button class="tbl-btn amber" onclick="openSetFeeModal('${s.student_id}','${(s.fullName||'').replace(/'/g,"\\'")}')">
          <i class="fas fa-edit"></i> Update
        </button>
      </td>
    </tr>`).join('');
}

// ── ARREARS ────────────────────────────────────────────────────
function renderArrears() {
  const q   = (document.getElementById('arrearsSearch')?.value || '').toLowerCase();
  const cls = document.getElementById('arrearsClass')?.value   || '';

  const rows = allStudents.filter(s =>
    s.balance > 0 &&
    (!q   || s.fullName.toLowerCase().includes(q) || (s.admissionNumber||'').toLowerCase().includes(q)) &&
    (!cls || s.studentClass === cls)
  ).sort((a,b) => b.balance - a.balance);

  const tbody = document.getElementById('arrearsBody');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-cell"><i class="fas fa-check-circle" style="color:#065f46;"></i> No arrears found. All fees are up to date!</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(s => `
    <tr>
      <td>${s.fullName}</td>
      <td>${s.admissionNumber||'—'}</td>
      <td>${s.studentClass||'—'}</td>
      <td>${fmt(s.totalFee)}</td>
      <td style="color:#065f46;font-weight:600;">${fmt(s.paid)}</td>
      <td style="color:#dc2626;font-weight:700;">${fmt(s.balance)}</td>
      <td>
        <button class="tbl-btn green" onclick="openRecordPayModal('${s.id}','${s.fullName.replace(/'/g,"\\'")}')">
          <i class="fas fa-plus"></i> Collect
        </button>
      </td>
    </tr>`).join('');
}

// ── Modal helpers ──────────────────────────────────────────────
function closeModal(id) {
  document.getElementById(id).classList.remove('open');
}
function handleFinOverlay(e, id) {
  if (e.target === document.getElementById(id)) closeModal(id);
}

// ── Autocomplete student search ────────────────────────────────
// prefix: 'rp' = record payment, 'sf' = set fee
function acSearch(prefix) {
  const q   = (document.getElementById(prefix + (prefix==='rp'?'StudentSearch':'StudentSearch'))?.value ||
               document.getElementById(prefix === 'rp' ? 'rpStudentSearch' : 'sfStudentSearch').value).toLowerCase();
  const dd  = document.getElementById(prefix === 'rp' ? 'rpDropdown' : 'sfDropdown');

  if (!q || q.length < 2) { dd.style.display = 'none'; return; }

  const matches = allStudents.filter(s =>
    s.fullName.toLowerCase().includes(q) || (s.admissionNumber||'').toLowerCase().includes(q)
  ).slice(0, 8);

  if (!matches.length) { dd.style.display = 'none'; return; }

  dd.innerHTML = matches.map(s =>
    `<div class="ac-item" onclick="acSelect('${prefix}','${s.id}','${s.fullName.replace(/'/g,"\\'")}','${s.admissionNumber||''}','${s.studentClass||''}')">
      <strong>${s.fullName}</strong> &nbsp;<span style="color:#9ca3af;font-size:.8rem;">${s.admissionNumber||''} · ${s.studentClass||''}</span>
    </div>`
  ).join('');
  dd.style.display = 'block';
}

function acSelect(prefix, id, name, admNo, cls) {
  const searchId = prefix === 'rp' ? 'rpStudentSearch' : 'sfStudentSearch';
  const hiddenId = prefix === 'rp' ? 'rpStudentId'     : 'sfStudentId';
  const infoId   = prefix === 'rp' ? 'rpStudentInfo'   : 'sfStudentInfo';
  const ddId     = prefix === 'rp' ? 'rpDropdown'      : 'sfDropdown';

  document.getElementById(searchId).value = name;
  document.getElementById(hiddenId).value = id;
  document.getElementById(ddId).style.display = 'none';

  const infoEl = document.getElementById(infoId);
  infoEl.textContent = `${name}  ·  ${admNo}  ·  ${cls}`;
  infoEl.style.display = 'block';

  // Pre-fill balance for record payment
  if (prefix === 'rp') {
    const student = allStudents.find(s => s.id === id);
    if (student && student.balance > 0) {
      document.getElementById('rpAmount').value = student.balance;
    }
  }
}

// ── Record Payment Modal ───────────────────────────────────────
function openRecordPayModal(preId, preName) {
  document.getElementById('rpStudentSearch').value = preName || '';
  document.getElementById('rpStudentId').value     = preId   || '';
  document.getElementById('rpAmount').value        = '';
  document.getElementById('rpRef').value           = '';
  document.getElementById('rpNotes').value         = '';
  document.getElementById('rpError').style.display   = 'none';
  document.getElementById('rpSuccess').style.display = 'none';
  document.getElementById('rpDropdown').style.display = 'none';
  document.getElementById('rpSubmitBtn').disabled  = false;
  document.getElementById('rpSubmitBtn').innerHTML = '<i class="fas fa-save"></i> Record Payment';

  const info = document.getElementById('rpStudentInfo');
  if (preId && preName) {
    const s = allStudents.find(x => x.id === preId);
    info.textContent = s ? `${preName}  ·  ${s.admissionNumber||''}  ·  ${s.studentClass||''} — Balance: ${fmt(s.balance)}` : preName;
    info.style.display = 'block';
    if (s && s.balance > 0) document.getElementById('rpAmount').value = s.balance;
  } else {
    info.style.display = 'none';
  }

  document.getElementById('recordPayModal').classList.add('open');
}

async function submitRecordPayment() {
  const studentId = document.getElementById('rpStudentId').value;
  const amount    = parseFloat(document.getElementById('rpAmount').value);
  const method    = document.getElementById('rpMethod').value;
  const term      = document.getElementById('rpTerm').value;
  const ref       = document.getElementById('rpRef').value.trim();
  const notes     = document.getElementById('rpNotes').value.trim();

  const errEl  = document.getElementById('rpError');
  const succEl = document.getElementById('rpSuccess');
  errEl.style.display = succEl.style.display = 'none';

  if (!studentId)           { errEl.textContent = 'Please select a student.';          errEl.style.display='block'; return; }
  if (!amount || amount<=0) { errEl.textContent = 'Please enter a valid amount.';       errEl.style.display='block'; return; }

  const btn = document.getElementById('rpSubmitBtn');
  btn.disabled  = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Recording...';

  try {
    const res = await fetch(`${API}/api/fees/pay`, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        student_id: studentId,
        amount, method, term,
        notes: notes || null,
        reference: ref || undefined,
        year: new Date().getFullYear()
      })
    });
    const data = await res.json();

    if (!res.ok) {
      errEl.textContent   = data.message || 'Failed to record payment.';
      errEl.style.display = 'block';
      btn.disabled  = false;
      btn.innerHTML = '<i class="fas fa-save"></i> Record Payment';
      return;
    }

    const student = allStudents.find(s => s.id === studentId);
    succEl.innerHTML =
      `✅ Payment of <strong>${fmt(amount)}</strong> recorded for <strong>${student?.fullName||''}</strong><br>` +
      `Reference: <code style="background:#d1fae5;padding:2px 6px;border-radius:4px;">${data.reference}</code> · ` +
      `New Balance: <strong>${fmt(data.balance)}</strong>`;
    succEl.style.display = 'block';
    btn.innerHTML = '<i class="fas fa-check"></i> Recorded!';

    // Refresh data and re-render
    await loadAll();
    setTimeout(() => closeModal('recordPayModal'), 2500);

  } catch(e) {
    errEl.textContent   = 'Network error. Please try again.';
    errEl.style.display = 'block';
    btn.disabled  = false;
    btn.innerHTML = '<i class="fas fa-save"></i> Record Payment';
  }
}

// ── Set Fee Structure Modal ─────────────────────────────────────
function openSetFeeModal(preId, preName) {
  document.getElementById('sfStudentSearch').value = preName || '';
  document.getElementById('sfStudentId').value     = preId   || '';
  document.getElementById('sfAmount').value        = '';
  document.getElementById('sfYear').value          = new Date().getFullYear();
  document.getElementById('sfScope').value         = preId ? 'single' : 'single';
  document.getElementById('sfError').style.display   = 'none';
  document.getElementById('sfSuccess').style.display = 'none';
  document.getElementById('sfDropdown').style.display = 'none';
  document.getElementById('sfSubmitBtn').disabled  = false;
  document.getElementById('sfSubmitBtn').innerHTML = '<i class="fas fa-save"></i> Save Fee Structure';
  toggleSfScope();

  const info = document.getElementById('sfStudentInfo');
  if (preId && preName) {
    const s = allStudents.find(x => x.id === preId);
    info.textContent = s ? `${preName}  ·  ${s.admissionNumber||''}  ·  ${s.studentClass||''}` : preName;
    info.style.display = 'block';
    // Pre-fill current fee if exists
    if (s && s.totalFee > 0) document.getElementById('sfAmount').value = s.totalFee;
  } else {
    info.style.display = 'none';
  }

  document.getElementById('setFeeModal').classList.add('open');
}

function toggleSfScope() {
  const scope = document.getElementById('sfScope').value;
  document.getElementById('sfStudentRow').style.display = scope === 'single' ? 'block' : 'none';
  document.getElementById('sfClassRow').style.display   = scope === 'class'  ? 'block' : 'none';
}

async function submitSetFee() {
  const scope  = document.getElementById('sfScope').value;
  const amount = parseFloat(document.getElementById('sfAmount').value);
  const term   = document.getElementById('sfTerm').value;
  const year   = parseInt(document.getElementById('sfYear').value) || new Date().getFullYear();

  const errEl  = document.getElementById('sfError');
  const succEl = document.getElementById('sfSuccess');
  errEl.style.display = succEl.style.display = 'none';

  if (!amount || amount < 0) { errEl.textContent='Please enter a valid fee amount.'; errEl.style.display='block'; return; }

  const btn = document.getElementById('sfSubmitBtn');
  btn.disabled  = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';

  try {
    let studentIds = [];

    if (scope === 'single') {
      const sid = document.getElementById('sfStudentId').value;
      if (!sid) { errEl.textContent='Please select a student.'; errEl.style.display='block'; btn.disabled=false; btn.innerHTML='<i class="fas fa-save"></i> Save Fee Structure'; return; }
      studentIds = [sid];
    } else if (scope === 'class') {
      const cls = document.getElementById('sfClass').value;
      studentIds = allStudents.filter(s => s.studentClass === cls).map(s => s.id);
      if (!studentIds.length) { errEl.textContent=`No students found in ${cls}.`; errEl.style.display='block'; btn.disabled=false; btn.innerHTML='<i class="fas fa-save"></i> Save Fee Structure'; return; }
    } else {
      // all students
      studentIds = allStudents.map(s => s.id);
      if (!studentIds.length) { errEl.textContent='No students found.'; errEl.style.display='block'; btn.disabled=false; btn.innerHTML='<i class="fas fa-save"></i> Save Fee Structure'; return; }
    }

    // Fire all requests
    const results = await Promise.all(studentIds.map(sid =>
      fetch(`${API}/api/fees/structure`, {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ student_id: sid, total_fee: amount, term, year })
      })
    ));

    const failed = results.filter(r => !r.ok).length;
    if (failed > 0) {
      errEl.textContent = `${failed} record(s) failed to save. Please try again.`;
      errEl.style.display = 'block';
    } else {
      succEl.textContent = `✅ Fee structure of ${fmt(amount)} set for ${studentIds.length} student(s) — ${term} ${year}`;
      succEl.style.display = 'block';
      btn.innerHTML = '<i class="fas fa-check"></i> Saved!';
      await loadAll();
      setTimeout(() => closeModal('setFeeModal'), 2500);
    }
  } catch(e) {
    errEl.textContent   = 'Network error. Please try again.';
    errEl.style.display = 'block';
  } finally {
    if (btn.innerHTML.includes('Saving')) {
      btn.disabled  = false;
      btn.innerHTML = '<i class="fas fa-save"></i> Save Fee Structure';
    }
  }
}

// ── Delete/Void Payment ─────────────────────────────────────────
async function deletePayment(id, name, amount) {
  if (!confirm(`Void payment of ${fmt(amount)} for "${name}"?\n\nThis cannot be undone and will affect the student's balance.`)) return;
  try {
    const res = await fetch(`${API}/api/fees/payment/${id}`, { method: 'DELETE' });
    if (res.ok) {
      await loadAll();
    } else {
      const d = await res.json();
      alert('Error: ' + (d.message || 'Could not delete payment.'));
    }
  } catch(e) {
    alert('Network error. Please try again.');
  }
}

// ── CSV Exports ─────────────────────────────────────────────────
function csvDownload(filename, rows, headers) {
  const lines = [headers.join(','), ...rows.map(r => r.map(c => `"${(c||'').toString().replace(/"/g,'""')}"`).join(','))];
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
}

function exportOverviewCSV() {
  csvDownload('fee_overview.csv',
    allStudents.map(s => [s.admissionNumber, s.fullName, s.studentClass, s.totalFee, s.paid, s.balance, s.status]),
    ['Adm No', 'Name', 'Class', 'Total Fee', 'Paid', 'Balance', 'Status']
  );
}

function exportPaymentsCSV() {
  csvDownload('payments.csv',
    allPayments.map(p => [fmtDate(p.created_at), p.admissionNumber, p.fullName, p.studentClass, p.amount, p.method, p.reference, p.term]),
    ['Date', 'Adm No', 'Student', 'Class', 'Amount', 'Method', 'Reference', 'Term']
  );
}

function exportArrearsCSV() {
  const rows = allStudents.filter(s => s.balance > 0);
  csvDownload('arrears.csv',
    rows.map(s => [s.fullName, s.admissionNumber, s.studentClass, s.totalFee, s.paid, s.balance]),
    ['Student', 'Adm No', 'Class', 'Total Fee', 'Paid', 'Balance']
  );
}

// ── Boot ────────────────────────────────────────────────────────
window.addEventListener('load', async () => {
  const raw = sessionStorage.getItem('currentUser');
  if (!raw) { window.location.href = 'login.html'; return; }
  currentUser = JSON.parse(raw);

  // Refresh role from backend
  try {
    const res = await fetch(`${API}/api/profile?email=${encodeURIComponent(currentUser.email)}`);
    if (res.ok) {
      const fresh = await res.json();
      currentUser = { ...currentUser, role: fresh.role, id: fresh.id || currentUser.id };
      sessionStorage.setItem('currentUser', JSON.stringify(currentUser));
    }
  } catch(e) { console.warn('Profile refresh failed:', e); }

  const role = (currentUser.role || '').toLowerCase();
  if (role !== 'accountant' && role !== 'admin') {
    alert('Access denied. Finance portal is for accountants only.');
    window.location.href = 'dashboard.html';
    return;
  }

  document.getElementById('profileName').textContent = currentUser.fullName || currentUser.email;
  document.getElementById('welcomeName').textContent = (currentUser.fullName || 'Accountant').split(' ')[0];

  await loadAll();
});
