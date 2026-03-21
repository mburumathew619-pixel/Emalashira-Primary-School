const API_BASE_URL = "https://emalashira-primary-school.onrender.com";

function redirectByRole(role) {
  const r = (role || '').toLowerCase().trim();
  if      (r === 'admin')      window.location.replace('dashboard.html');
  else if (r === 'teacher')    window.location.replace('teacher-dashboard.html');
  else if (r === 'parent')     window.location.replace('parent-dashboard.html');
  else if (r === 'accountant') window.location.replace('finance-dashboard.html');
  else {
    showStatus('Your account is still pending approval. Please check back later.');
  }
}

function showStatus(message, isError = false) {
  const statusEl = document.getElementById('statusMsg');
  if (statusEl) {
    statusEl.textContent = message;
    statusEl.style.color = isError ? '#dc2626' : '#065f46';
    statusEl.style.fontWeight = '500';
  }
}

function goToLogin() {
  sessionStorage.removeItem('currentUser');
  window.location.replace('login.html');
}

async function checkAndRedirect() {
  const stored = sessionStorage.getItem('currentUser');

  // No session at all → show login prompt
  if (!stored) {
    showStatus('Please log in to continue.');
    return;
  }

  let user;
  try { user = JSON.parse(stored); } catch(e) {
    showStatus('Session error. Please log in again.', true);
    return;
  }

  const email = user.email;
  if (!email) {
    showStatus('Session error. Please log in again.', true);
    return;
  }

  // ── Step 1: Check sessionStorage first (instant) ──────────────
  const storedRole   = (user.role   || '').toLowerCase().trim();
  const storedStatus = (user.status || '').toLowerCase().trim();
  const validRoles   = ['admin', 'teacher', 'parent', 'accountant'];

  if (storedStatus === 'active' && validRoles.includes(storedRole)) {
    showStatus(`Access approved! Redirecting as ${storedRole}...`);
    setTimeout(() => redirectByRole(storedRole), 800);
    return;
  }

  // ── Step 2: Fetch fresh data from backend to double-check ──────
  showStatus('Checking your account status...');
  try {
    // Use /api/profile which actually exists in your backend
    const res = await fetch(`${API_BASE_URL}/api/profile?email=${encodeURIComponent(email)}`);

    if (!res.ok) throw new Error('Could not reach server');

    const freshUser = await res.json();
    const role      = (freshUser.role   || '').toLowerCase().trim();
    const status    = (freshUser.status || '').toLowerCase().trim();

    console.log('Fresh role:', role, 'status:', status);

    if (status === 'active' && validRoles.includes(role)) {
      // Update sessionStorage with fresh data
      sessionStorage.setItem('currentUser', JSON.stringify({
        ...user, role, status
      }));
      showStatus(`Access approved! Redirecting as ${role}...`);
      setTimeout(() => redirectByRole(role), 800);
    } else {
      showStatus('Your account is still pending approval. Please check back later.');
    }

  } catch (e) {
    console.error('Status check error:', e);
    // Fallback: trust what sessionStorage says
    if (storedStatus === 'active' && validRoles.includes(storedRole)) {
      showStatus(`Redirecting as ${storedRole}...`);
      setTimeout(() => redirectByRole(storedRole), 800);
    } else {
      showStatus('Unable to verify status. Please try again or contact admin.', true);
    }
  }
}

// Auto-check on page load
(async function autoCheck() {
  await checkAndRedirect();
})();
