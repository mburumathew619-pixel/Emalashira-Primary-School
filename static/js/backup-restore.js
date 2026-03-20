/**
 * backup-restore.js — EMALASHIRA Primary School
 * Full-system backup and restore
 * Covers: admins, teachers, parents, accountants, students,
 *         roles & permissions, fee structures, fee payments,
 *         grades, attendance, announcements, teacher assignments
 */

const API = 'http://localhost:5000';

// ── In-session backup history ──────────────────────────────────
const sessionHistory = [];

// ── Auth ───────────────────────────────────────────────────────
function logout() {
  sessionStorage.removeItem('currentUser');
  window.location.href = 'login.html';
}

// ── Helpers ────────────────────────────────────────────────────
function setTile(id, text, state) {
  const tile  = document.getElementById(id);
  const count = tile && tile.querySelector('.cat-count');
  if (!tile || !count) return;
  tile.classList.remove('ct-loading', 'ct-done', 'ct-error');
  tile.classList.add(`ct-${state}`);
  count.textContent = text;
}

function showStatus(elId, type, html) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.style.display    = 'flex';
  el.style.background = type === 'success' ? '#d1fae5' : '#fee2e2';
  el.style.color      = type === 'success' ? '#065f46' : '#dc2626';
  el.style.border     = `1px solid ${type === 'success' ? '#6ee7b7' : '#fca5a5'}`;
  el.innerHTML        = `<i class="fas fa-${type === 'success' ? 'check-circle' : 'times-circle'}"></i> ${html}`;
  if (type === 'success') setTimeout(() => { el.style.display = 'none'; }, 10000);
}

function setProgress(pct, label) {
  const wrap  = document.getElementById('progressWrap');
  const fill  = document.getElementById('progressFill');
  const lbl   = document.getElementById('progressLabel');
  if (!wrap) return;
  wrap.style.display = 'block';
  fill.style.width   = pct + '%';
  if (lbl && label) lbl.textContent = label;
}

function hideProgress() {
  const wrap = document.getElementById('progressWrap');
  if (wrap) wrap.style.display = 'none';
}

// Safe fetch — returns fallback on any failure.
// Pass null as fallback to distinguish "endpoint doesn't exist" from "returned empty array"
async function safeFetch(url, fallback = []) {
  try {
    const r = await fetch(url);
    if (!r.ok) return fallback;
    const data = await r.json();
    return data;
  } catch {
    return fallback;
  }
}

// ── BACKUP STEPS ───────────────────────────────────────────────
// The backend stores each role in its OWN table (admins, teachers, parents, accountants).
// /api/users returns ALL users — so we fetch the full list once and filter client-side
// by the 'role' field that the backend attaches to each record.
// This avoids the bug where all tiles showed 36 (the total user count).

async function fetchAllUsers() {
  // Cache so we only hit the endpoint once per backup
  if (fetchAllUsers._cache) return fetchAllUsers._cache;
  const data = await safeFetch(`${API}/api/users`, []);
  const users = Array.isArray(data) ? data : (data.users || []);
  fetchAllUsers._cache = users;
  return users;
}

function byRole(role) {
  // Returns a fetch fn that pulls only users matching the given role string
  return async () => {
    const all = await fetchAllUsers();
    return all.filter(u => (u.role || '').toLowerCase() === role.toLowerCase());
  };
}

const BACKUP_STEPS = [
  {
    id:    'cat-admins',
    label: 'Admins',
    key:   'admins',
    // Use dedicated role endpoint first; fall back to filtering all-users
    fetch: async () => {
      const d = await safeFetch(`${API}/api/users/by-role/admin`, null);
      if (d !== null) return Array.isArray(d) ? d : d.users || d.admins || [];
      return byRole('admin')();
    }
  },
  {
    id:    'cat-teachers',
    label: 'Teachers',
    key:   'teachers',
    fetch: async () => {
      const d = await safeFetch(`${API}/api/users/by-role/teacher`, null);
      if (d !== null) return Array.isArray(d) ? d : d.users || d.teachers || [];
      return byRole('teacher')();
    }
  },
  {
    id:    'cat-parents',
    label: 'Parents',
    key:   'parents',
    fetch: async () => {
      const d = await safeFetch(`${API}/api/users/by-role/parent`, null);
      if (d !== null) return Array.isArray(d) ? d : d.users || d.parents || [];
      return byRole('parent')();
    }
  },
  {
    id:    'cat-accountants',
    label: 'Accountants',
    key:   'accountants',
    fetch: async () => {
      const d = await safeFetch(`${API}/api/users/by-role/accountant`, null);
      if (d !== null) return Array.isArray(d) ? d : d.users || d.accountants || [];
      return byRole('accountant')();
    }
  },
  {
    id:    'cat-students',
    label: 'Students',
    key:   'students',
    fetch: () => safeFetch(`${API}/api/students`, [])
      .then(d => Array.isArray(d) ? d : d.students || [])
  },
  {
    id:    'cat-roles',
    label: 'Roles & Permissions',
    key:   'roles',
    fetch: () => safeFetch(`${API}/api/roles`, [])
      .then(d => Array.isArray(d) ? d : d.roles || [])
  },
  {
    id:    'cat-fees',
    label: 'Fee Structures',
    key:   'fee_structures',
    // Try multiple possible endpoint patterns for fee structures
    fetch: async () => {
      for (const url of [
        `${API}/api/fees/structures`,
        `${API}/api/fee-structure`,
        `${API}/api/fees/structure`
      ]) {
        const d = await safeFetch(url, null);
        if (d !== null) return Array.isArray(d) ? d : d.fee_structures || d.structures || [];
      }
      return [];
    }
  },
  {
    id:    'cat-payments',
    label: 'Fee Payments',
    key:   'fee_payments',
    fetch: async () => {
      for (const url of [
        `${API}/api/fees/payments`,
        `${API}/api/fee-payments`,
        `${API}/api/fees/all-payments`
      ]) {
        const d = await safeFetch(url, null);
        if (d !== null) return Array.isArray(d) ? d : d.fee_payments || d.payments || [];
      }
      return [];
    }
  },
  {
    id:    'cat-grades',
    label: 'Grades',
    key:   'grades',
    fetch: () => safeFetch(`${API}/api/grades`, [])
      .then(d => Array.isArray(d) ? d : d.grades || [])
  },
  {
    id:    'cat-attendance',
    label: 'Attendance',
    key:   'attendance',
    fetch: () => safeFetch(`${API}/api/attendance`, [])
      .then(d => Array.isArray(d) ? d : d.attendance || [])
  },
  {
    id:    'cat-announcements',
    label: 'Announcements',
    key:   'announcements',
    fetch: () => safeFetch(`${API}/api/announcements`, [])
      .then(d => Array.isArray(d) ? d : d.announcements || [])
  },
  {
    id:    'cat-assignments',
    label: 'Teacher Assignments',
    key:   'teacher_assignments',
    fetch: () => safeFetch(`${API}/api/teacher-assignments/summary`, [])
      .then(d => {
        // The summary endpoint returns teacher objects each with an assignments[]
        // Flatten into individual assignment records for the backup
        if (Array.isArray(d)) {
          const flat = [];
          d.forEach(t => (t.assignments || []).forEach(a => flat.push(a)));
          return flat;
        }
        return [];
      })
  }
];

// ── CREATE BACKUP ──────────────────────────────────────────────
async function createBackup() {
  const btn = document.getElementById('createBackupBtn');
  btn.disabled    = true;
  btn.innerHTML   = '<i class="fas fa-spinner fa-spin"></i> Collecting data…';
  document.getElementById('backupStatus').style.display = 'none';

  // Clear user cache so each backup fetches fresh data
  fetchAllUsers._cache = null;

  const backup = {
    _meta: {
      version:    '2.0',
      system:     'EMALASHIRA Primary School',
      created_at: new Date().toISOString(),
      created_by: (() => {
        try { return JSON.parse(sessionStorage.getItem('currentUser') || '{}').fullName || 'Admin'; }
        catch { return 'Admin'; }
      })()
    }
  };

  const total = BACKUP_STEPS.length;

  for (let i = 0; i < total; i++) {
    const step = BACKUP_STEPS[i];
    const pct  = Math.round(((i) / total) * 100);
    setProgress(pct, `Collecting ${step.label}…`);
    setTile(step.id, '⏳ fetching…', 'loading');

    try {
      const data     = await step.fetch();
      const count    = Array.isArray(data) ? data.length : Object.keys(data).length;
      backup[step.key] = data;
      setTile(step.id, `✓ ${count} record${count !== 1 ? 's' : ''}`, 'done');
    } catch (err) {
      backup[step.key] = [];
      setTile(step.id, '⚠ fetch failed', 'error');
      console.warn(`Backup step "${step.label}" failed:`, err);
    }
  }

  setProgress(100, 'Packaging backup file…');

  // Also try the server-side full backup endpoint as a supplement
  try {
    const serverBackup = await safeFetch(`${API}/api/backup`, {});
    if (serverBackup && serverBackup.backup) {
      // Merge any keys the server returns that we don't already have
      Object.keys(serverBackup.backup).forEach(k => {
        if (!(k in backup) && k !== '_meta') {
          backup[k] = serverBackup.backup[k];
        }
      });
    }
  } catch { /* server backup endpoint optional */ }

  // Count total records
  const totalRecords = BACKUP_STEPS.reduce((sum, s) => {
    const d = backup[s.key];
    return sum + (Array.isArray(d) ? d.length : 0);
  }, 0);

  // Download
  const filename = `emalashira-backup-${new Date().toISOString().slice(0,10)}.json`;
  const blob     = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const url      = URL.createObjectURL(blob);
  const a        = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  hideProgress();
  btn.disabled  = false;
  btn.innerHTML = '<i class="fas fa-download"></i> Create &amp; Download Full Backup';

  const sizekb = (blob.size / 1024).toFixed(1);
  showStatus('backupStatus', 'success',
    `Backup downloaded: <strong>${filename}</strong> — ${totalRecords} total records, ${sizekb} KB`);

  // Add to session history
  sessionHistory.unshift({ filename, totalRecords, sizekb, time: new Date().toLocaleString() });
  renderHistory();
}

// ── RESTORE BACKUP ─────────────────────────────────────────────
function handleFileSelect(file) {
  if (!file) return;
  document.getElementById('selectedFileName').textContent = file.name;
  document.getElementById('selectedFileName').style.display = 'block';

  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = JSON.parse(e.target.result);
      showRestorePreview(data, file);
      document.getElementById('restoreBackupBtn').disabled = false;
      // Store for use in restore
      document.getElementById('restoreBackupBtn')._backupData = data;
    } catch {
      showStatus('restoreStatus', 'error', 'Invalid backup file — could not parse JSON.');
      document.getElementById('restoreBackupBtn').disabled = true;
    }
  };
  reader.readAsText(file);
}

function showRestorePreview(data, file) {
  const preview  = document.getElementById('restorePreview');
  const grid     = document.getElementById('restorePreviewGrid');
  const metaInfo = document.getElementById('restoreMetaInfo');

  const previewItems = BACKUP_STEPS.map(step => {
    const d     = data[step.key];
    const count = Array.isArray(d) ? d.length : (d ? Object.keys(d).length : 0);
    return `<div class="rp-item">
      <i class="fas fa-check-circle"></i>
      <span><strong>${step.label}</strong>: ${count} record${count !== 1 ? 's' : ''}</span>
    </div>`;
  }).join('');

  grid.innerHTML = previewItems;

  const meta = data._meta || {};
  const parts = [];
  if (meta.created_at) parts.push(`Created: ${new Date(meta.created_at).toLocaleString()}`);
  if (meta.created_by) parts.push(`By: ${meta.created_by}`);
  if (meta.version)    parts.push(`Version: ${meta.version}`);
  if (file)            parts.push(`File size: ${(file.size / 1024).toFixed(1)} KB`);
  metaInfo.textContent = parts.join('  ·  ');

  preview.style.display = 'block';
}

async function restoreBackup(backupData) {
  const btn = document.getElementById('restoreBackupBtn');
  btn.disabled    = true;
  btn.innerHTML   = '<i class="fas fa-spinner fa-spin"></i> Restoring…';
  document.getElementById('restoreStatus').style.display = 'none';

  try {
    // Try the server-side restore endpoint first (handles DB writes)
    const res = await fetch(`${API}/api/restore`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ backup: backupData })
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.message || 'Restore failed');

    showStatus('restoreStatus', 'success',
      result.message || 'System restored successfully from backup!');

    // Reset UI
    document.getElementById('restoreFileInput').value = '';
    document.getElementById('selectedFileName').style.display = 'none';
    document.getElementById('restorePreview').style.display   = 'none';
    btn.disabled   = true;
    btn._backupData = null;

    // Refresh the category tiles to show updated counts
    setTimeout(() => loadLiveCounts(), 1500);

  } catch (err) {
    showStatus('restoreStatus', 'error', err.message || 'Restore failed. Check server connection.');
    btn.disabled  = false;
  }

  btn.innerHTML = '<i class="fas fa-upload"></i> Restore System from Backup';
}

// ── LIVE COUNTS (load on page open) ───────────────────────────
async function loadLiveCounts() {
  // Clear the user cache so we always get fresh data
  fetchAllUsers._cache = null;
  for (const step of BACKUP_STEPS) {
    setTile(step.id, '…', 'loading');
    try {
      const data  = await step.fetch();
      const count = Array.isArray(data) ? data.length : Object.keys(data).length;
      setTile(step.id, `${count} record${count !== 1 ? 's' : ''}`, 'done');
    } catch {
      setTile(step.id, 'unavailable', 'error');
    }
  }
}

// ── SESSION HISTORY ────────────────────────────────────────────
function renderHistory() {
  const el = document.getElementById('backupHistory');
  if (!el) return;
  if (!sessionHistory.length) {
    el.innerHTML = '<div style="text-align:center;color:#9ca3af;font-size:.88rem;padding:1.25rem 0;">No backups created yet in this session.</div>';
    return;
  }
  el.innerHTML = sessionHistory.map(h => `
    <div class="hist-item">
      <div><i class="fas fa-file-archive" style="color:#065f46;margin-right:.4rem;"></i>
        <span class="hist-name">${h.filename}</span></div>
      <span class="hist-meta">${h.totalRecords} records · ${h.sizekb} KB</span>
      <span class="hist-meta">${h.time}</span>
    </div>`).join('');
}

// ── BOOT ───────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {

  // Auth
  const raw = sessionStorage.getItem('currentUser');
  if (!raw) { window.location.href = 'login.html'; return; }
  let user = {};
  try { user = JSON.parse(raw); } catch { window.location.href = 'login.html'; return; }

  document.getElementById('userNameDisplay').textContent =
    user.fullName || user.full_name || user.email || 'Admin';
  const role = (user.role || '').trim();
  document.getElementById('roleBadge').textContent =
    role.charAt(0).toUpperCase() + role.slice(1).toLowerCase() || 'Admin';

  // Load live counts on page load
  loadLiveCounts();

  // ── Create Backup button ──
  document.getElementById('createBackupBtn').addEventListener('click', createBackup);

  // ── File input ──
  const fileInput = document.getElementById('restoreFileInput');
  fileInput.addEventListener('change', () => {
    if (fileInput.files.length) handleFileSelect(fileInput.files[0]);
  });

  // ── Drag & drop on drop zone ──
  const dropZone = document.getElementById('dropZone');
  dropZone.addEventListener('dragover', e => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file && file.name.endsWith('.json')) handleFileSelect(file);
    else showStatus('restoreStatus', 'error', 'Please drop a valid <strong>.json</strong> backup file.');
  });

  // ── Restore button ──
  document.getElementById('restoreBackupBtn').addEventListener('click', () => {
    const btn        = document.getElementById('restoreBackupBtn');
    const backupData = btn._backupData;
    if (!backupData) return;

    const totalRecords = BACKUP_STEPS.reduce((sum, s) => {
      const d = backupData[s.key];
      return sum + (Array.isArray(d) ? d.length : 0);
    }, 0);

    const confirmed = confirm(
      `⚠️ RESTORE CONFIRMATION\n\n` +
      `This will OVERWRITE all current system data with:\n` +
      `• ${totalRecords} total records from the backup file\n\n` +
      `This action CANNOT be undone.\n\n` +
      `Are you absolutely sure you want to continue?`
    );
    if (confirmed) restoreBackup(backupData);
  });

});
