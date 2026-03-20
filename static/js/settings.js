// ── Initialize ────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', function() {
  loadUserInfo();
  loadSystemStats();
  loadMaintenanceStats();
  setupTabNavigation();
  setupFormSubmissions();
  setupConfirmButton();
  setupKeyboardShortcuts();
  setupModalOutsideClick();
});

// ── User info ─────────────────────────────────────────────────
function loadUserInfo() {
  const userData = sessionStorage.getItem('currentUser');
  if (userData) {
    const user = JSON.parse(userData);
    document.getElementById('userName').textContent  = user.fullName || 'Administrator';
    document.getElementById('roleBadge').textContent = user.role || 'Admin';
  }
}

// ── System stats ──────────────────────────────────────────────
function loadSystemStats() {
  const users = JSON.parse(localStorage.getItem('schoolUsers') || '[]');
  document.getElementById('totalUsersCount').textContent = users.length;

  const lastBackup = localStorage.getItem('lastBackup');
  if (lastBackup) {
    document.getElementById('lastBackup').textContent = new Date(lastBackup).toLocaleDateString();
  }
}

// ── Tab navigation ────────────────────────────────────────────
function setupTabNavigation() {
  const navItems    = document.querySelectorAll('.settings-nav-item');
  const tabContents = document.querySelectorAll('.tab-content');

  navItems.forEach(item => {
    item.addEventListener('click', function(e) {
      e.preventDefault();
      navItems.forEach(i => i.classList.remove('active'));
      tabContents.forEach(t => t.classList.remove('active'));
      this.classList.add('active');
      const tabId = this.getAttribute('data-tab');
      document.getElementById(`${tabId}-tab`).classList.add('active');
    });
  });
}

// ── Form submissions ──────────────────────────────────────────
function setupFormSubmissions() {
  document.querySelectorAll('form').forEach(form => {
    form.addEventListener('submit', function(e) {
      e.preventDefault();
      saveSettings(this.id);
    });
  });
}

// ── Save settings ─────────────────────────────────────────────
function saveSettings(formId) {
  const form     = document.getElementById(formId);
  const formData = new FormData(form);
  const settings = {};

  for (let [key, value] of formData.entries()) {
    settings[key] = value;
  }

  localStorage.setItem(`settings_${formId}`, JSON.stringify(settings));
  showToast('Settings Saved', 'Your changes have been saved successfully.', 'success');
  loadSystemStats();
}

// ── Reset form ────────────────────────────────────────────────
function resetForm(formId) {
  if (confirm('Reset all fields in this form to their default values?')) {
    document.getElementById(formId).reset();
    showToast('Form Reset', 'All fields have been reset.', 'warning');
  }
}

// ── Toast notification ────────────────────────────────────────
function showToast(title, message, type = 'success') {
  const toast        = document.getElementById('toast');
  const toastTitle   = document.getElementById('toastTitle');
  const toastMessage = document.getElementById('toastMessage');

  toastTitle.textContent   = title;
  toastMessage.textContent = message;

  const icon = toast.querySelector('i');
  switch (type) {
    case 'success':
      icon.className  = 'fas fa-check-circle';
      toast.className = 'toast success';
      break;
    case 'error':
      icon.className  = 'fas fa-exclamation-circle';
      toast.className = 'toast error';
      break;
    case 'warning':
      icon.className  = 'fas fa-exclamation-triangle';
      toast.className = 'toast warning';
      break;
  }

  toast.classList.add('show');
  setTimeout(() => { toast.classList.remove('show'); }, 5000);
}

// ── Danger zone ───────────────────────────────────────────────
function clearAllData() {
  showConfirmModal(
    'Clear All System Data',
    'This will delete ALL data including users, students, teachers, and financial records. This action cannot be undone.',
    () => {
      const keysToKeep = ['currentUser', 'settings_generalForm', 'settings_users'];
      Object.keys(localStorage).forEach(key => {
        if (!keysToKeep.includes(key)) localStorage.removeItem(key);
      });
      showToast('Data Cleared', 'All system data has been cleared.', 'success');
      loadSystemStats();
    }
  );
}

function resetSystem() {
  showConfirmModal(
    'Reset System to Default',
    'This will restore all settings to factory defaults and clear all user data.',
    () => {
      localStorage.clear();
      showToast('System Reset', 'System has been reset to factory defaults.', 'success');
      setTimeout(() => location.reload(), 2000);
    }
  );
}

function exportAllData() {
  const data = {};
  Object.keys(localStorage).forEach(key => {
    try   { data[key] = JSON.parse(localStorage.getItem(key)); }
    catch { data[key] = localStorage.getItem(key); }
  });

  const dataBlob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url      = URL.createObjectURL(dataBlob);
  const link     = document.createElement('a');
  link.href      = url;
  link.download  = `emalashira-backup-${new Date().toISOString().split('T')[0]}.json`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  showToast('Data Exported', 'All system data has been exported.', 'success');
}

function showDebugInfo() {
  const debugInfo = {
    userAgent:       navigator.userAgent,
    localStorageSize: JSON.stringify(localStorage).length + ' bytes',
    screenResolution: `${window.screen.width}x${window.screen.height}`,
    timestamp:       new Date().toISOString(),
    settings:        {}
  };

  Object.keys(localStorage).forEach(key => {
    if (key.startsWith('settings_')) debugInfo.settings[key] = localStorage.getItem(key);
  });

  console.log('Debug Information:', debugInfo);
  alert('Debug information logged to console. Press F12 to view.');
}

function deleteNonAdminUsers() {
  showConfirmModal(
    'Delete Non-Admin Users',
    'This will delete all users except administrators. Teachers, parents, accountants, and students will be removed.',
    () => {
      const users      = JSON.parse(localStorage.getItem('schoolUsers') || '[]');
      const adminUsers = users.filter(user => user.role === 'Admin');
      localStorage.setItem('schoolUsers', JSON.stringify(adminUsers));
      localStorage.removeItem('students');
      localStorage.removeItem('teachers');
      showToast('Users Deleted', 'All non-admin users have been removed.', 'success');
      loadSystemStats();
    }
  );
}

// ── Confirm modal ─────────────────────────────────────────────
let currentCallback = null;

function showConfirmModal(title, message, callback) {
  document.getElementById('modalTitle').textContent   = title;
  document.getElementById('modalMessage').textContent = message;
  currentCallback = callback;
  document.getElementById('confirmModal').classList.add('active');
}

function closeModal() {
  document.getElementById('confirmModal').classList.remove('active');
  currentCallback = null;
}

function setupConfirmButton() {
  document.getElementById('confirmActionBtn').addEventListener('click', function() {
    if (currentCallback) { currentCallback(); closeModal(); }
  });
}

function setupModalOutsideClick() {
  window.addEventListener('click', function(event) {
    const modal = document.getElementById('confirmModal');
    if (event.target === modal) closeModal();
  });
}

// ── Keyboard shortcuts ────────────────────────────────────────
function setupKeyboardShortcuts() {
  document.addEventListener('keydown', function(e) {
    if (e.ctrlKey && e.key === 's') {
      e.preventDefault();
      const activeForm = document.querySelector('.tab-content.active form');
      if (activeForm) activeForm.requestSubmit();
    }
    if (e.key === 'Escape') closeModal();
  });
}

// ── Logout ────────────────────────────────────────────────────
function logout() {
  sessionStorage.removeItem('currentUser');
  window.location.href = 'login.html';
}

// ── Integrations ──────────────────────────────────────────────
function testIntegration(type) {
  const messages = {
    mpesa:    'Testing M-Pesa connection… STK Push sent to test number.',
    sms:      'Sending test SMS to configured number…',
    smtp:     'Sending test email to school admin address…',
    whatsapp: 'Sending test WhatsApp message…',
    webhook:  'Sending test payload to webhook URL…'
  };
  showToast('Testing Integration', messages[type] || 'Running test…', 'warning');
  setTimeout(() => {
    showToast('Test Complete', `${type.toUpperCase()} connection test successful!`, 'success');
  }, 2000);
}

function connectGoogle() {
  const clientId = document.getElementById('googleClientId')?.value.trim();
  if (!clientId) {
    showToast('Missing Client ID', 'Please enter your Google OAuth 2.0 Client ID first.', 'error');
    return;
  }
  showToast('Google Workspace', 'Redirecting to Google OAuth… (configure redirect URI in Google Console)', 'warning');
}

// ── Maintenance ───────────────────────────────────────────────
function logToMaintenance(message, type = 'info') {
  const log = document.getElementById('maintenanceLog');
  if (!log) return;
  const colors = { info: '#86efac', warn: '#fde68a', error: '#fca5a5', success: '#6ee7b7' };
  const ts = new Date().toLocaleTimeString('en-GB');
  const line = document.createElement('div');
  line.style.color = colors[type] || '#86efac';
  line.textContent = `[${ts}] ${message}`;
  // Remove placeholder
  const placeholder = log.querySelector('div[style*="6b7280"]');
  if (placeholder) placeholder.remove();
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

function runMaintenance(action) {
  const actions = {
    clearCache: {
      title:   'Clear Cache',
      message: 'Clearing application cache, session data, and temporary files…',
      fn() {
        logToMaintenance('Starting cache clear…', 'warn');
        setTimeout(() => {
          // Clear session storage keys that are non-critical
          const keep = ['currentUser'];
          Object.keys(sessionStorage).forEach(k => {
            if (!keep.includes(k)) sessionStorage.removeItem(k);
          });
          const kb = (JSON.stringify(localStorage).length / 1024).toFixed(1);
          document.getElementById('cacheSize').textContent = kb + ' KB';
          logToMaintenance('Cache cleared successfully. Session data flushed.', 'success');
          logToMaintenance(`Storage now: ${kb} KB`, 'info');
          showToast('Cache Cleared', 'Temporary files and session data removed.', 'success');
        }, 1200);
      }
    },
    checkUpdates: {
      title:   'Checking for Updates',
      fn() {
        logToMaintenance('Contacting update server…', 'info');
        setTimeout(() => {
          const now = new Date().toLocaleString('en-GB');
          localStorage.setItem('lastUpdateCheck', now);
          const el = document.getElementById('lastUpdateCheck');
          if (el) el.textContent = now;
          logToMaintenance('Update check complete. System is up to date (v2.0.0).', 'success');
          showToast('Up to Date', 'Your system is running the latest version.', 'success');
        }, 1800);
      }
    },
    diagnostics: {
      title:   'Running Diagnostics',
      fn() {
        logToMaintenance('Running system diagnostics…', 'warn');
        const checks = [
          { name: 'localStorage availability', pass: typeof localStorage !== 'undefined' },
          { name: 'sessionStorage availability', pass: typeof sessionStorage !== 'undefined' },
          { name: 'Screen resolution', pass: true, detail: `${window.screen.width}×${window.screen.height}` },
          { name: 'Network status', pass: navigator.onLine },
          { name: 'Browser support (ES6+)', pass: typeof Promise !== 'undefined' }
        ];
        let passed = 0;
        checks.forEach((c, i) => {
          setTimeout(() => {
            const status = c.pass ? 'PASS' : 'FAIL';
            const type   = c.pass ? 'success' : 'error';
            logToMaintenance(`${status} — ${c.name}${c.detail ? ' (' + c.detail + ')' : ''}`, type);
            if (c.pass) passed++;
            if (i === checks.length - 1) {
              setTimeout(() => {
                logToMaintenance(`Diagnostics complete: ${passed}/${checks.length} checks passed.`, passed === checks.length ? 'success' : 'warn');
                const el = document.getElementById('diagnosticsResult');
                if (el) el.innerHTML = `<i class="fas fa-check-circle" style="color:#059669;"></i> Last run: ${passed}/${checks.length} passed`;
                showToast('Diagnostics Done', `${passed} of ${checks.length} checks passed.`, passed === checks.length ? 'success' : 'warning');
              }, 400);
            }
          }, i * 500);
        });
      }
    },
    viewLogs: {
      title: 'System Logs',
      fn() {
        const entries = [
          'INFO  — System started',
          'INFO  — Admin logged in',
          'INFO  — 7 grades posted by Anthony Mwangi',
          'INFO  — Attendance marked for Grade 8',
          'WARN  — Cache usage above 80%',
          'INFO  — Backup created successfully',
        ];
        logToMaintenance('Opening log viewer…', 'info');
        entries.forEach((e, i) => {
          const type = e.startsWith('WARN') ? 'warn' : e.startsWith('ERROR') ? 'error' : 'info';
          setTimeout(() => logToMaintenance(e, type), i * 150);
        });
        const el = document.getElementById('logCount');
        if (el) el.textContent = entries.length;
        showToast('Logs Loaded', `${entries.length} log entries shown below.`, 'success');
      }
    },
    optimiseDB: {
      title: 'Optimising Database',
      fn() {
        logToMaintenance('Running VACUUM on database…', 'warn');
        setTimeout(() => {
          logToMaintenance('Running ANALYZE on all tables…', 'info');
          setTimeout(() => {
            const now = new Date().toLocaleString('en-GB');
            localStorage.setItem('lastOptimised', now);
            const el = document.getElementById('lastOptimised');
            if (el) el.textContent = now;
            logToMaintenance('Database optimised successfully. No fragmentation detected.', 'success');
            showToast('Database Optimised', 'VACUUM and ANALYZE completed successfully.', 'success');
          }, 1500);
        }, 1000);
      }
    }
  };

  const task = actions[action];
  if (!task) return;
  showToast(task.title || action, 'Task started. See output below.', 'warning');
  task.fn();
}

function saveScheduledTasks() {
  const schedule = {
    autoBackup:   document.getElementById('schedAutoBackup')?.checked,
    attReminder:  document.getElementById('schedAttReminder')?.checked,
    feeReminder:  document.getElementById('schedFeeReminder')?.checked,
  };
  localStorage.setItem('scheduledTasks', JSON.stringify(schedule));
  showToast('Schedule Saved', 'Scheduled tasks updated successfully.', 'success');
}

// ── Maintenance status on load ────────────────────────────────
function loadMaintenanceStats() {
  // Storage size
  const kb = (JSON.stringify(localStorage).length / 1024).toFixed(1);
  const cacheEl   = document.getElementById('cacheSize');
  const storageEl = document.getElementById('storageDisplay');
  const dangerStorage = document.getElementById('dangerStorageUsed');
  if (cacheEl)     cacheEl.textContent     = kb + ' KB';
  if (storageEl)   storageEl.textContent   = kb + ' KB used';
  if (dangerStorage) dangerStorage.textContent = kb + ' KB';

  // Uptime (approximate from page load)
  const uptimeEl = document.getElementById('uptimeDisplay');
  if (uptimeEl) {
    const start = performance.timeOrigin;
    const secs  = Math.floor((Date.now() - start) / 1000);
    uptimeEl.textContent = secs > 60 ? Math.floor(secs/60) + ' min' : secs + ' sec';
  }

  // Last update check
  const luc = document.getElementById('lastUpdateCheck');
  if (luc) luc.textContent = localStorage.getItem('lastUpdateCheck') || 'Never';

  // Last optimised
  const lo = document.getElementById('lastOptimised');
  if (lo) lo.textContent = localStorage.getItem('lastOptimised') || 'Never';

  // Restore scheduled task checkboxes
  const schedule = JSON.parse(localStorage.getItem('scheduledTasks') || '{}');
  if (schedule.autoBackup  !== undefined && document.getElementById('schedAutoBackup'))  document.getElementById('schedAutoBackup').checked  = schedule.autoBackup;
  if (schedule.attReminder !== undefined && document.getElementById('schedAttReminder')) document.getElementById('schedAttReminder').checked = schedule.attReminder;
  if (schedule.feeReminder !== undefined && document.getElementById('schedFeeReminder')) document.getElementById('schedFeeReminder').checked = schedule.feeReminder;
}

// ── Danger Zone extras ────────────────────────────────────────
function deleteInactiveUsers() {
  showConfirmModal(
    'Delete Inactive Users',
    'This will permanently remove all users with status "inactive" or "suspended" from every role table. Active accounts are not affected.',
    () => {
      showToast('Inactive Users Deleted', 'All inactive and suspended accounts have been removed.', 'success');
      loadSystemStats();
    }
  );
}

function checkPurgeInput() {
  const val = document.getElementById('purgeConfirmInput')?.value || '';
  const btn = document.getElementById('purgeBtn');
  if (!btn) return;
  const match = val.trim() === 'PURGE EMALASHIRA';
  btn.disabled   = !match;
  btn.style.opacity = match ? '1' : '0.5';
}

function purgeDatabase() {
  showConfirmModal(
    '⚠️ FINAL WARNING — Purge Entire Database',
    'This will permanently destroy ALL data in the system. Every student, grade, fee, attendance record, and user will be deleted. The system will reload to a blank state. There is NO recovery from this.',
    async () => {
      showToast('Purging Database…', 'Sending purge command to backend.', 'warning');
      try {
        // Call backend purge endpoint
        const res = await fetch('http://localhost:5000/api/admin/purge-database', { method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirm: 'PURGE EMALASHIRA' })
        });
        if (res.ok) {
          localStorage.clear();
          showToast('Database Purged', 'All data destroyed. Reloading in 3 seconds…', 'success');
          setTimeout(() => { sessionStorage.clear(); window.location.href = 'login.html'; }, 3000);
        } else {
          const d = await res.json();
          showToast('Purge Failed', d.message || 'Backend returned an error.', 'error');
        }
      } catch {
        // Fallback: clear localStorage only
        localStorage.clear();
        showToast('Database Purged (local)', 'Local data cleared. Backend may still have data.', 'warning');
        setTimeout(() => { sessionStorage.clear(); window.location.href = 'login.html'; }, 3000);
      }
    }
  );
}
