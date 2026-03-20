const API = "http://localhost:5000";
let currentUser = null;
let allStudents = [], filteredStudents = [];

function logout() { sessionStorage.removeItem('currentUser'); window.location.replace('login.html'); }

function switchTab(name, btn) {
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  btn.classList.add('active');
}

function scoreToGrade(s) { return s>=80?'A':s>=60?'B':s>=40?'C':s>=30?'D':'F'; }
function fmtDate(d) { return d?new Date(d).toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'}):'—'; }

// ── Load class students for grade entry ──
function loadClassStudents() {
  const cls = document.getElementById('gradeClass').value;
  const sub = document.getElementById('gradeSubject').value;
  if (!cls) return;

  // Verify teacher is assigned to this class (if assignments exist)
  const myAssignments = window._teacherAssignments || [];
  if (myAssignments.length > 0) {
    const allowed = myAssignments.some(a => a.class_name === cls);
    if (!allowed) {
      showSyncToast(false, `You are not assigned to ${cls}. Contact admin.`);
      return;
    }
  }

  const students = allStudents.filter(s => s.class===cls || s.grade==cls.replace('Grade ',''));
  document.getElementById('gradePrompt').style.display = 'none';
  const list = document.getElementById('gradeStudentsList');
  if (!students.length) {
    list.style.display='none';
    document.getElementById('gradePrompt').style.display='block';
    document.getElementById('gradePrompt').querySelector('p').textContent='No students found for this class.';
    return;
  }
  list.style.display = 'block';
  const existing = JSON.parse(localStorage.getItem('gradesData')||'[]');
  document.getElementById('gradeEntryBody').innerHTML = students.map(s => {
    const prev = existing.find(g=>g.admissionNo===s.admissionNumber && g.subject===sub);
    const score = prev ? prev.score : '';
    const grade = prev ? prev.grade : '—';
    return `<tr>
      <td>${s.admissionNumber}</td>
      <td class="student-name">${s.firstName} ${s.lastName}</td>
      <td><input type="number" min="0" max="100" value="${score}" data-adm="${s.admissionNumber}" data-name="${s.firstName} ${s.lastName}" oninput="updateGradeCell(this)"></td>
      <td class="grade-cell" id="gc_${s.admissionNumber}">${grade}</td>
      <td><input type="text" placeholder="Optional remarks..." data-adm="${s.admissionNumber}" style="width:160px;padding:0.4rem 0.6rem;border:1px solid #d1d5db;border-radius:6px;font-size:0.88rem;"></td>
    </tr>`;
  }).join('');
  document.getElementById('statStudents').textContent = students.length;
}

function updateGradeCell(input) {
  let score = parseInt(input.value);
  if (isNaN(score)) {
    const cell = document.getElementById('gc_' + input.dataset.adm);
    if (cell) cell.textContent = '—';
    return;
  }
  if (score < 0)   { score = 0;   input.value = 0; }
  if (score > 100) { score = 100; input.value = 100; }
  const cell = document.getElementById('gc_' + input.dataset.adm);
  if (cell) cell.textContent = scoreToGrade(score);
}

async function submitGrades() {
  const cls  = document.getElementById('gradeClass').value;
  const sub  = document.getElementById('gradeSubject').value;
  const term = document.getElementById('gradeTerm').value;
  const exam = document.getElementById('gradeExamType').value;
  if (!cls || !sub) { alert('Please select a class and subject first.'); return; }

  const rows   = document.querySelectorAll('#gradeEntryBody tr');
  const batch  = [];
  let hasError = false;

  rows.forEach(row => {
    const scoreInput  = row.querySelector('input[type="number"]');
    const remarkInput = row.querySelector('input[type="text"]');
    if (!scoreInput || scoreInput.value === '') return;
    const score = parseInt(scoreInput.value);
    if (isNaN(score) || score < 0 || score > 100) {
      scoreInput.style.borderColor = '#dc2626';
      scoreInput.title = 'Score must be 0–100';
      hasError = true;
      return;
    }
    scoreInput.style.borderColor = '';
    batch.push({
      admissionNo:  scoreInput.dataset.adm,
      studentName:  scoreInput.dataset.name,
      class:        cls,
      subject:      sub,
      score,
      term,
      examType:     exam,
      teacherName:  currentUser.fullName,
      datePosted:   new Date().toISOString().split('T')[0],
      remarks:      remarkInput?.value || ''
    });
  });

  if (hasError) { alert('Fix invalid scores (highlighted in red) before saving.'); return; }
  if (!batch.length) { alert('No scores entered yet.'); return; }

  // Save to backend
  try {
    const res = await fetch(`${API}/api/grades`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(batch)
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const result = await res.json();
    if (result.errors && result.errors.length)
      console.warn('Grade save warnings:', result.errors);
  } catch (err) {
    console.warn('Backend save failed, using localStorage fallback:', err.message);
    // localStorage fallback
    const existing = JSON.parse(localStorage.getItem('gradesData') || '[]');
    batch.forEach(entry => {
      const idx = existing.findIndex(g => g.admissionNo === entry.admissionNo && g.subject === entry.subject && g.term === entry.term);
      if (idx >= 0) existing[idx] = entry; else existing.push(entry);
    });
    localStorage.setItem('gradesData', JSON.stringify(existing));
  }

  // Refresh stats
  try {
    const r = await fetch(`${API}/api/grades?class=${encodeURIComponent(cls)}`);
    if (r.ok) {
      const classGrades = await r.json();
      const myCount = classGrades.filter(g => g.teacher_name === currentUser.fullName).length;
      document.getElementById('statGradesPosted').textContent = myCount;
      const avg = classGrades.length ? classGrades.reduce((s,g) => s + g.score, 0) / classGrades.length : 0;
      document.getElementById('statClassAvg').textContent = avg.toFixed(1) + '%';
    }
  } catch {}

  const ok = document.getElementById('gradeSuccess');
  ok.style.display = 'flex';
  setTimeout(() => ok.style.display = 'none', 3000);
}

// ── Attendance ──
function loadAttendanceStudents() {
  const cls = document.getElementById('attClass').value;
  if (!cls) return;

  // ── ATTENDANCE: Only the class teacher of this class may mark attendance ──
  const classTeacherClasses = window._classTeacherClasses || [];
  const myAssignments       = window._teacherAssignments  || [];

  // If we have class teacher data, enforce strictly
  if (classTeacherClasses.length > 0 || myAssignments.length > 0) {
    const isClassTeacher = classTeacherClasses.includes(cls);
    if (!isClassTeacher) {
      const attPrompt = document.getElementById('attPrompt');
      const list      = document.getElementById('attStudentsList');
      if (list)      list.style.display = 'none';
      if (attPrompt) {
        attPrompt.style.display = 'block';
        attPrompt.innerHTML = `
          <div style="background:#fee2e2;border:1px solid #fca5a5;border-radius:10px;
               padding:1.1rem 1.35rem;text-align:left;max-width:480px;margin:0 auto;">
            <div style="font-size:0.95rem;font-weight:700;color:#991b1b;margin-bottom:0.4rem;">
              <i class="fas fa-ban"></i> Attendance Not Permitted
            </div>
            <p style="font-size:0.85rem;color:#7f1d1d;line-height:1.6;margin:0;">
              You are not the class teacher for <strong>${cls}</strong>.
              Only the designated class teacher can mark attendance for this class.
              You can still enter grades for subjects you teach in ${cls}.
            </p>
          </div>`;
      }
      showSyncToast(false, `Attendance for ${cls} can only be marked by the class teacher.`);
      return;
    }
  }

  const students = allStudents.filter(s => s.class===cls || s.grade==cls.replace('Grade ',''));
  document.getElementById('attPrompt').style.display = 'none';
  const list = document.getElementById('attStudentsList');
  if (!students.length) { list.style.display='none'; return; }
  list.style.display = 'block';
  document.getElementById('attEntryBody').innerHTML = students.map(s=>`<tr>
    <td>${s.admissionNumber}</td>
    <td class="student-name">${s.firstName} ${s.lastName}</td>
    <td>
      <select data-adm="${s.admissionNumber}" data-name="${s.firstName} ${s.lastName}" style="padding:0.4rem 0.7rem;border:1px solid #d1d5db;border-radius:6px;font-size:0.88rem;">
        <option value="Present">Present</option>
        <option value="Absent">Absent</option>
        <option value="Late">Late</option>
      </select>
    </td>
    <td><input type="text" placeholder="Remarks..." data-adm="${s.admissionNumber}" style="width:160px;padding:0.4rem 0.6rem;border:1px solid #d1d5db;border-radius:6px;font-size:0.88rem;"></td>
  </tr>`).join('');
  document.getElementById('statAttToday').textContent = students.length + ' students';
}

async function submitAttendance() {
  const cls  = document.getElementById('attClass').value;
  const date = document.getElementById('attDate').value || new Date().toISOString().split('T')[0];
  if (!cls) { alert('Please select a class first.'); return; }

  // Final server-side guard: block submit if not class teacher
  const classTeacherClasses = window._classTeacherClasses || [];
  const myAssignments       = window._teacherAssignments  || [];
  if ((classTeacherClasses.length > 0 || myAssignments.length > 0) && !classTeacherClasses.includes(cls)) {
    showSyncToast(false, `You cannot mark attendance for ${cls} — you are not the class teacher.`);
    return;
  }

  const rows  = document.querySelectorAll('#attEntryBody tr');
  const batch = [];

  rows.forEach(row => {
    const sel = row.querySelector('select');
    const rem = row.querySelector('input[type="text"]');
    if (!sel) return;
    batch.push({
      admissionNo:  sel.dataset.adm,
      studentName:  sel.dataset.name,
      class:        cls,
      date,
      status:       sel.value,
      remarks:      rem?.value || '',
      teacherName:  currentUser.fullName,
    });
  });

  if (!batch.length) { alert('No students loaded. Select a class first.'); return; }

  // Disable button to prevent double-submit
  const saveBtn = document.querySelector('#attStudentsList .btn-primary');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving...'; }

  try {
    const res = await fetch(`${API}/api/attendance`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(batch)
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const result = await res.json();
    if (result.errors && result.errors.length)
      console.warn('Attendance save warnings:', result.errors);
    console.log(`Attendance saved: ${result.saved} records`);
  } catch (err) {
    console.warn('Backend unavailable, using localStorage fallback:', err.message);
    const existing = JSON.parse(localStorage.getItem('attendanceData') || '[]');
    batch.forEach(entry => {
      const idx = existing.findIndex(a => a.admissionNo === entry.admissionNo && a.date === entry.date);
      if (idx >= 0) existing[idx] = entry; else existing.push(entry);
    });
    localStorage.setItem('attendanceData', JSON.stringify(existing));
  } finally {
    if (saveBtn) { saveBtn.disabled = false; saveBtn.innerHTML = '<i class="fas fa-save"></i> Save Attendance'; }
  }

  // Update stat card: count present for selected class on this date
  const present = batch.filter(b => b.status === 'Present').length;
  document.getElementById('statAttToday').textContent = `${present}/${batch.length} present`;

  const ok = document.getElementById('attSuccess');
  ok.style.display = 'flex';
  setTimeout(() => ok.style.display = 'none', 3000);
}

// ── Student profiles ──
function loadStudentProfiles() {
  filteredStudents = [...allStudents];
  renderStudentProfiles();
}

function filterStudentProfiles() {
  const search = document.getElementById('studentSearch').value.toLowerCase();
  const cls    = document.getElementById('studentClassFilter').value;
  filteredStudents = allStudents.filter(s => {
    const name = `${s.firstName} ${s.lastName}`.toLowerCase();
    const matchSearch = !search || name.includes(search) || s.admissionNumber.toLowerCase().includes(search);
    const matchClass  = !cls || s.class===cls || s.grade==cls.replace('Grade ','');
    return matchSearch && matchClass;
  });
  renderStudentProfiles();
}

function renderStudentProfiles() {
  const tbody = document.getElementById('studentsProfileBody');
  if (!filteredStudents.length) { tbody.innerHTML='<tr><td colspan="7" class="empty-cell">No students found.</td></tr>'; return; }
  tbody.innerHTML = filteredStudents.map(s=>`<tr>
    <td>${s.admissionNumber}</td>
    <td class="student-name">${s.firstName} ${s.lastName}</td>
    <td>Grade ${s.grade||s.class}</td>
    <td>${s.gender||'—'}</td>
    <td>${s.guardianName||s.parentName||'—'}</td>
    <td>${s.guardianPhone||s.parentPhone||'—'}</td>
    <td><span class="badge badge-${(s.status||'active').toLowerCase()}">${s.status||'Active'}</span></td>
  </tr>`).join('');
}

// ── Progress report ──
async function generateReport() {
  const cls  = document.getElementById('reportClass').value;
  const term = document.getElementById('reportTerm').value;
  if (!cls) return;

  document.getElementById('reportPrompt').style.display = 'none';
  document.getElementById('reportContent').style.display = 'block';
  // colspan = 1 (Student) + subjects (unknown yet) + 3 (Average, Grade, Position) — use a wide safe value
  document.getElementById('reportBody').innerHTML = '<tr><td colspan="12" style="text-align:center;padding:1.5rem;color:#9ca3af;"><i class="fas fa-spinner fa-spin"></i> Loading...</td></tr>';

  let grades = [];
  try {
    const r = await fetch(`${API}/api/grades?class=${encodeURIComponent(cls)}&term=${encodeURIComponent(term)}`);
    if (r.ok) grades = await r.json();
    else throw new Error('HTTP ' + r.status);
  } catch (err) {
    console.warn('Report: falling back to localStorage:', err.message);
    grades = JSON.parse(localStorage.getItem('gradesData') || '[]')
      .filter(g => g.class === cls && g.term === term);
  }

  if (!grades.length) {
    document.getElementById('reportBody').innerHTML = `<tr><td colspan="${1 + subjects.length + 3}" class="empty-cell">No grades recorded for this class and term yet.</td></tr>`;
    document.getElementById('reportSummary').innerHTML = '';
    return;
  }

  // Discover subjects dynamically from the actual data
  const subjects = [...new Set(grades.map(g => g.subject || g.subject))].filter(Boolean).sort();

  // Group by student
  const byStudent = {};
  grades.forEach(g => {
    const adm  = g.admission_no || g.admissionNo || g.student_id;
    const name = g.student_name || g.studentName || '—';
    if (!byStudent[adm]) byStudent[adm] = { name, scores: {} };
    byStudent[adm].scores[g.subject] = g.score;
  });

  const rows = Object.entries(byStudent).map(([adm, d]) => {
    const scores = subjects.map(s => d.scores[s] ?? null);
    const valid  = scores.filter(s => s !== null);
    const avg    = valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : 0;
    return { adm, name: d.name, scores, avg };
  }).sort((a, b) => b.avg - a.avg);

  const total    = rows.length;
  const classAvg = total ? rows.reduce((s, r) => s + r.avg, 0) / total : 0;

  // Update report table header dynamically
  const thead = document.getElementById('reportThead');
  if (thead) {
    thead.innerHTML = '<tr><th>Student</th>' +
      subjects.map(s => `<th>${s}</th>`).join('') +
      '<th>Average</th><th>Grade</th><th>Position</th></tr>';
  }

  document.getElementById('reportSummary').innerHTML = `
    <div class="rs-item"><strong>${total}</strong><span>Students</span></div>
    <div class="rs-item"><strong>${classAvg.toFixed(1)}%</strong><span>Class Average</span></div>
    <div class="rs-item"><strong>${rows.filter(r => r.avg >= 80).length}</strong><span>Excellent</span></div>
    <div class="rs-item"><strong>${rows.filter(r => r.avg < 40).length}</strong><span>Need Support</span></div>`;

  document.getElementById('reportBody').innerHTML = rows.map((r, i) => `<tr>
    <td class="student-name">${r.name}</td>
    ${r.scores.map(s => `<td>${s !== null ? s : '—'}</td>`).join('')}
    <td><strong>${r.avg.toFixed(1)}%</strong></td>
    <td><span class="badge badge-${scoreToGrade(r.avg)}">${scoreToGrade(r.avg)}</span></td>
    <td><strong>#${i + 1}</strong></td>
  </tr>`).join('');

  // Store for CSV export
  window._reportData = { cls, term, subjects, rows };
}

async function exportReportCSV() {
  const { cls, term, subjects, rows } = window._reportData || {};
  if (!rows || !rows.length) { alert('Generate a report first.'); return; }
  const headers = ['Student', ...subjects, 'Average', 'Grade'];
  const csvRows = rows.map(r => [
    `"${r.name}"`,
    ...r.scores.map(s => s !== null ? s : ''),
    r.avg.toFixed(1),
    scoreToGrade(r.avg)
  ].join(','));
  const csv  = [headers.join(','), ...csvRows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(blob),
    download: `progress-${cls}-${term}.csv`
  });
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
}

// ── Populate dropdowns based on teacher's assignments ─────────
async function populateDropdowns() {
    // Fetch this teacher's subject assignments from DB
    let myAssignments = [];
    try {
        const res = await fetch(`${API}/api/teacher-assignments?teacher_id=${encodeURIComponent(currentUser.id)}`);
        if (res.ok) myAssignments = await res.json();
    } catch (e) {
        console.warn('Could not fetch teacher assignments:', e.message);
    }

    // ── Fetch class teacher assignments (separate table) ─────────
    // A teacher can only mark attendance for classes they are CLASS TEACHER of.
    // They can enter grades for any class they teach a subject in (myAssignments).
    let classTeacherClasses = [];
    try {
        const ctRes = await fetch(`${API}/api/class-teacher-assignments`);
        if (ctRes.ok) {
            const all = await ctRes.json();
            // Filter rows where this teacher is the class teacher
            classTeacherClasses = all
                .filter(ct => ct.teacher_id === currentUser.id)
                .map(ct => ct.class_name);
        }
    } catch (e) {
        console.warn('Could not fetch class teacher assignments:', e.message);
    }

    // Derive allowed classes and subjects from subject assignments
    const myClasses  = [...new Set(myAssignments.map(a => a.class_name))].sort();
    const mySubjects = [...new Set(myAssignments.map(a => a.subject))].sort();

    // Store on window so other functions can reference
    window._teacherAssignments   = myAssignments;
    window._myClasses             = myClasses;
    window._mySubjects            = mySubjects;
    window._classTeacherClasses   = classTeacherClasses; // classes for attendance only

    // If no subject assignments yet, fall back to all students' classes (for grades only)
    const fallbackClasses = myClasses.length > 0
        ? myClasses
        : [...new Set(allStudents.map(s => s.class).filter(Boolean))].sort((a,b) => {
            const na = parseInt(a.replace(/\D/g,''))||0, nb = parseInt(b.replace(/\D/g,''))||0;
            return na-nb || a.localeCompare(b);
          });

    // ── Grade Class dropdown — classes where teacher teaches a subject ──
    const gradeClassSel = document.getElementById('gradeClass');
    if (gradeClassSel) {
        const current = gradeClassSel.value;
        gradeClassSel.innerHTML = '<option value="">Select Class</option>';
        fallbackClasses.forEach(cls => {
            const opt = document.createElement('option');
            opt.value = cls; opt.textContent = cls;
            gradeClassSel.appendChild(opt);
        });
        if (current && fallbackClasses.includes(current)) gradeClassSel.value = current;
    }

    // ── Attendance Class dropdown — ONLY classes where teacher is CLASS TEACHER ──
    const attClassSel = document.getElementById('attClass');
    if (attClassSel) {
        const current = attClassSel.value;
        attClassSel.innerHTML = '<option value="">Select Class</option>';

        if (classTeacherClasses.length === 0) {
            // Not a class teacher for any class — disable and explain
            const opt = document.createElement('option');
            opt.value    = '';
            opt.textContent = 'Not assigned as class teacher';
            opt.disabled = true;
            attClassSel.appendChild(opt);
            attClassSel.disabled = true;
            attClassSel.style.background = '#f3f4f6';
            attClassSel.style.color      = '#9ca3af';
            attClassSel.title = 'Attendance can only be marked by the assigned class teacher. Contact admin to assign you as a class teacher.';

            // Show a notice below the attendance tab prompt
            const attPrompt = document.getElementById('attPrompt');
            if (attPrompt) {
                attPrompt.style.display = 'block';
                attPrompt.innerHTML = `
                  <div style="background:#fef3c7;border:1px solid #fcd34d;border-radius:10px;
                       padding:1.1rem 1.35rem;text-align:left;max-width:480px;margin:0 auto;">
                    <div style="font-size:0.95rem;font-weight:700;color:#92400e;margin-bottom:0.4rem;">
                      <i class="fas fa-lock"></i> Attendance Access Restricted
                    </div>
                    <p style="font-size:0.85rem;color:#78350f;line-height:1.6;margin:0;">
                      You are not currently assigned as a <strong>Class Teacher</strong> for any class.
                      Only the designated class teacher can mark daily attendance.
                      Please ask an administrator to assign you as a class teacher.
                    </p>
                  </div>`;
            }
        } else {
            attClassSel.disabled = false;
            attClassSel.style.background = '';
            attClassSel.style.color      = '';
            attClassSel.title = '';
            classTeacherClasses.forEach(cls => {
                const opt = document.createElement('option');
                opt.value = cls;
                opt.textContent = `${cls}  ★ Class Teacher`;
                attClassSel.appendChild(opt);
            });
            if (current && classTeacherClasses.includes(current)) attClassSel.value = current;
        }
    }

    // ── Student profiles and report class — use subject assignment classes ──
    const otherSelects = ['studentClassFilter', 'reportClass'];
    otherSelects.forEach(id => {
        const sel = document.getElementById(id);
        if (!sel) return;
        const current  = sel.value;
        const isFilter = id === 'studentClassFilter';
        sel.innerHTML  = `<option value="">${isFilter?'All Classes':'Select Class'}</option>`;
        fallbackClasses.forEach(cls => {
            const opt = document.createElement('option');
            opt.value = cls; opt.textContent = cls;
            sel.appendChild(opt);
        });
        if (current && fallbackClasses.includes(current)) sel.value = current;
    });

    // Grade subject dropdown — restrict to assigned subjects if available
    const standardSubjects = [
        // Pre-Primary
        'Language Activities', 'Mathematics Activities', 'Environmental Activities',
        'Psychomotor & Creative Activities', 'Religious Education Activities',
        // Lower Primary (Gr 1–3)
        'English Activities', 'Kiswahili Activities', 'Hygiene & Nutrition Activities',
        'Movement & Creative Activities',
        // Upper Primary (Gr 4–6)
        'English', 'Kiswahili', 'Mathematics', 'Science & Technology', 'Agriculture',
        'Home Science', 'Creative Arts', 'Social Studies', 'Religious Education',
        'Physical & Health Education',
        // Junior Secondary (Gr 7–9)
        'Integrated Science', 'Business Studies', 'Pre-Technical & Pre-Career Education',
        'Sports & Physical Education', 'Life Skills Education', 'Health Education'
    ];
    const subjectPool = mySubjects.length > 0 ? mySubjects : standardSubjects;

    const subjectSel = document.getElementById('gradeSubject');
    if (subjectSel) {
        const current = subjectSel.value;
        subjectSel.innerHTML = '<option value="">Select Subject</option>';
        subjectPool.forEach(sub => {
            const opt = document.createElement('option');
            opt.value = sub; opt.textContent = sub;
            subjectSel.appendChild(opt);
        });
        if (current && subjectPool.includes(current)) subjectSel.value = current;
    }

    // Show assignment info banner
    if (myAssignments.length > 0 || classTeacherClasses.length > 0) {
        showAssignmentBanner(myAssignments, classTeacherClasses);
    }
}

// ── Sync students from database ──────────────────
async function syncStudents(silent = false) {
  const btn  = document.getElementById('syncStudentsBtn');
  const icon = btn ? btn.querySelector('i') : null;

  // Show loading state
  if (!silent && btn) {
    btn.disabled = true;
    btn.style.opacity = '0.7';
    btn.style.cursor  = 'not-allowed';
    if (icon) { icon.classList.remove('fa-sync-alt'); icon.classList.add('fa-spinner', 'fa-spin'); }
    btn.childNodes[btn.childNodes.length - 1].textContent = ' Syncing...';
  }

  try {
    const r = await fetch(`${API}/api/students`);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const raw = await r.json();

    // Normalise fields — /api/students returns fullName, studentClass, etc.
    allStudents = raw.map(s => {
      const parts = (s.fullName || '').trim().split(' ');
      return {
        ...s,
        firstName:     parts[0] || '',
        lastName:      parts.slice(1).join(' ') || '',
        class:         s.studentClass || '',
        grade:         (s.studentClass || '').replace('Grade ', ''),
        admissionNumber: s.admissionNumber || s.id,
        parentName:    s.parentName || '',
        parentPhone:   s.parentPhone || '',
      };
    });

    // Persist a local copy as fallback
    localStorage.setItem('students', JSON.stringify(allStudents));

    // Rebuild class + subject dropdowns from live data
    populateDropdowns();

    // Update stat card
    document.getElementById('statStudents').textContent = allStudents.length;

    // Refresh any open class list
    const gradeClass = document.getElementById('gradeClass');
    if (gradeClass && gradeClass.value) loadClassStudents();
    const attClass = document.getElementById('attClass');
    if (attClass && attClass.value) loadAttendanceStudents();

    // Refresh profiles tab
    filterStudentProfiles();

    if (!silent) showSyncToast(true, `${allStudents.length} student${allStudents.length !== 1 ? 's' : ''} synced from database`);

  } catch (err) {
    console.warn('Sync failed, using local cache:', err.message);
    // Fall back to cached students
    const cached = JSON.parse(localStorage.getItem('students') || '[]');
    if (cached.length) {
      allStudents = cached;
      populateDropdowns();
      document.getElementById('statStudents').textContent = allStudents.length;
      filterStudentProfiles();
    }
    if (!silent) showSyncToast(false, 'Could not reach server — showing cached data');
  } finally {
    // Restore button
    if (!silent && btn) {
      btn.disabled = false;
      btn.style.opacity = '1';
      btn.style.cursor  = 'pointer';
      if (icon) { icon.classList.remove('fa-spinner', 'fa-spin'); icon.classList.add('fa-sync-alt'); }
      btn.childNodes[btn.childNodes.length - 1].textContent = ' Sync Students';
    }
  }
}

function showSyncToast(success, message) {
  // Remove any existing toast
  const old = document.getElementById('syncToast');
  if (old) old.remove();

  const toast = document.createElement('div');
  toast.id = 'syncToast';
  toast.style.cssText = `
    position:fixed; bottom:1.5rem; right:1.5rem; z-index:9999;
    background:${success ? '#065f46' : '#dc2626'}; color:#fff;
    padding:0.85rem 1.4rem; border-radius:10px;
    font-size:0.9rem; font-weight:600;
    display:flex; align-items:center; gap:10px;
    box-shadow:0 4px 18px rgba(0,0,0,0.22);
    animation:slideInToast 0.3s ease;
  `;
  toast.innerHTML = `<i class="fas ${success ? 'fa-check-circle' : 'fa-exclamation-circle'}"></i> ${message}`;

  // Add keyframe if not already added
  if (!document.getElementById('toastStyle')) {
    const style = document.createElement('style');
    style.id = 'toastStyle';
    style.textContent = '@keyframes slideInToast{from{transform:translateY(20px);opacity:0}to{transform:translateY(0);opacity:1}}';
    document.head.appendChild(style);
  }

  document.body.appendChild(toast);
  setTimeout(() => { toast.style.opacity='0'; toast.style.transition='opacity 0.4s'; setTimeout(()=>toast.remove(), 400); }, 4000);
}

// ── Assignment info banner ────────────────────────────────────
function showAssignmentBanner(assignments, classTeacherClasses = []) {
    const existing = document.getElementById('assignmentBanner');
    if (existing) existing.remove();

    // Subject assignments — grouped by class
    const byClass = {};
    assignments.forEach(a => {
        (byClass[a.class_name] = byClass[a.class_name]||[]).push(a.subject);
    });

    const subjectLines = Object.entries(byClass)
        .map(([cls, subs]) => {
            const isCT = classTeacherClasses.includes(cls);
            return `<span style="margin-right:1rem;">
                <strong>${cls}</strong>: ${subs.join(', ')}
                ${isCT ? '<span style="background:#fef3c7;color:#92400e;padding:1px 6px;border-radius:10px;font-size:0.75rem;font-weight:700;margin-left:4px;">★ Class Teacher</span>' : ''}
            </span>`;
        }).join('');

    // Class teacher summary line
    const ctLine = classTeacherClasses.length > 0
        ? `<div style="margin-top:0.4rem;font-size:0.82rem;color:#065f46;">
               <i class="fas fa-star" style="color:#d97706;margin-right:4px;"></i>
               <strong>Class Teacher of:</strong> ${classTeacherClasses.join(', ')}
               &nbsp;·&nbsp; Can mark attendance for these classes
           </div>`
        : `<div style="margin-top:0.4rem;font-size:0.82rem;color:#9ca3af;">
               <i class="fas fa-info-circle" style="margin-right:4px;"></i>
               Not assigned as class teacher — attendance marking not available
           </div>`;

    const banner = document.createElement('div');
    banner.id = 'assignmentBanner';
    banner.style.cssText = `background:#ecfdf5;border:1px solid #6ee7b7;color:#065f46;
        padding:0.85rem 1.25rem;border-radius:10px;margin-bottom:1rem;font-size:0.88rem;`;
    banner.innerHTML = `
        <div style="display:flex;align-items:center;gap:0.5rem;font-weight:700;margin-bottom:0.3rem;">
            <i class="fas fa-chalkboard-teacher"></i> Your Teaching Assignments
        </div>
        <div style="flex-wrap:wrap;">${subjectLines || '<em style="color:#9ca3af;">No subject assignments yet</em>'}</div>
        ${ctLine}`;

    const main = document.querySelector('.main-content') || document.querySelector('main');
    if (main) main.insertBefore(banner, main.firstChild);
}

window.addEventListener('load', async () => {
  const raw = sessionStorage.getItem('currentUser');
  if (!raw) { logout(); return; }
  currentUser = JSON.parse(raw);
  if ((currentUser.role || '').toLowerCase() !== 'teacher') { alert('Access denied...'); logout(); return; }
  document.getElementById('userName').textContent    = currentUser.fullName || currentUser.email;
  document.getElementById('welcomeName').textContent = (currentUser.fullName||'Teacher').split(' ')[0];
  document.getElementById('attDate').value = new Date().toISOString().split('T')[0];
  await syncStudents(true); // loads allStudents first
  await populateDropdowns(); // then restrict to assigned classes/subjects
  const myGrades = JSON.parse(localStorage.getItem('gradesData')||'[]').filter(g=>g.teacherName===currentUser.fullName);
  document.getElementById('statGradesPosted').textContent = myGrades.length;
  loadStudentProfiles();
});