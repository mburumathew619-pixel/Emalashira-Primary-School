const API_BASE_URL = "https://emalashira-primary-school.onrender.com";
let students = [];
let currentEditId = null;

// ── Auth ──────────────────────────────────────────────────────
function logout() {
  sessionStorage.removeItem('currentUser');
  window.location.href = 'login.html';
}

function loadUserInfo() {
  const raw = sessionStorage.getItem('currentUser');
  if (!raw) { logout(); return; }
  const user = JSON.parse(raw);
  document.getElementById('userNameDisplay').textContent = user.fullName || user.email;
  document.getElementById('roleBadge').textContent = user.role || 'User';
}

// ── Toast ─────────────────────────────────────────────────────
function showToast(msg, isError = false) {
  let t = document.getElementById('toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    t.style.cssText = 'position:fixed;bottom:24px;right:24px;padding:12px 20px;' +
      'border-radius:8px;font-size:.95rem;z-index:9999;color:#fff;' +
      'box-shadow:0 4px 12px rgba(0,0,0,.2);transition:opacity .3s;';
    document.body.appendChild(t);
  }
  t.style.background = isError ? '#dc2626' : '#065f46';
  t.textContent = msg;
  t.style.opacity = '1';
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.style.opacity = '0'; }, 3500);
}

// ── Load students from students table ────────────────────────
async function loadStudents() {
  document.getElementById('studentsTableBody').innerHTML =
    '<tr><td colspan="7" class="empty-state">' +
    '<i class="fas fa-spinner fa-spin"></i><p>Loading students...</p></td></tr>';
  try {
    const res = await fetch(`${API_BASE_URL}/api/students`);
    if (!res.ok) throw new Error('Server error ' + res.status);
    students = await res.json();
  } catch (e) {
    console.warn('Load error:', e);
    students = [];
    showToast('Could not reach backend: ' + e.message, true);
  }
  renderStudents(students);
  updateStats(students);
}

// ── Sync button — pulls users with role=Student into students table ──
async function syncStudentsFromUsers() {
  const btn = document.getElementById('syncBtn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Syncing...'; }

  try {
    const syncRes = await fetch(`${API_BASE_URL}/api/students/sync`, { method: 'POST' });
    if (!syncRes.ok) throw new Error('Sync request failed');
    const syncData = await syncRes.json();

    // Reload the table with fresh data from students table
    await loadStudents();

    const note = document.getElementById('syncNotification');
    const msg  = document.getElementById('syncMessage');
    if (note && msg) {
      msg.textContent = `✅ Synced ${syncData.count} student${syncData.count !== 1 ? 's' : ''} from Manage Users into the students database.`;
      note.style.display = 'flex';
      setTimeout(() => { note.style.display = 'none'; }, 5000);
    }
    showToast(`✅ ${students.length} students loaded`);
  } catch (e) {
    showToast('❌ Sync failed: ' + e.message, true);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🔄 Sync from Users'; }
  }
}

// ── Stats ─────────────────────────────────────────────────────
function updateStats(list) {
  const yr = new Date().getFullYear();
  document.getElementById('totalStudents').textContent =
    list.length;
  document.getElementById('activeStudents').textContent =
    list.filter(s => (s.status || '').toLowerCase() === 'active').length;
  document.getElementById('newStudents').textContent =
    list.filter(s => s.admissionDate && new Date(s.admissionDate).getFullYear() === yr).length;
  document.getElementById('graduatingStudents').textContent =
    list.filter(s => (s.studentClass || '').trim() === 'Grade 8').length;
}

// ── Render table ──────────────────────────────────────────────
function renderStudents(list) {
  const tbody = document.getElementById('studentsTableBody');
  if (!list.length) {
    tbody.innerHTML =
      '<tr><td colspan="7" class="empty-state">' +
      '<i class="fas fa-user-graduate" style="font-size:2rem;display:block;margin-bottom:.5rem;color:#d1fae5;"></i>' +
      '<p>No students found. Click "Sync from Users" to import from Manage Users, or "Add Student" to add manually.</p>' +
      '</td></tr>';
    return;
  }
  tbody.innerHTML = list.map(s => {
    const dob    = s.date_of_birth ? new Date(s.date_of_birth).toLocaleDateString('en-GB') : '—';
    const active = (s.status || 'active').toLowerCase() === 'active';
    const badge  = active
      ? '<span style="background:#d1fae5;color:#065f46;padding:3px 10px;border-radius:999px;font-size:.78rem;font-weight:600;">Active</span>'
      : '<span style="background:#fee2e2;color:#dc2626;padding:3px 10px;border-radius:999px;font-size:.78rem;font-weight:600;">Inactive</span>';
    const safe = (s.fullName || '').replace(/'/g, "\\'");
    return `<tr>
      <td><strong>${s.admissionNumber || '—'}</strong></td>
      <td>${s.fullName || '—'}</td>
      <td>${s.studentClass || '—'}</td>
      <td>${s.gender || '—'}</td>
      <td>${dob}</td>
      <td>${badge}</td>
      <td>
        <button onclick="openEditModal('${s.id}')" title="Edit"
          style="background:#065f46;color:#fff;border:none;padding:5px 10px;border-radius:5px;cursor:pointer;margin-right:4px;">
          <i class="fas fa-edit"></i>
        </button>
        <button onclick="deleteStudent('${s.id}','${safe}')" title="Delete"
          style="background:#dc2626;color:#fff;border:none;padding:5px 10px;border-radius:5px;cursor:pointer;">
          <i class="fas fa-trash"></i>
        </button>
      </td>
    </tr>`;
  }).join('');
}

// ── Filters & Search ──────────────────────────────────────────
function filterStudents() {
  const grade  = document.getElementById('gradeFilter').value;
  const status = document.getElementById('statusFilter').value;
  const gender = document.getElementById('genderFilter').value;
  const q      = (document.getElementById('searchInput').value || '').toLowerCase();
  const filtered = students.filter(s =>
    (!grade  || (s.studentClass || '').trim() === grade) &&
    (!status || (s.status || '').toLowerCase() === status) &&
    (!gender || (s.gender || '').toLowerCase() === gender.toLowerCase()) &&
    (!q      || (s.fullName || '').toLowerCase().includes(q) ||
                (s.admissionNumber || '').toLowerCase().includes(q))
  );
  renderStudents(filtered);
  updateStats(filtered);
}

// ── Load parent name suggestions into the guardian datalist ──
async function loadParentSuggestions() {
  try {
    const res = await fetch(`${API_BASE_URL}/api/users`);
    if (!res.ok) return;
    const users = await res.json();
    const parents = users.filter(u => (u.role || '').toLowerCase() === 'parent');
    let dl = document.getElementById('parentSuggestions');
    if (!dl) {
      dl = document.createElement('datalist');
      dl.id = 'parentSuggestions';
      document.body.appendChild(dl);
    }
    dl.innerHTML = parents.map(p =>
      `<option value="${p.fullName || ''}" data-phone="${p.phone || ''}" data-email="${p.email || ''}"></option>`
    ).join('');
    // Wire guardian name input to auto-fill phone when a parent is selected
    const nameInput  = document.getElementById('guardianName');
    const phoneInput = document.getElementById('guardianPhone');
    if (nameInput) {
      nameInput.setAttribute('list', 'parentSuggestions');
      nameInput.addEventListener('input', function() {
        const opt = [...dl.options].find(o => o.value.toLowerCase() === this.value.toLowerCase());
        if (opt && phoneInput && !phoneInput.value) {
          phoneInput.value = opt.getAttribute('data-phone') || '';
        }
      });
    }
  } catch(e) { console.warn('Could not load parent suggestions:', e); }
}

// ── Modal: Add ────────────────────────────────────────────────
// ── Next available admission number ───────────────────────────
// Fetches all existing students, finds the highest ADM number,
// and returns the next sequential one (e.g. ADM102 after ADM101).
// Never reuses a number even if gaps exist in the sequence.
async function getNextAdmissionNumber() {
  try {
    // Use the already-loaded students array if available, else fetch fresh
    const list = students.length > 0
      ? students
      : await fetch(`${API_BASE_URL}/api/students`).then(r => r.ok ? r.json() : []);

    // Extract numeric parts from all ADM### style admission numbers
    let maxNum = 0;
    list.forEach(s => {
      const adm = (s.admissionNumber || '').toUpperCase().trim();
      // Match ADM followed by one or more digits (e.g. ADM001, ADM102, ADM1023)
      const match = adm.match(/^ADM(\d+)$/);
      if (match) {
        const n = parseInt(match[1], 10);
        if (n > maxNum) maxNum = n;
      }
    });

    // Next number = highest found + 1, zero-padded to at least 3 digits
    const nextNum = maxNum + 1;
    const padded  = String(nextNum).padStart(3, '0');
    return `ADM${padded}`;
  } catch {
    return 'ADM001'; // safe fallback
  }
}

function openAddModal() {
  currentEditId = null;
  document.getElementById('drawerTitle').textContent    = 'Add New Student';
  document.getElementById('drawerSubtitle').textContent = 'Fill in the student details below';
  document.getElementById('studentForm').reset();
  loadParentSuggestions();
  document.getElementById('studentDrawer').classList.add('open');

  // Auto-suggest next admission number and mark field as suggested
  const admEl = document.getElementById('admissionNumber');
  if (admEl) {
    admEl.value       = 'Generating…';
    admEl.disabled    = true;
    admEl.style.color = '#9ca3af';

    getNextAdmissionNumber().then(next => {
      admEl.value       = next;
      admEl.disabled    = false;
      admEl.style.color = '#065f46';
      admEl.style.fontWeight = '700';
      admEl.title = 'Auto-suggested next available number. You may change it if needed.';

      // Validate on blur — warn if the number is already taken
      admEl.onblur = () => validateAdmissionNumber(admEl);
    });
  }
}

// ── Modal: Edit ───────────────────────────────────────────────
function openEditModal(id) {
  const s = students.find(x => x.id === id);
  if (!s) return;
  currentEditId = id;
  document.getElementById('drawerTitle').textContent    = 'Edit Student';
  document.getElementById('drawerSubtitle').textContent = `Editing: ${s.fullName}`;
  const parts = (s.fullName || '').split(' ');
  document.getElementById('admissionNumber').value = s.admissionNumber || '';
  document.getElementById('grade').value           = s.studentClass    || '';
  document.getElementById('firstName').value       = parts[0]          || '';
  document.getElementById('lastName').value        = parts.slice(1).join(' ') || '';
  document.getElementById('gender').value          = s.gender          || '';
  document.getElementById('dateOfBirth').value     = s.date_of_birth   || '';
  document.getElementById('admissionDate').value   = s.admissionDate   || '';
  document.getElementById('guardianName').value    = s.parentName      || '';
  document.getElementById('guardianPhone').value   = s.parentPhone     || '';
  document.getElementById('address').value         = s.address         || '';
  document.getElementById('status').value          = s.status          || 'active';
  loadParentSuggestions();
  document.getElementById('studentDrawer').classList.add('open');
}

function closeModal() {
  document.getElementById('studentDrawer').classList.remove('open');
}

function handleOverlayClick(e) {
  if (e.target === document.getElementById('studentDrawer')) closeModal();
}

// ── Validate admission number — warn if already taken ─────────
function validateAdmissionNumber(inputEl) {
  const val = (inputEl.value || '').trim().toUpperCase();
  if (!val) return true;

  // Check against existing students (excluding the one currently being edited)
  const duplicate = students.find(s =>
    (s.admissionNumber || '').toUpperCase().trim() === val &&
    s.id !== currentEditId
  );

  if (duplicate) {
    inputEl.style.borderColor = '#dc2626';
    inputEl.style.background  = '#fee2e2';
    inputEl.style.color       = '#991b1b';
    // Show inline warning below the field
    let warn = document.getElementById('admissionNumberWarning');
    if (!warn) {
      warn = document.createElement('div');
      warn.id = 'admissionNumberWarning';
      warn.style.cssText = 'color:#dc2626;font-size:0.78rem;font-weight:600;margin-top:4px;display:flex;align-items:center;gap:4px;';
      inputEl.parentNode.appendChild(warn);
    }
    warn.innerHTML = `<i class="fas fa-exclamation-circle"></i> "${val}" is already assigned to <strong>${duplicate.fullName}</strong>. Choose a different number.`;
    return false;
  } else {
    // Clear any warning
    inputEl.style.borderColor = '';
    inputEl.style.background  = '';
    inputEl.style.color       = '#065f46';
    const warn = document.getElementById('admissionNumberWarning');
    if (warn) warn.remove();
    return true;
  }
}

// ── Save (Add Student / Update) ───────────────────────────────
async function saveStudent(e) {
  e.preventDefault();

  // ── Block save if admission number is already taken ──────────
  const admEl = document.getElementById('admissionNumber');
  if (admEl && !validateAdmissionNumber(admEl)) {
    showToast('Admission number already in use — please choose a different one.', true);
    admEl.focus();
    return;
  }
  const payload = {
    fullName:        (document.getElementById('firstName').value.trim() + ' ' +
                      document.getElementById('lastName').value.trim()).trim(),
    admissionNumber: document.getElementById('admissionNumber').value.trim(),
    studentClass:    document.getElementById('grade').value,
    gender:          document.getElementById('gender').value,
    date_of_birth:   document.getElementById('dateOfBirth').value  || null,
    parentName:      document.getElementById('guardianName').value.trim()  || null,
    parentPhone:     document.getElementById('guardianPhone').value.trim() || null,
    address:         document.getElementById('address').value.trim()       || null,
    status:          document.getElementById('status').value,
    admissionDate:   document.getElementById('admissionDate').value || null
  };

  try {
    let res;
    if (currentEditId) {
      // Update existing student in students table
      res = await fetch(`${API_BASE_URL}/api/students/${currentEditId}`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload)
      });
    } else {
      // Add new student directly to students table
      res = await fetch(`${API_BASE_URL}/api/students`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload)
      });
    }
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.message || 'Save failed');
    }

    // ── Link student back to their parent's children array ──────
    // When a student is added/updated via this page and a guardian name is provided,
    // find the matching parent account and update their children JSON so the link
    // shows up in Manage Users and the parent dashboard.
    if (payload.parentName) {
      try {
        const usersRes = await fetch(`${API_BASE_URL}/api/users`);
        if (usersRes.ok) {
          const allUsers = await usersRes.json();
          // Find the parent whose fullName matches the guardian name entered
          const matchedParent = allUsers.find(u =>
            (u.role || '').toLowerCase() === 'parent' &&
            (u.fullName || '').toLowerCase().trim() === (payload.parentName || '').toLowerCase().trim()
          );
          if (matchedParent) {
            // Build the updated children array — replace existing entry for this admission number or append
            const existingChildren = Array.isArray(matchedParent.children) ? matchedParent.children : [];
            const admNo = payload.admissionNumber || '';
            const childEntry = {
              childName:       payload.fullName        || '',
              admissionNumber: admNo,
              className:       payload.studentClass    || '',
              relationship:    'Parent'
            };
            const idx = existingChildren.findIndex(c =>
              (c.admissionNumber || c.admNo || '').toLowerCase() === admNo.toLowerCase()
            );
            if (idx >= 0) existingChildren[idx] = childEntry;
            else          existingChildren.push(childEntry);

            // Patch the parent record with the updated children list
            await fetch(`${API_BASE_URL}/api/users/update-by-email`, {
              method:  'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                targetEmail: matchedParent.email,
                fullName:    matchedParent.fullName,
                phone:       matchedParent.phone       || null,
                date_of_birth: matchedParent.date_of_birth || null,
                gender:      matchedParent.gender      || null,
                address:     matchedParent.address     || null,
                role:        'parent',
                status:      matchedParent.status      || 'active',
                children:    existingChildren
              })
            });
          }
        }
      } catch (linkErr) {
        // Non-fatal — student was saved, just the parent link failed
        console.warn('Could not link student to parent:', linkErr);
      }
    }
    // ────────────────────────────────────────────────────────────

    showToast(currentEditId ? '✅ Student updated' : '✅ Student added to database');
    closeModal();
    await loadStudents();
  } catch (err) {
    showToast('❌ ' + err.message, true);
  }
}

// ── Delete ────────────────────────────────────────────────────
async function deleteStudent(id, name) {
  if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;
  try {
    const res = await fetch(`${API_BASE_URL}/api/students/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Delete failed');
    showToast('✅ Student deleted');
    await loadStudents();
  } catch (err) {
    showToast('❌ ' + err.message, true);
  }
}

// ── Boot ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadUserInfo();
  loadStudents();
  const searchInput = document.getElementById('searchInput');
  if (searchInput) searchInput.addEventListener('input', filterStudents);
});

// Reload on bfcache restore to ensure fresh session check
window.addEventListener('pageshow', (e) => {
  if (e.persisted) {
    const raw = sessionStorage.getItem('currentUser');
    if (!raw) window.location.href = 'login.html';
  }
});
