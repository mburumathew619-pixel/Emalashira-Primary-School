const API = 'https://emalashira-primary-school.onrender.com';
let allGrades      = [];
let allStudents    = [];
let filtered       = [];
let classTeacherMap = {}; // class_name → teacher full name

// ── Auth ──────────────────────────────────────────────────────
function logout() {
  sessionStorage.removeItem('currentUser');
  window.location.href = 'login.html';
}

function loadUserInfo() {
  const raw = sessionStorage.getItem('currentUser');
  if (!raw) { logout(); return; }
  try {
    const user = JSON.parse(raw);
    document.getElementById('userNameDisplay').textContent = user.fullName || user.email || 'Admin';
    document.getElementById('roleBadge').textContent       = user.role    || 'User';
  } catch(e) { logout(); }
}

// ── Helpers ───────────────────────────────────────────────────
function scoreToGrade(s) {
  if (s >= 80) return 'A';
  if (s >= 60) return 'B';
  if (s >= 40) return 'C';
  if (s >= 30) return 'D';
  return 'F';
}
function scoreToPerformance(s) {
  if (s >= 80) return 'Excellent';
  if (s >= 60) return 'Good';
  if (s >= 40) return 'Average';
  return 'Poor';
}
function formatDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' });
}
function normalise(g) {
  return {
    id:          g.id,
    studentId:   g.student_id   || '',
    studentName: g.student_name  || g.studentName  || '—',
    admissionNo: g.admission_no  || g.admissionNo  || '—',
    class:       g.student_class || g.class         || '—',
    subject:     g.subject       || '—',
    score:       g.score         ?? 0,
    grade:       g.grade         || scoreToGrade(g.score ?? 0),
    performance: g.performance   || scoreToPerformance(g.score ?? 0),
    term:        g.term          || '—',
    examType:    g.exam_type     || g.examType      || '—',
    teacherName: g.teacher_name  || g.teacherName   || '—',
    remarks:     g.remarks       || '',
    datePosted:  g.date_posted   || g.datePosted    || g.created_at || '',
  };
}
function showToast(msg, isError) {
  let t = document.getElementById('grToast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'grToast';
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
  const btn  = document.getElementById('refreshBtn');
  const icon = btn ? btn.querySelector('i') : null;
  if (!btn) return;
  btn.disabled = loading;
  if (icon) icon.className = loading ? 'fas fa-spinner fa-spin' : 'fas fa-sync-alt';
}

// ── Populate filter dropdowns from actual DB data ─────────────
function populateFilters(grades) {
  const classes  = [...new Set(grades.map(g => g.class).filter(v => v && v !== '—'))].sort((a,b) =>
    a.localeCompare(b, undefined, { numeric: true }));
  const subjects = [...new Set(grades.map(g => g.subject).filter(v => v && v !== '—'))].sort();
  const terms    = [...new Set(grades.map(g => g.term).filter(v => v && v !== '—'))].sort();
  const examTypes= [...new Set(grades.map(g => g.examType).filter(v => v && v !== '—'))].sort();

  function populate(id, items, allLabel) {
    const sel = document.getElementById(id);
    if (!sel) return;
    const current = sel.value;
    sel.innerHTML = `<option value="">${allLabel}</option>`;
    items.forEach(v => {
      const opt = document.createElement('option');
      opt.value = v; opt.textContent = v;
      if (v === current) opt.selected = true;
      sel.appendChild(opt);
    });
  }

  populate('filterGrade',    classes,   'All Classes');
  populate('filterSubject',  subjects,  'All Subjects');
  populate('filterTerm',     terms,     'All Terms');
  populate('filterExamType', examTypes, 'All Exam Types');
}

// ── Load grades + summary from backend ────────────────────────
async function loadGrades() {
  setRefreshState(true);
  const tbody = document.getElementById('gradesTableBody');
  if (tbody) tbody.innerHTML =
    '<tr><td colspan="11" style="text-align:center;padding:2rem;color:#9ca3af;">' +
    '<i class="fas fa-spinner fa-spin"></i> Loading grades...</td></tr>';

  try {
    // Fire grades, summary, and teacher assignments in parallel
    const [gradesRes, summaryRes, assignRes] = await Promise.all([
      fetch(`${API}/api/grades`),
      fetch(`${API}/api/grades/summary`),
      fetch(`${API}/api/teacher-assignments/summary`)
    ]);

    if (!gradesRes.ok) throw new Error('HTTP ' + gradesRes.status);

    const raw        = await gradesRes.json();
    const summary    = summaryRes.ok  ? await summaryRes.json()  : [];
    const assignments = assignRes.ok  ? await assignRes.json()   : [];

    // Build class → teacher name map from assignments
    // Each teacher object has: { fullName, assignments: [{ class_name, subject, ... }] }
    classTeacherMap = {};
    if (Array.isArray(assignments)) {
      assignments.forEach(teacher => {
        (teacher.assignments || []).forEach(a => {
          const cn = a.class_name;
          if (cn && !classTeacherMap[cn]) {
            // First teacher assigned to this class is treated as class teacher
            classTeacherMap[cn] = teacher.fullName || '—';
          }
        });
      });
    }

    allGrades = raw.map(normalise);
    filtered  = [...allGrades];

    populateFilters(allGrades);
    updateStats(filtered);
    renderTable(filtered);
    renderSummary(summary);

    showToast('Grades loaded — ' + allGrades.length + ' record' + (allGrades.length !== 1 ? 's' : ''));
  } catch (e) {
    console.error('Grades load failed:', e);
    allGrades = []; filtered = [];
    showError('Could not connect to server. Make sure the backend is running.');
    showToast('Failed to load grades: ' + e.message, true);
  } finally {
    setRefreshState(false);
  }
}

function showError(msg) {
  const el = document.getElementById('emptyState');
  if (el) {
    el.style.display = 'block';
    el.innerHTML = `<i class="fas fa-exclamation-circle" style="color:#dc2626;font-size:2rem;"></i>
      <p style="color:#dc2626;margin-top:.5rem;">${msg}</p>`;
  }
  const t = document.getElementById('gradesTable');
  if (t) t.style.display = 'none';
}

// ── Stats ─────────────────────────────────────────────────────
function updateStats(data) {
  const students  = new Set(data.map(g => g.admissionNo)).size;
  const teachers  = new Set(data.map(g => g.teacherName).filter(v => v !== '—')).size;
  const excellent = data.filter(g => g.performance === 'Excellent').length;
  const avg = data.length
    ? (data.reduce((s, g) => s + (g.score || 0), 0) / data.length).toFixed(1)
    : null;

  document.getElementById('statTotalEntries').textContent   = data.length;
  document.getElementById('statStudentsGraded').textContent = students;
  document.getElementById('statTeachers').textContent       = teachers;
  document.getElementById('statAvgScore').textContent       = avg !== null ? avg + '%' : '—';
  document.getElementById('statExcellent').textContent      = excellent;
}

// ── Grade / performance colours ───────────────────────────────
const GRADE_COLORS = {
  A: { bg:'#d1fae5', text:'#065f46' },
  B: { bg:'#dbeafe', text:'#1e40af' },
  C: { bg:'#fef9c3', text:'#854d0e' },
  D: { bg:'#fed7aa', text:'#9a3412' },
  F: { bg:'#fee2e2', text:'#dc2626' }
};

function ordinal(n) {
  const s = ['th','st','nd','rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// ── Main render: one section per class, pivot table ────────────
function renderTable(data) {
  const container    = document.getElementById('classGradeContainer');
  const flatContainer = document.getElementById('flatTableContainer');
  const emptyState   = document.getElementById('emptyState');
  const countEl      = document.getElementById('recordCount');

  // Decide whether to show class-grouped view or flat filtered view
  const filtersActive = !!(
    document.getElementById('searchInput')?.value.trim() ||
    document.getElementById('filterSubject')?.value ||
    document.getElementById('filterExamType')?.value ||
    document.getElementById('filterPerformance')?.value
  );
  const classFilter = document.getElementById('filterGrade')?.value || '';
  const termFilter  = document.getElementById('filterTerm')?.value  || '';

  if (countEl) countEl.textContent = `${data.length} record${data.length !== 1 ? 's' : ''}`;

  if (!data.length) {
    if (container)    container.innerHTML = '';
    if (flatContainer) flatContainer.style.display = 'none';
    if (emptyState)  { emptyState.style.display = 'block'; emptyState.innerHTML =
      '<i class="fas fa-clipboard"></i><p>No grade records found</p>' +
      '<small>Teachers haven\'t posted any grades yet, or your filters returned no results.</small>'; }
    return;
  }
  if (emptyState) emptyState.style.display = 'none';

  // For search / subject / performance / examType filters → show flat table
  if (filtersActive) {
    if (container)    container.innerHTML = '';
    if (flatContainer) {
      flatContainer.style.display = 'block';
      renderFlatTable(data);
    }
    return;
  }

  // Class-grouped pivot view
  if (flatContainer) flatContainer.style.display = 'none';
  if (!container)   return;

  // Group data by class
  const classOrder = { PP1:0,PP2:1,'Grade 1':2,'Grade 2':3,'Grade 3':4,
                       'Grade 4':5,'Grade 5':6,'Grade 6':7,'Grade 7':8,'Grade 8':9 };
  const byClass = {};
  data.forEach(g => {
    const cls = g.class || 'Unknown';
    (byClass[cls] = byClass[cls] || []).push(g);
  });
  const sortedClasses = Object.keys(byClass)
    .sort((a, b) => (classOrder[a] ?? 50) - (classOrder[b] ?? 50));

  container.innerHTML = '';

  sortedClasses.forEach(cls => {
    const records = byClass[cls];

    // Discover all subjects in this class (sorted)
    const subjects = [...new Set(records.map(g => g.subject).filter(Boolean))].sort();

    // Group by student (by admissionNo)
    const byStudent = {};
    records.forEach(g => {
      const key = g.admissionNo !== '—' ? g.admissionNo : g.studentName;
      if (!byStudent[key]) byStudent[key] = { name: g.studentName, adm: g.admissionNo, scores: {}, rawRecords: [] };
      // Keep highest score per subject (in case of duplicates)
      if (byStudent[key].scores[g.subject] == null || g.score > byStudent[key].scores[g.subject]) {
        byStudent[key].scores[g.subject] = g.score;
      }
      byStudent[key].rawRecords.push(g);
    });

    // Build rows with average and rank
    const studentRows = Object.values(byStudent).map(s => {
      const validScores = subjects.map(sub => s.scores[sub] ?? null).filter(v => v !== null);
      const avg = validScores.length
        ? parseFloat((validScores.reduce((a, b) => a + b, 0) / validScores.length).toFixed(1))
        : 0;
      return { ...s, avg };
    }).sort((a, b) => b.avg - a.avg);

    // Assign positions
    studentRows.forEach((r, i) => { r.position = i + 1; });

    // Class stats
    const classAvg    = studentRows.length
      ? (studentRows.reduce((s, r) => s + r.avg, 0) / studentRows.length).toFixed(1)
      : 0;
    const excellent   = studentRows.filter(r => r.avg >= 80).length;
    const needSupport = studentRows.filter(r => r.avg < 40).length;
    const termLabel   = termFilter || [...new Set(records.map(g => g.term).filter(Boolean))].join(', ') || '—';

    // ── Build section HTML ──
    const section = document.createElement('div');
    section.className = 'class-group';

    // Header
    const header = document.createElement('div');
    header.className = 'class-group-header';
    header.innerHTML = `
      <div class="class-group-title">
        <i class="fas fa-school"></i> ${cls}
      </div>
      <div class="class-group-meta">
        <span class="cgm-badge"><i class="fas fa-users"></i> ${studentRows.length} Students</span>
        <span class="cgm-badge"><i class="fas fa-book"></i> ${subjects.length} Subjects</span>
        <span class="cgm-badge"><i class="fas fa-chart-bar"></i> Avg: ${classAvg}%</span>
        ${termLabel ? `<span class="cgm-badge"><i class="fas fa-calendar"></i> ${termLabel}</span>` : ''}
      </div>
      <button class="cls-export-btn" onclick="exportClassCSV('${cls}')">
        <i class="fas fa-download"></i> Export
      </button>`;
    section.appendChild(header);

    // Stats bar
    const classTeacher = classTeacherMap[cls] || '—';
    const statsBar = document.createElement('div');
    statsBar.className = 'class-stats-bar';
    statsBar.innerHTML = `
      <div class="csb-item">Class Average: <strong>${classAvg}%</strong></div>
      <div class="csb-item">Excellent (≥80%): <strong style="color:#065f46;">${excellent}</strong></div>
      <div class="csb-item">Need Support (&lt;40%): <strong style="color:#dc2626;">${needSupport}</strong></div>
      <div class="csb-item">Top Student: <strong>${studentRows[0]?.name || '—'}</strong>
        ${studentRows[0] ? `<span style="color:#d97706;">(${studentRows[0].avg}%)</span>` : ''}
      </div>
      <div class="csb-item" style="border-left:2px solid #e5e7eb;padding-left:1rem;margin-left:.25rem;">
        <i class="fas fa-chalkboard-teacher" style="color:#065f46;margin-right:.35rem;"></i>
        Class Teacher: <strong style="color:#065f46;">${classTeacher}</strong>
      </div>`;
    section.appendChild(statsBar);

    // Table
    const tableWrap = document.createElement('div');
    tableWrap.className = 'class-group-body';

    // Build thead
    const subjectHeaders = subjects.map(sub =>
      `<th style="text-align:center;">${sub}</th>`).join('');

    // Build tbody rows
    const bodyRows = studentRows.map(r => {
      const rankClass = r.position === 1 ? 'rank-1' : r.position === 2 ? 'rank-2' : r.position === 3 ? 'rank-3' : '';
      const gc = GRADE_COLORS[scoreToGrade(r.avg)] || { bg:'#f3f4f6', text:'#6b7280' };

      const scoreCells = subjects.map(sub => {
        const score = r.scores[sub];
        if (score == null) return '<td style="text-align:center;color:#d1d5db;">—</td>';
        const gc2 = GRADE_COLORS[scoreToGrade(score)] || { bg:'#f3f4f6', text:'#6b7280' };
        return `<td style="text-align:center;">
          <span class="score-pill" style="background:${gc2.bg};color:${gc2.text};">${score}%</span>
        </td>`;
      }).join('');

      return `<tr>
        <td><span class="pos-rank ${rankClass}">${ordinal(r.position)}</span></td>
        <td><strong>${r.name}</strong></td>
        <td><code style="font-size:.78rem;color:#6b7280;">${r.adm}</code></td>
        ${scoreCells}
        <td style="text-align:center;">
          <span class="avg-strong">${r.avg}%</span>
        </td>
        <td style="text-align:center;">
          <span class="grade-badge" style="background:${gc.bg};color:${gc.text};">
            ${scoreToGrade(r.avg)}
          </span>
        </td>
      </tr>`;
    }).join('') || `<tr class="no-data-row"><td colspan="${3 + subjects.length + 2}">No student data</td></tr>`;

    tableWrap.innerHTML = `
      <table class="position-table">
        <thead>
          <tr>
            <th style="width:60px;">Position</th>
            <th>Student Name</th>
            <th>Adm. No.</th>
            ${subjectHeaders}
            <th style="text-align:center;">Average</th>
            <th style="text-align:center;">Grade</th>
          </tr>
        </thead>
        <tbody>${bodyRows}</tbody>
      </table>`;
    section.appendChild(tableWrap);
    container.appendChild(section);
  });
}

// ── Flat table (shown only when search/filter is active) ───────
function renderFlatTable(data) {
  const tbody = document.getElementById('gradesTableBody');
  const empty = document.getElementById('emptyState');
  const table = document.getElementById('gradesTable');

  if (!data.length) {
    if (empty) empty.style.display = 'block';
    if (table) table.style.display = 'none';
    return;
  }
  if (empty) empty.style.display = 'none';
  if (table) table.style.display = 'table';

  tbody.innerHTML = data.map(g => {
    const gc = GRADE_COLORS[g.grade]   || { bg:'#f3f4f6', text:'#6b7280' };
    const pc = (g.performance === 'Excellent') ? { bg:'#d1fae5', text:'#065f46' }
             : (g.performance === 'Good')      ? { bg:'#dbeafe', text:'#1e40af' }
             : (g.performance === 'Average')   ? { bg:'#fef9c3', text:'#854d0e' }
             :                                   { bg:'#fee2e2', text:'#dc2626' };
    return `<tr>
      <td><strong>${g.studentName}</strong></td>
      <td><code style="font-size:.8rem;">${g.admissionNo}</code></td>
      <td>${g.class}</td>
      <td>${g.subject}</td>
      <td><strong>${g.score}%</strong></td>
      <td><span style="background:${gc.bg};color:${gc.text};padding:.2rem .65rem;border-radius:20px;font-size:.82rem;font-weight:700;">${g.grade}</span></td>
      <td><span style="background:${pc.bg};color:${pc.text};padding:.2rem .65rem;border-radius:20px;font-size:.82rem;font-weight:600;">${g.performance}</span></td>
      <td>${g.term}</td>
      <td>${g.examType}</td>
      <td>${g.teacherName}</td>
      <td>${formatDate(g.datePosted)}</td>
      <td>
        <button onclick="deleteGrade('${g.id}','${(g.studentName).replace(/'/g,"\\'")}','${g.subject}')"
          style="background:#fee2e2;color:#dc2626;border:none;padding:.3rem .6rem;border-radius:6px;cursor:pointer;font-size:.8rem;">
          <i class="fas fa-trash"></i>
        </button>
      </td>
    </tr>`;
  }).join('');
}

// ── Export CSV for a specific class ───────────────────────────
function exportClassCSV(cls) {
  const classData = filtered.filter(g => g.class === cls);
  if (!classData.length) return;
  const headers = ['Position','Student Name','Admission No','Subject','Score','Grade','Performance','Term','Exam Type','Teacher','Date Posted'];

  // Build pivot: group by student
  const subjects  = [...new Set(classData.map(g => g.subject).filter(Boolean))].sort();
  const byStudent = {};
  classData.forEach(g => {
    const key = g.admissionNo !== '—' ? g.admissionNo : g.studentName;
    if (!byStudent[key]) byStudent[key] = { name: g.studentName, adm: g.admissionNo, scores: {} };
    if (byStudent[key].scores[g.subject] == null || g.score > byStudent[key].scores[g.subject])
      byStudent[key].scores[g.subject] = g.score;
  });
  const rows = Object.values(byStudent).map(s => {
    const vals  = subjects.map(sub => s.scores[sub] ?? null).filter(v => v !== null);
    const avg   = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
    return { ...s, avg };
  }).sort((a, b) => b.avg - a.avg);

  const csvHeaders = ['Position','Student Name','Adm. No.', ...subjects, 'Average','Grade'];
  const csvRows = rows.map((r, i) => [
    i + 1, `"${r.name}"`, r.adm,
    ...subjects.map(sub => r.scores[sub] ?? '—'),
    r.avg.toFixed(1) + '%',
    scoreToGrade(r.avg)
  ].join(','));

  const csv  = [csvHeaders.join(','), ...csvRows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a    = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(blob),
    download: `grades-${cls.replace(/\s/g,'-')}-${new Date().toISOString().split('T')[0]}.csv`
  });
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  showToast(`CSV exported for ${cls}`);
}

// ── renderSummary: no longer needed (inline per class) ─────────
function renderSummary(summary) { /* summary now shown per class inline */ }

// ── Filters ───────────────────────────────────────────────────
function applyFilters() {
  const search   = (document.getElementById('searchInput')?.value    || '').toLowerCase();
  const cls      = document.getElementById('filterGrade')?.value     || '';
  const subject  = document.getElementById('filterSubject')?.value   || '';
  const term     = document.getElementById('filterTerm')?.value      || '';
  const perf     = document.getElementById('filterPerformance')?.value || '';
  const examType = document.getElementById('filterExamType')?.value  || '';

  filtered = allGrades.filter(g => {
    const matchSearch = !search || [g.studentName, g.teacherName, g.admissionNo, g.subject]
      .some(v => v.toLowerCase().includes(search));
    return matchSearch &&
      (!cls      || g.class      === cls)      &&
      (!subject  || g.subject    === subject)  &&
      (!term     || g.term       === term)     &&
      (!perf     || g.performance=== perf)     &&
      (!examType || g.examType   === examType);
  });

  updateStats(filtered);
  renderTable(filtered);

  // Re-fetch summary filtered by term if term is selected, else use full summary
  if (term) {
    fetch(`${API}/api/grades/summary?term=${encodeURIComponent(term)}`)
      .then(r => r.ok ? r.json() : [])
      .then(summary => renderSummary(summary))
      .catch(() => {});
  } else {
    fetch(`${API}/api/grades/summary`)
      .then(r => r.ok ? r.json() : [])
      .then(summary => renderSummary(summary))
      .catch(() => {});
  }
}

function resetFilters() {
  ['searchInput','filterGrade','filterSubject','filterTerm','filterPerformance','filterExamType'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  filtered = [...allGrades];
  updateStats(filtered);
  renderTable(filtered);
  // Reload full summary
  fetch(`${API}/api/grades/summary`)
    .then(r => r.ok ? r.json() : [])
    .then(s => renderSummary(s))
    .catch(() => {});
}

// ── Delete a grade record ─────────────────────────────────────
async function deleteGrade(id, studentName, subject) {
  if (!confirm(`Delete grade for "${studentName}" — ${subject}? This cannot be undone.`)) return;
  try {
    const res = await fetch(`${API}/api/grades/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Delete failed');
    showToast('Grade deleted');
    await loadGrades();
  } catch(e) {
    showToast('Delete failed: ' + e.message, true);
  }
}

// ── Post Grades Modal ─────────────────────────────────────────
async function openPostModal() {
  const modal = document.getElementById('postModal');
  if (!modal) return;

  // Load students if not already loaded
  if (!allStudents.length) {
    try {
      const r = await fetch(`${API}/api/students`);
      if (r.ok) allStudents = await r.json();
    } catch(e) { console.warn('Could not load students'); }
  }

  // Populate student dropdown
  const sel = document.getElementById('postStudent');
  if (sel) {
    sel.innerHTML = '<option value="">— Select student —</option>';
    allStudents.forEach(s => {
      const opt = document.createElement('option');
      opt.value = JSON.stringify({ id: s.id, admNo: s.admissionNumber || '', name: s.fullName || '', cls: s.studentClass || '' });
      opt.textContent = `${s.fullName} (${s.admissionNumber || '—'}) · ${s.studentClass || '—'}`;
      sel.appendChild(opt);
    });
  }

  // Pre-fill teacher from session
  const user = (() => { try { return JSON.parse(sessionStorage.getItem('currentUser') || '{}'); } catch { return {}; } })();
  const teacherEl = document.getElementById('postTeacher');
  if (teacherEl && !teacherEl.value) teacherEl.value = user.fullName || user.email || '';

  // Set today's date
  const dateEl = document.getElementById('postDate');
  if (dateEl && !dateEl.value) dateEl.value = new Date().toISOString().split('T')[0];

  // Reset score bar
  updateScorePreview();
  modal.style.display = 'flex';
}

function closePostModal() {
  const modal = document.getElementById('postModal');
  if (modal) modal.style.display = 'none';
}

function updateScorePreview() {
  const score   = parseInt(document.getElementById('postScore')?.value || '0', 10);
  const grade   = scoreToGrade(score);
  const perf    = scoreToPerformance(score);
  const barEl   = document.getElementById('scoreBar');
  const labelEl = document.getElementById('scoreLabel');
  const barColors = { A:'#059669', B:'#2563eb', C:'#d97706', D:'#ea580c', F:'#dc2626' };
  if (barEl)   { barEl.style.width = score + '%'; barEl.style.background = barColors[grade] || '#dc2626'; }
  if (labelEl) labelEl.textContent = `${score}% — Grade ${grade} (${perf})`;
}

async function submitPostGrade() {
  const studentRaw = document.getElementById('postStudent')?.value;
  const subject    = document.getElementById('postSubject')?.value.trim();
  const score      = parseInt(document.getElementById('postScore')?.value || '0', 10);
  const term       = document.getElementById('postTerm')?.value;
  const examType   = document.getElementById('postExamType')?.value;
  const teacher    = document.getElementById('postTeacher')?.value.trim();
  const remarks    = document.getElementById('postRemarks')?.value.trim() || '';
  const datePosted = document.getElementById('postDate')?.value;

  if (!studentRaw) { showToast('Please select a student', true); return; }
  if (!subject)    { showToast('Please enter a subject',  true); return; }
  if (!term)       { showToast('Please select a term',    true); return; }
  if (!examType)   { showToast('Please select exam type', true); return; }

  let student;
  try { student = JSON.parse(studentRaw); } catch { showToast('Invalid student selection', true); return; }

  const user = (() => { try { return JSON.parse(sessionStorage.getItem('currentUser') || '{}'); } catch { return {}; } })();

  const payload = [{
    student_id:  student.id,
    admissionNo: student.admNo,
    studentName: student.name,
    class:       student.cls,
    subject,
    score,
    term,
    examType,
    teacherName: teacher || user.fullName || '',
    teacher_id:  user.id || '',
    remarks,
    datePosted
  }];

  const btn = document.getElementById('submitPostBtn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...'; }

  try {
    const res  = await fetch(`${API}/api/grades`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Save failed');
    if (data.errors && data.errors.length) throw new Error(data.errors.join('; '));
    showToast(`✅ Grade saved for ${student.name}`);
    closePostModal();
    document.getElementById('postGradeForm')?.reset();
    await loadGrades();
  } catch(e) {
    showToast('❌ ' + e.message, true);
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-save"></i> Save Grade'; }
  }
}

// ── Export CSV ────────────────────────────────────────────────
function exportCSV() {
  if (!filtered.length) { alert('No data to export.'); return; }
  const headers = ['Student Name','Admission No','Class','Subject','Score','Grade','Performance','Term','Exam Type','Teacher','Date Posted','Remarks'];
  const rows    = filtered.map(g => [
    `"${g.studentName}"`, g.admissionNo, g.class, g.subject,
    g.score, g.grade, g.performance, g.term, g.examType,
    `"${g.teacherName}"`, g.datePosted, `"${g.remarks}"`
  ].join(','));
  const csv  = [headers.join(','), ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a    = Object.assign(document.createElement('a'), {
    href:     URL.createObjectURL(blob),
    download: `grades-${new Date().toISOString().split('T')[0]}.csv`
  });
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  showToast('CSV exported');
}

// ── Boot ──────────────────────────────────────────────────────
window.addEventListener('load', () => {
  loadUserInfo();
  loadGrades();

  document.getElementById('refreshBtn')?.addEventListener('click', loadGrades);
  document.getElementById('postGradeBtn')?.addEventListener('click', openPostModal);
  document.getElementById('closePostModal')?.addEventListener('click', closePostModal);
  document.getElementById('submitPostBtn')?.addEventListener('click', submitPostGrade);
  document.getElementById('cancelPostBtn')?.addEventListener('click', closePostModal);
  document.getElementById('postScore')?.addEventListener('input', updateScorePreview);

  document.getElementById('postModal')?.addEventListener('click', e => {
    if (e.target === document.getElementById('postModal')) closePostModal();
  });
});
