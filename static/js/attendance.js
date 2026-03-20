const API = 'http://localhost:5000';

let allRecords  = [];   // raw attendance records from DB
let allStudents = [];   // all students (for enrolled counts)
let filtered    = [];   // currently displayed records

// ── Auth ────────────────────────────────────────────────────
function logout() {
    sessionStorage.removeItem('currentUser');
    window.location.href = 'login.html';
}

function loadUserInfo() {
    const raw = sessionStorage.getItem('currentUser');
    if (!raw) { logout(); return; }
    try {
        const user = JSON.parse(raw);
        const nameEl = document.getElementById('adminName');
        const roleEl = document.getElementById('adminRole');
        const avatarEl = document.getElementById('adminAvatar');
        if (nameEl) nameEl.textContent = user.fullName || user.email || 'Admin';
        if (roleEl) roleEl.textContent = user.role || 'User';
        if (avatarEl) {
            const name = user.fullName || user.email || 'AD';
            avatarEl.textContent = name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
        }
    } catch (e) { logout(); }
}

// ── Helpers ─────────────────────────────────────────────────
function fmtDate(d) {
    if (!d) return '—';
    return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}
function fmtTime(d) {
    if (!d) return '—';
    try { return new Date(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); }
    catch { return '—'; }
}
function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
}
function todayISO() {
    return new Date().toISOString().split('T')[0];
}
function showToast(msg, isError) {
    let t = document.getElementById('attToast');
    if (!t) {
        t = document.createElement('div');
        t.id = 'attToast';
        t.style.cssText = 'position:fixed;bottom:24px;right:24px;padding:12px 20px;border-radius:8px;' +
            'font-size:.9rem;z-index:9999;color:#fff;box-shadow:0 4px 16px rgba(0,0,0,.2);transition:opacity .35s;';
        document.body.appendChild(t);
    }
    t.style.background = isError ? '#dc2626' : '#065f46';
    t.textContent = msg;
    t.style.opacity = '1';
    clearTimeout(t._t);
    t._t = setTimeout(() => { t.style.opacity = '0'; }, 3500);
}
function setRefreshState(loading) {
    const btn  = document.getElementById('refresh-btn');
    const icon = btn ? btn.querySelector('i') : null;
    if (!btn) return;
    btn.disabled = loading;
    if (icon) icon.className = loading ? 'fas fa-spinner fa-spin' : 'fas fa-sync-alt';
}

// ── Load class filter from students table ────────────────────
async function loadClassFilter() {
    try {
        const r = await fetch(`${API}/api/students`);
        if (!r.ok) return;
        allStudents = await r.json();
        const grades = [...new Set(allStudents.map(s => s.studentClass).filter(Boolean))].sort();
        const sel = document.getElementById('class-select');
        if (!sel) return;
        const current = sel.value;
        sel.innerHTML = '<option value="">All Classes</option>';
        grades.forEach(g => {
            const opt = document.createElement('option');
            opt.value = g; opt.textContent = g;
            if (g === current) opt.selected = true;
            sel.appendChild(opt);
        });
    } catch (e) { console.warn('Could not load classes:', e.message); }
}

// ── Load teacher filter from users table ─────────────────────
async function loadTeacherFilter() {
    try {
        const r = await fetch(`${API}/api/users`);
        if (!r.ok) return;
        const users = await r.json();
        const teachers = users.filter(u => (u.role || '').toLowerCase() === 'teacher');
        const sel = document.getElementById('teacher-select');
        if (!sel) return;
        sel.innerHTML = '<option value="">All Teachers</option>';
        teachers.forEach(t => {
            const opt = document.createElement('option');
            // Filter by name since attendance stores teacher_name not teacher_id
            opt.value = t.fullName || t.email;
            opt.textContent = t.fullName || t.email;
            sel.appendChild(opt);
        });
    } catch (e) { console.warn('Could not load teachers:', e.message); }
}

// ── Fetch attendance records + summary ────────────────────────
async function loadAttendance() {
    setRefreshState(true);
    const tbody = document.getElementById('attendance-table-body');
    if (tbody) tbody.innerHTML =
        '<tr><td colspan="7" style="text-align:center;padding:2rem;color:#9ca3af;">' +
        '<i class="fas fa-spinner fa-spin"></i> Loading...</td></tr>';

    const date    = document.getElementById('date-select')?.value    || todayISO();
    const cls     = document.getElementById('class-select')?.value   || '';
    const teacher = document.getElementById('teacher-select')?.value || '';

    const params = new URLSearchParams({ date });
    if (cls) params.set('class', cls);

    try {
        // Fetch attendance records AND the per-class summary in parallel
        const [recRes, sumRes] = await Promise.all([
            fetch(`${API}/api/attendance?${params}`),
            fetch(`${API}/api/attendance/summary?date=${date}${cls ? '&class=' + encodeURIComponent(cls) : ''}`)
        ]);

        if (!recRes.ok) throw new Error('HTTP ' + recRes.status);

        allRecords = await recRes.json();
        const summary = sumRes.ok ? await sumRes.json() : [];

        // Client-side teacher filter (teacher_name stored, not teacher_id)
        filtered = teacher
            ? allRecords.filter(r => (r.teacher_name || '') === teacher)
            : [...allRecords];

        renderStats(summary, cls);
        renderTable();
        renderClassSummary(summary);
        showToast('Attendance data loaded — ' + allRecords.length + ' record' + (allRecords.length !== 1 ? 's' : ''));
    } catch (e) {
        console.error('Attendance load failed:', e);
        if (tbody) tbody.innerHTML =
            '<tr><td colspan="7" style="text-align:center;padding:2rem;color:#dc2626;">' +
            '<i class="fas fa-exclamation-circle"></i> Could not connect to server. Is the backend running?</td></tr>';
        showToast('Failed to load attendance: ' + e.message, true);
    } finally {
        setRefreshState(false);
    }
}

// ── Stat cards ────────────────────────────────────────────────
function renderStats(summary, clsFilter) {
    // Aggregate summary data
    const totalPresent  = summary.reduce((s, c) => s + (c.present  || 0), 0);
    const totalAbsent   = summary.reduce((s, c) => s + (c.absent   || 0), 0);
    const totalLate     = summary.reduce((s, c) => s + (c.late     || 0), 0);
    const totalExcused  = summary.reduce((s, c) => s + (c.excused  || 0), 0);
    const totalMarked   = summary.reduce((s, c) => s + (c.total    || 0), 0);

    // Total enrolled students (from students table, filtered by class if set)
    const enrolled = clsFilter
        ? allStudents.filter(s => s.studentClass === clsFilter).length
        : allStudents.length;

    const rate = totalMarked > 0 ? ((totalPresent / totalMarked) * 100).toFixed(1) : '—';
    const classCount = summary.length;

    setText('present-count',   totalPresent);
    setText('absent-count',    totalAbsent);
    setText('late-count',      totalLate);
    setText('excused-count',   totalExcused);
    setText('total-students',  enrolled || totalMarked);
    setText('total-classes',   classCount || '—');
    setText('attendance-rate', totalMarked > 0 ? rate + '%' : '—');
    setText('records-marked',  totalMarked + ' of ' + (enrolled || totalMarked) + ' marked');
}

// ── Class order definition ────────────────────────────────────
const CLASS_ORDER = [
  'PP1','PP2',
  'Grade 1','Grade 2','Grade 3','Grade 4','Grade 5',
  'Grade 6','Grade 7','Grade 8','Grade 9'
];

function classSort(a, b) {
  const ai = CLASS_ORDER.indexOf(a), bi = CLASS_ORDER.indexOf(b);
  if (ai === -1 && bi === -1) return a.localeCompare(b);
  if (ai === -1) return 1;
  if (bi === -1) return -1;
  return ai - bi;
}

// ── Main attendance render: one section per class ─────────────
function renderTable() {
  const container = document.getElementById('att-class-container');
  if (!container) return;

  const statusColor = {
    present: { bg:'#d1fae5', text:'#065f46' },
    absent:  { bg:'#fee2e2', text:'#dc2626' },
    late:    { bg:'#fef3c7', text:'#92400e' },
    excused: { bg:'#f3f4f6', text:'#4b5563' }
  };

  if (!filtered.length) {
    // Show empty sections for every known class so the layout still appears
    const knownClasses = [...new Set([
      ...CLASS_ORDER,
      ...allStudents.map(s => s.studentClass).filter(Boolean)
    ])];
    const clsFilter = document.getElementById('class-select')?.value || '';
    const show = clsFilter ? [clsFilter] : knownClasses;
    container.innerHTML = show.map(cls => buildClassSection(cls, [], statusColor)).join('');
    wireToggles();
    return;
  }

  // Group records by class
  const byClass = {};
  filtered.forEach(r => {
    const cls = r.student_class || 'Unknown';
    (byClass[cls] = byClass[cls] || []).push(r);
  });

  // Merge with all known classes from students table so empty classes still appear
  const clsFilter = document.getElementById('class-select')?.value || '';
  let allClasses;
  if (clsFilter) {
    allClasses = [clsFilter];
  } else {
    const fromStudents = [...new Set(allStudents.map(s => s.studentClass).filter(Boolean))];
    const fromRecords  = Object.keys(byClass);
    allClasses = [...new Set([...fromStudents, ...fromRecords])].sort(classSort);
  }

  container.innerHTML = allClasses
    .map(cls => buildClassSection(cls, byClass[cls] || [], statusColor))
    .join('');

  wireToggles();
}

function buildClassSection(cls, records, statusColor) {
  // Stats for this class
  const present  = records.filter(r => (r.status||'').toLowerCase() === 'present').length;
  const absent   = records.filter(r => (r.status||'').toLowerCase() === 'absent').length;
  const late     = records.filter(r => (r.status||'').toLowerCase() === 'late').length;
  const excused  = records.filter(r => (r.status||'').toLowerCase() === 'excused').length;
  const total    = records.length;
  const rate     = total > 0 ? Math.round(present / total * 100) : null;
  const enrolled = allStudents.filter(s => s.studentClass === cls).length;
  const teacher  = records.length ? (records[0].teacher_name || '—') : '—';
  const notMarked = total === 0;

  // Header colour based on rate
  const rateColor = notMarked ? '#9ca3af'
    : rate >= 90 ? '#059669'
    : rate >= 70 ? '#d97706'
    : '#dc2626';

  // Badge HTML
  const rateBadge = notMarked
    ? `<span class="att-cbadge" style="background:rgba(156,163,175,.3);">Not marked</span>`
    : `<span class="att-cbadge">${rate}% attendance</span>`;

  const absentBadge = absent > 0
    ? `<span class="att-cbadge red"><i class="fas fa-times-circle"></i> ${absent} Absent</span>` : '';
  const lateBadge = late > 0
    ? `<span class="att-cbadge yellow"><i class="fas fa-clock"></i> ${late} Late</span>` : '';

  // Table rows
  const rows = records.length === 0
    ? `<tr><td colspan="6" class="att-empty-group">
         ${enrolled > 0 ? `${enrolled} students enrolled — attendance not yet marked for this date.`
                        : 'No students enrolled in this class yet.'}
       </td></tr>`
    : records.map(r => {
        const status = (r.status || 'unknown').toLowerCase();
        const sc = statusColor[status] || { bg:'#f3f4f6', text:'#6b7280' };
        return `<tr>
          <td><code style="font-size:.8rem;color:#6b7280;">${r.admission_no || '—'}</code></td>
          <td><strong>${r.student_name || '—'}</strong></td>
          <td>
            <span style="background:${sc.bg};color:${sc.text};padding:.22rem .7rem;
              border-radius:20px;font-size:.8rem;font-weight:700;">${r.status || '—'}</span>
          </td>
          <td>${r.teacher_name || '—'}</td>
          <td>${fmtTime(r.created_at)}</td>
          <td>${r.remarks || '<span style="color:#d1d5db;">—</span>'}</td>
        </tr>`;
      }).join('');

  return `
    <div class="att-class-group" data-class="${cls}">
      <div class="att-class-header" onclick="toggleAttSection(this)"
           style="border-left:4px solid ${rateColor};">
        <div class="att-class-title">
          <i class="fas fa-school"></i> ${cls}
        </div>
        <div class="att-class-badges">
          <span class="att-cbadge"><i class="fas fa-users"></i> ${enrolled} enrolled</span>
          <span class="att-cbadge"><i class="fas fa-check"></i> ${present} present</span>
          ${absentBadge}${lateBadge}
          ${rateBadge}
          <span class="att-cbadge"><i class="fas fa-chalkboard-teacher"></i> ${teacher}</span>
        </div>
        <div style="display:flex;align-items:center;gap:.5rem;flex-shrink:0;">
          <button class="att-cls-export" onclick="event.stopPropagation();exportClassCSV('${cls}')">
            <i class="fas fa-download"></i> Export
          </button>
          <i class="fas fa-chevron-down att-toggle-icon"></i>
        </div>
      </div>
      ${!notMarked ? `
      <div class="att-class-statsbar">
        <span>Present: <strong style="color:#059669;">${present}</strong></span>
        <span>Absent: <strong style="color:#dc2626;">${absent}</strong></span>
        <span>Late: <strong style="color:#d97706;">${late}</strong></span>
        <span>Excused: <strong>${excused}</strong></span>
        <span>Rate: <strong style="color:${rateColor};">${rate}%</strong></span>
      </div>` : ''}
      <div class="att-class-body ${notMarked ? 'hidden' : ''}">
        <table class="att-inner-table">
          <thead>
            <tr>
              <th>Adm No</th>
              <th>Student Name</th>
              <th>Status</th>
              <th>Teacher</th>
              <th>Time Marked</th>
              <th>Remarks</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
}

function toggleAttSection(header) {
  const body = header.closest('.att-class-group').querySelector('.att-class-body');
  const icon = header.querySelector('.att-toggle-icon');
  if (!body) return;
  const hidden = body.classList.toggle('hidden');
  if (icon) icon.style.transform = hidden ? 'rotate(-90deg)' : 'rotate(0deg)';
}

function wireToggles() {
  // Collapse sections that have no records by default for a cleaner view
  document.querySelectorAll('.att-class-group').forEach(group => {
    const body    = group.querySelector('.att-class-body');
    const icon    = group.querySelector('.att-toggle-icon');
    const isEmpty = body && body.querySelector('.att-empty-group');
    if (isEmpty && body) {
      body.classList.add('hidden');
      if (icon) icon.style.transform = 'rotate(-90deg)';
    }
  });
}

// ── Export CSV for a specific class ──────────────────────────
function exportClassCSV(cls) {
  const records = filtered.filter(r => r.student_class === cls);
  if (!records.length) { showToast('No records to export for ' + cls, true); return; }
  const rows = [['Admission No','Student Name','Class','Status','Teacher','Date','Time','Remarks']];
  records.forEach(r => rows.push([
    r.admission_no || '', r.student_name || '', r.student_class || '',
    r.status || '', r.teacher_name || '', r.date || '',
    fmtTime(r.created_at), r.remarks || ''
  ]));
  const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
  const a   = Object.assign(document.createElement('a'), {
    href:     URL.createObjectURL(new Blob([csv], { type:'text/csv' })),
    download: `attendance-${cls.replace(/\s/g,'-')}-${document.getElementById('date-select')?.value || todayISO()}.csv`
  });
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  showToast('CSV exported for ' + cls);
}

// ── Class-wise summary cards ──────────────────────────────────
// Uses the /api/attendance/summary response directly — accurate, no re-computation
function renderClassSummary(summary) {
    const grid = document.getElementById('class-summary-grid');
    if (!grid) return;

    const clsFilter = document.getElementById('class-select')?.value || '';

    // Build a map of enrolled counts per class from students table
    const enrolledByClass = {};
    allStudents.forEach(s => {
        if (s.studentClass) enrolledByClass[s.studentClass] = (enrolledByClass[s.studentClass] || 0) + 1;
    });

    // Classes to show: either all from students table, or just the filter
    const allClasses = clsFilter
        ? [clsFilter]
        : [...new Set([
            ...allStudents.map(s => s.studentClass).filter(Boolean),
            ...summary.map(s => s.class).filter(Boolean)
          ])].sort();

    if (!allClasses.length) {
        grid.innerHTML = '<p style="color:#9ca3af;padding:1rem;">No classes found. Add students to the system first.</p>';
        return;
    }

    // Index summary by class name
    const summaryByClass = {};
    summary.forEach(s => { summaryByClass[s.class] = s; });

    grid.innerHTML = allClasses.map(cls => {
        const s        = summaryByClass[cls];
        const enrolled = enrolledByClass[cls] || 0;
        const present  = s?.present  || 0;
        const absent   = s?.absent   || 0;
        const late     = s?.late     || 0;
        const excused  = s?.excused  || 0;
        const total    = s?.total    || 0;
        const rate     = s?.attendance_rate ?? (total > 0 ? Math.round(present / total * 100) : 0);
        const notMarked = !s;
        const rateColor = notMarked ? '#9ca3af' : rate >= 90 ? '#059669' : rate >= 70 ? '#d97706' : '#dc2626';

        // Find teacher name from records for this class
        const classRecs = allRecords.filter(r => r.student_class === cls);
        const teacher   = classRecs.length ? (classRecs[0].teacher_name || '—') : '—';

        return `
        <div style="background:#fff;border-radius:12px;padding:1.25rem;
            box-shadow:0 1px 6px rgba(0,0,0,0.08);border-left:4px solid ${rateColor};">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.75rem;">
                <strong style="font-size:1rem;color:#1f2937;">${cls}</strong>
                <span style="background:${rateColor}20;color:${rateColor};padding:.2rem .6rem;
                    border-radius:20px;font-size:.82rem;font-weight:700;">
                    ${notMarked ? 'Not marked' : rate + '%'}
                </span>
            </div>
            <div style="font-size:.82rem;color:#6b7280;margin-bottom:.75rem;">
                <i class="fas fa-chalkboard-teacher" style="margin-right:4px;"></i>${teacher}
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:.4rem;font-size:.84rem;">
                <div style="color:#059669;"><i class="fas fa-check-circle"></i> Present: <strong>${present}</strong></div>
                <div style="color:#dc2626;"><i class="fas fa-times-circle"></i> Absent: <strong>${absent}</strong></div>
                <div style="color:#d97706;"><i class="fas fa-clock"></i> Late: <strong>${late}</strong></div>
                <div style="color:#6b7280;"><i class="fas fa-user-shield"></i> Excused: <strong>${excused}</strong></div>
            </div>
            <div style="margin-top:.75rem;font-size:.79rem;color:#9ca3af;
                border-top:1px solid #f3f4f6;padding-top:.5rem;">
                Enrolled: <strong>${enrolled}</strong> students
                ${notMarked ? ' &mdash; <span style="color:#d97706;">not yet marked today</span>' : ''}
            </div>
        </div>`;
    }).join('');
}

// ── Mark attendance modal ────────────────────────────────────
function openMarkModal() {
    const modal = document.getElementById('markModal');
    if (!modal) return;

    // Populate student list for the selected class
    const cls  = document.getElementById('class-select')?.value || '';
    const date = document.getElementById('date-select')?.value  || todayISO();
    const user = (() => { try { return JSON.parse(sessionStorage.getItem('currentUser') || '{}'); } catch { return {}; } })();

    document.getElementById('markDate').textContent = date;
    document.getElementById('markClass').value      = cls;
    document.getElementById('markTeacher').value    = user.fullName || user.email || '';

    const students = cls
        ? allStudents.filter(s => s.studentClass === cls)
        : allStudents;

    // Pre-fill with existing records for today
    const existingMap = {};
    allRecords.forEach(r => { existingMap[r.student_id || r.admission_no] = r; });

    const listEl = document.getElementById('markStudentList');
    if (!listEl) return;

    if (!students.length) {
        listEl.innerHTML = '<p style="color:#9ca3af;padding:1rem;text-align:center;">' +
            (cls ? 'No students in ' + cls + '. Add students first.' : 'Select a class first.') + '</p>';
        modal.style.display = 'flex';
        return;
    }

    listEl.innerHTML = students.map(s => {
        const existing = existingMap[s.id] || existingMap[s.admissionNumber];
        const status   = existing?.status || 'Present';
        const remarks  = existing?.remarks || '';
        return `<div style="display:grid;grid-template-columns:2fr 1fr 2fr;gap:.5rem;align-items:center;
                    padding:.6rem .75rem;border-bottom:1px solid #f3f4f6;">
            <div>
                <strong style="font-size:.9rem;">${s.fullName}</strong>
                <div style="font-size:.75rem;color:#9ca3af;">${s.admissionNumber || ''} · ${s.studentClass || ''}</div>
            </div>
            <select data-id="${s.id}" data-adm="${s.admissionNumber || ''}"
                data-name="${(s.fullName||'').replace(/"/g,'&quot;')}" data-class="${s.studentClass || ''}"
                class="mark-status-sel"
                style="padding:.3rem .5rem;border-radius:6px;border:1px solid #d1fae5;font-size:.84rem;font-weight:600;cursor:pointer;">
                <option value="Present"  ${status==='Present' ?'selected':''}>Present</option>
                <option value="Absent"   ${status==='Absent'  ?'selected':''}>Absent</option>
                <option value="Late"     ${status==='Late'    ?'selected':''}>Late</option>
                <option value="Excused"  ${status==='Excused' ?'selected':''}>Excused</option>
            </select>
            <input type="text" data-adm="${s.admissionNumber||''}" class="mark-remarks-inp"
                placeholder="Remarks (optional)" value="${remarks}"
                style="padding:.3rem .5rem;border-radius:6px;border:1px solid #e5e7eb;font-size:.82rem;width:100%;">
        </div>`;
    }).join('');

    modal.style.display = 'flex';
}

function closeMarkModal() {
    const modal = document.getElementById('markModal');
    if (modal) modal.style.display = 'none';
}

async function submitMarkAttendance() {
    const date    = document.getElementById('date-select')?.value  || todayISO();
    const teacher = document.getElementById('markTeacher')?.value  || '';
    const user    = (() => { try { return JSON.parse(sessionStorage.getItem('currentUser') || '{}'); } catch { return {}; } })();

    const selects = document.querySelectorAll('#markStudentList .mark-status-sel');
    if (!selects.length) { closeMarkModal(); return; }

    const entries = [...selects].map(sel => {
        const remarksEl = document.querySelector(
            `#markStudentList .mark-remarks-inp[data-adm="${sel.dataset.adm}"]`
        );
        return {
            student_id:   sel.dataset.id,
            admissionNo:  sel.dataset.adm,
            studentName:  sel.dataset.name,
            class:        sel.dataset.class,
            date,
            status:       sel.value,
            remarks:      remarksEl?.value.trim() || '',
            teacherName:  teacher || user.fullName || '',
            teacher_id:   user.id || ''
        };
    });

    const btn = document.getElementById('submitMarkBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...'; }

    try {
        const res = await fetch(`${API}/api/attendance`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(entries)
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || 'Save failed');
        showToast('✅ Saved ' + data.saved + ' attendance record' + (data.saved !== 1 ? 's' : ''));
        closeMarkModal();
        await loadAttendance();
    } catch (e) {
        showToast('❌ ' + e.message, true);
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-save"></i> Save Attendance'; }
    }
}

// ── Delete a record ───────────────────────────────────────────
async function deleteRecord(id, studentName) {
    if (!confirm(`Delete attendance record for "${studentName}"?`)) return;
    try {
        const res = await fetch(`${API}/api/attendance/${id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error('Delete failed');
        showToast('Record deleted');
        await loadAttendance();
    } catch (e) {
        showToast('Delete failed: ' + e.message, true);
    }
}

// ── Export CSV ────────────────────────────────────────────────
function exportReport() {
    if (!filtered.length) { alert('No data to export.'); return; }
    const rows = [['Admission No', 'Student Name', 'Class', 'Status', 'Teacher', 'Date', 'Time', 'Remarks']];
    filtered.forEach(r => rows.push([
        r.admission_no  || '',
        r.student_name  || '',
        r.student_class || '',
        r.status        || '',
        r.teacher_name  || '',
        r.date          || '',
        fmtTime(r.created_at),
        r.remarks       || ''
    ]));
    const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const a   = Object.assign(document.createElement('a'), {
        href:     URL.createObjectURL(new Blob([csv], { type: 'text/csv' })),
        download: `attendance-${document.getElementById('date-select')?.value || todayISO()}.csv`
    });
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    showToast('CSV exported');
}

// ── Boot ──────────────────────────────────────────────────────
window.addEventListener('load', async () => {
    loadUserInfo();

    // Default date to today
    const datePicker = document.getElementById('date-select');
    if (datePicker) datePicker.value = todayISO();

    // Load filter options and first attendance load in parallel
    await Promise.all([loadClassFilter(), loadTeacherFilter()]);
    await loadAttendance();

    // Wire up controls
    document.getElementById('apply-filters')?.addEventListener('click', loadAttendance);
    document.getElementById('refresh-btn')?.addEventListener('click', loadAttendance);
    document.getElementById('export-btn')?.addEventListener('click', exportReport);
    document.getElementById('print-btn')?.addEventListener('click', () => window.print());
    document.getElementById('mark-btn')?.addEventListener('click', openMarkModal);
    document.getElementById('closeMarkModal')?.addEventListener('click', closeMarkModal);
    document.getElementById('submitMarkBtn')?.addEventListener('click', submitMarkAttendance);
    document.getElementById('cancelMarkBtn')?.addEventListener('click', closeMarkModal);

    // Close modal on backdrop click
    document.getElementById('markModal')?.addEventListener('click', e => {
        if (e.target === document.getElementById('markModal')) closeMarkModal();
    });
});
