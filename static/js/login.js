const USE_BACKEND  = true;
const API_BASE_URL = "https://emalashira-primary-school.onrender.com"

// School email domain configuration
const SCHOOL_EMAIL_DOMAINS = ['emalashira.sc.ke', 'emalashira.ac.ke', 'emalashira.school.ke'];

// For strict mode - only allow school domain emails
const STRICT_EMAIL_DOMAIN = true;

// For allowed public domains during testing/development (leave empty for strict mode)
const ALLOWED_PUBLIC_DOMAINS = []; // Empty for production

function validateSchoolEmail(email) {
  if (!email || !email.includes('@')) return false;
  
  const domain = email.split('@')[1].toLowerCase();
  
  // Check if domain is a school domain
  const isSchoolDomain = SCHOOL_EMAIL_DOMAINS.some(schoolDomain => 
    domain === schoolDomain.toLowerCase() || domain.endsWith('.' + schoolDomain.toLowerCase())
  );
  
  if (STRICT_EMAIL_DOMAIN) {
    return isSchoolDomain;
  } else {
    // In development mode, allow both school domains and specified public domains
    const isAllowedPublic = ALLOWED_PUBLIC_DOMAINS.includes(domain);
    return isSchoolDomain || isAllowedPublic;
  }
}

function getEmailDomainHelp() {
  return `Please use your school email address (@${SCHOOL_EMAIL_DOMAINS[0]})`;
}

function normalizeRole(role) {
  if (!role) return 'user';
  return role.trim().toLowerCase();
}

const VALID_ROLES = ['admin', 'teacher', 'parent', 'accountant'];

function redirectByRole(role, status) {
  const r = (role   || '').toLowerCase().trim();
  const s = (status || 'pending').toLowerCase().trim();

  if (s !== 'active') {
    window.location.replace('pending-approval.html');
    return;
  }

  if      (r === 'admin')      window.location.replace('dashboard.html');
  else if (r === 'teacher')    window.location.replace('teacher-dashboard.html');
  else if (r === 'parent')     window.location.replace('parent-dashboard.html');
  else if (r === 'accountant') window.location.replace('finance-dashboard.html');
  else {
    window.location.replace('pending-approval.html');
  }
}

const Users = {
  _key: 'eps_users',
  all()         { return JSON.parse(localStorage.getItem(this._key) || '[]'); },
  save(list)    { localStorage.setItem(this._key, JSON.stringify(list)); },
  find(email)   { return this.all().find(u => u.email === email.toLowerCase().trim()); },
  add(user)     { const list = this.all(); list.push(user); this.save(list); },
  exists(email) { return !!this.find(email); }
};

let currentSlide = 0;
const dots = document.querySelectorAll('.dot');
function updateDots(i) { 
  dots.forEach(d => d.classList.remove('active')); 
  if (dots[i]) dots[i].classList.add('active'); 
}
setInterval(() => { 
  currentSlide = (currentSlide + 1) % 6; 
  updateDots(currentSlide); 
}, 5000);
dots.forEach(dot => dot.addEventListener('click', () => { 
  currentSlide = +dot.dataset.index; 
  updateDots(currentSlide); 
}));

function togglePasswordVisibility(input, iconEl) {
  const vis = input.type === 'text';
  input.type = vis ? 'password' : 'text';
  iconEl.innerHTML = vis
    ? `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/>`
    : `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.542-7a9.956 9.956 0 012.293-3.95m3.249-2.568A9.956 9.956 0 0112 5c4.478 0 8.268 2.943 9.542 7a9.965 9.965 0 01-4.293 5.03M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 3l18 18"/>`;
}

document.getElementById('togglePassword')?.addEventListener('click', () =>
  togglePasswordVisibility(document.getElementById('password'), document.getElementById('eyeIcon')));

document.getElementById('toggleSignupPassword')?.addEventListener('click', () =>
  togglePasswordVisibility(document.getElementById('signupPassword'), document.getElementById('signupEyeIcon')));

document.getElementById('toggleSignupConfirmPassword')?.addEventListener('click', () =>
  togglePasswordVisibility(document.getElementById('signupConfirmPassword'), document.getElementById('signupConfirmEyeIcon')));

document.getElementById('showSignup')?.addEventListener('click', e => {
  e.preventDefault();
  document.getElementById('loginForm').style.display = 'none';
  document.getElementById('signupForm').style.display = 'block';
  document.getElementById('formTitle').textContent = 'Create Account';
  document.getElementById('signupMessage').textContent = '';
  
  // Add email placeholder with school domain hint
  const emailInput = document.getElementById('signupEmail');
  if (emailInput) {
    emailInput.placeholder = `your.name@${SCHOOL_EMAIL_DOMAINS[0]}`;
  }
});

document.getElementById('showLogin')?.addEventListener('click', e => {
  e.preventDefault();
  document.getElementById('signupForm').style.display = 'none';
  document.getElementById('loginForm').style.display = 'block';
  document.getElementById('formTitle').textContent = 'Welcome Back';
  document.getElementById('loginMessage').textContent = '';
});

function showMsg(id, text, type) {
  const el = document.getElementById(id);
  if (el) {
    el.textContent = text;
    el.className = 'message ' + type;
  }
}

// Update email input placeholders on page load
document.addEventListener('DOMContentLoaded', () => {
  const loginEmail = document.getElementById('email');
  const signupEmail = document.getElementById('signupEmail');
  
  if (loginEmail) {
    loginEmail.placeholder = `your.name@${SCHOOL_EMAIL_DOMAINS[0]}`;
  }
  if (signupEmail) {
    signupEmail.placeholder = `your.name@${SCHOOL_EMAIL_DOMAINS[0]}`;
  }
});

document.getElementById('signupForm')?.addEventListener('submit', async e => {
  e.preventDefault();

  const fullName = document.getElementById('signupFullName')?.value.trim() || '';
  const email    = document.getElementById('signupEmail')?.value.trim() || '';
  const password = document.getElementById('signupPassword')?.value || '';
  const confirm  = document.getElementById('signupConfirmPassword')?.value || '';

  if (!fullName) return showMsg('signupMessage', 'Please enter your full name.', 'error');
  if (!email)    return showMsg('signupMessage', 'Please enter your email.', 'error');
  
  // Validate school email domain
  if (!validateSchoolEmail(email)) {
    return showMsg('signupMessage', `Invalid email domain. ${getEmailDomainHelp()}`, 'error');
  }
  
  if (password.length < 6) {
    return showMsg('signupMessage', 'Password must be at least 6 characters.', 'error');
  }
  if (password !== confirm) {
    return showMsg('signupMessage', 'Passwords do not match.', 'error');
  }

  if (USE_BACKEND) {
    try {
      const res = await fetch(`${API_BASE_URL}/api/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fullName, email, password })
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.message || 'Signup failed');
      }

      showMsg('signupMessage', 'Account created! Your account is pending admin approval before you can log in.', 'success');
      setTimeout(() => {
        document.getElementById('showLogin')?.click();
      }, 2500);
    } catch (err) {
      showMsg('signupMessage', err.message || 'Signup failed. Try again later.', 'error');
      console.error(err);
    }
  } else {
    if (Users.exists(email)) {
      return showMsg('signupMessage', 'Email already registered.', 'error');
    }
    Users.add({ fullName, email, password, role: 'pending' });
    showMsg('signupMessage', 'Account created! You can now log in.', 'success');
    setTimeout(() => {
      document.getElementById('showLogin')?.click();
    }, 1500);
  }
});

document.getElementById('loginForm')?.addEventListener('submit', async e => {
  e.preventDefault();

  const email    = document.getElementById('email')?.value.trim();
  const password = document.getElementById('password')?.value;

  if (USE_BACKEND) {
    try {
      const res = await fetch(`${API_BASE_URL}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Login failed');

      sessionStorage.removeItem('currentUser');

      let permissions = {};
      try {
        const roleRes = await fetch(`${API_BASE_URL}/api/roles`);
        if (roleRes.ok) {
          const roles = await roleRes.json();
          const matched = roles.find(r => r.name.toLowerCase() === (data.user.role || '').toLowerCase());
          if (matched && matched.permissions) {
            permissions = typeof matched.permissions === 'string' ? JSON.parse(matched.permissions) : matched.permissions;
          }
        }
      } catch (err) {
        console.warn('Could not load permissions:', err);
      }

      let freshRole   = normalizeRole(data.user.role);
      let freshStatus = (data.user.status || 'pending').toLowerCase().trim();

      try {
        const profileRes = await fetch(`${API_BASE_URL}/api/profile?email=${encodeURIComponent(data.user.email)}`);
        if (profileRes.ok) {
          const profileData = await profileRes.json();
          const serverRole   = (profileData.role   || '').toLowerCase().trim();
          const serverStatus = (profileData.status || '').toLowerCase().trim();
          if (serverRole)   freshRole   = serverRole;
          if (serverStatus) freshStatus = serverStatus;
        }
      } catch (err) {
        console.warn('Could not fetch fresh profile:', err);
      }

      // Always force lowercase — backend may return 'Admin'/'Active' etc.
      freshRole   = (freshRole   || '').toLowerCase().trim();
      freshStatus = (freshStatus || '').toLowerCase().trim();

      sessionStorage.setItem('currentUser', JSON.stringify({
        ...data.user,
        role: freshRole,
        status: freshStatus,
        permissions
      }));

      const welcomeMsg = freshStatus !== 'active'
        ? 'Account pending approval. You will be redirected...'
        : `Welcome, ${data.user.fullName || 'User'}! Redirecting...`;

      showMsg('loginMessage', welcomeMsg, freshStatus !== 'active' ? 'error' : 'success');
      setTimeout(() => redirectByRole(freshRole, freshStatus), 1200);
    } catch (err) {
      showMsg('loginMessage', err.message || 'Invalid email or password', 'error');
    }
  } else {
    const user = Users.find(email);
    if (!user || user.password !== password) {
      return showMsg('loginMessage', 'Invalid email or password.', 'error');
    }
    sessionStorage.removeItem('currentUser');
    const { password: _, ...safeUser } = user;
    sessionStorage.setItem('currentUser', JSON.stringify(safeUser));

    const normalizedRole   = normalizeRole(safeUser.role);
    const normalizedStatus = (safeUser.status || 'pending').toLowerCase().trim();
    showMsg('loginMessage', `Welcome, ${safeUser.fullName || 'User'}! Redirecting...`, 'success');
    setTimeout(() => redirectByRole(normalizedRole, normalizedStatus), 1200);
  }
});

document.querySelector('.forgot-password')?.addEventListener('click', async e => {
  e.preventDefault();
  const email = document.getElementById('email')?.value.trim();
  if (!email) return showMsg('loginMessage', 'Enter your email address first.', 'error');

  if (USE_BACKEND) {
    try {
      const res = await fetch(`${API_BASE_URL}/api/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      });
      const data = await res.json();
      showMsg('loginMessage', data.message || 'Reset instructions sent.', res.ok ? 'success' : 'error');
    } catch {
      showMsg('loginMessage', 'Could not reach server.', 'error');
    }
  } else {
    const user = Users.find(email);
    if (!user) return showMsg('loginMessage', 'No account found with that email.', 'error');
    const newPass = prompt('Enter your new password (min 6 chars):');
    if (!newPass || newPass.length < 6) return showMsg('loginMessage', 'Password too short.', 'error');
    const list = Users.all();
    const idx = list.findIndex(u => u.email === email.toLowerCase().trim());
    list[idx].password = newPass;
    Users.save(list);
    showMsg('loginMessage', 'Password reset successfully. You can now log in.', 'success');
  }
});

// ── PASSWORD STRENGTH CHECKER ─────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const passwordInput = document.getElementById('signupPassword');
  if (!passwordInput) return;

  const strengthDisplay   = document.getElementById('password-strength');
  const suggestionDisplay = document.getElementById('password-suggestion');

  const reqLength  = document.getElementById('req-length');
  const reqUpper   = document.getElementById('req-upper');
  const reqLower   = document.getElementById('req-lower');
  const reqNumber  = document.getElementById('req-number');
  const reqSpecial = document.getElementById('req-special');

  passwordInput.addEventListener('input', () => {
    const pwd = passwordInput.value;

    if (suggestionDisplay) suggestionDisplay.textContent = '';

    const checks = {
      length:  pwd.length >= 10,
      upper:   /[A-Z]/.test(pwd),
      lower:   /[a-z]/.test(pwd),
      number:  /[0-9]/.test(pwd),
      special: /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?~`]/.test(pwd)
    };

    if (reqLength)  reqLength.className  = checks.length  ? 'good' : '';
    if (reqUpper)   reqUpper.className   = checks.upper   ? 'good' : '';
    if (reqLower)   reqLower.className   = checks.lower   ? 'good' : '';
    if (reqNumber)  reqNumber.className  = checks.number  ? 'good' : '';
    if (reqSpecial) reqSpecial.className = checks.special ? 'good' : '';

    const score = Object.values(checks).filter(v => v).length;

    let strengthText = '';
    let strengthClass = '';

    if (pwd.length === 0) {
      if (strengthDisplay) strengthDisplay.textContent = '';
      return;
    }

    if (score <= 2) {
      strengthText = 'Weak';
      strengthClass = 'strength-weak';
      if (suggestionDisplay) suggestionDisplay.textContent = 'Try a longer password with uppercase letters, numbers, and symbols.';
    } else if (score === 3) {
      strengthText = 'Medium';
      strengthClass = 'strength-medium';
      if (suggestionDisplay) suggestionDisplay.textContent = 'Better! Add at least one uppercase letter or special character.';
    } else if (score === 4) {
      strengthText = 'Strong';
      strengthClass = 'strength-strong';
      if (suggestionDisplay) suggestionDisplay.textContent = 'Good password — quite secure already.';
    } else {
      strengthText = 'Very Strong';
      strengthClass = 'strength-verystrong';
      if (suggestionDisplay) suggestionDisplay.textContent = 'Excellent! Very hard to guess or crack.';
    }

    if (strengthDisplay) {
      strengthDisplay.textContent = `Password strength: ${strengthText}`;
      strengthDisplay.className = `password-strength ${strengthClass}`;
    }
  });

  document.getElementById('signupForm')?.addEventListener('submit', function(e) {
    const pwd = document.getElementById('signupPassword')?.value || '';

    const isStrongEnough =
      pwd.length >= 10 &&
      /[A-Z]/.test(pwd) &&
      /[a-z]/.test(pwd) &&
      /[0-9]/.test(pwd) &&
      /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?~`]/.test(pwd);

    if (!isStrongEnough) {
      e.preventDefault();
      showMsg('signupMessage', 'Please choose a stronger password that meets all requirements.', 'error');
      document.getElementById('signupPassword')?.focus();
    }
  });

  // ── PASSWORD GENERATOR ──────────────────────────────────────
  function generateStrongPassword() {
    const upper   = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    const lower   = 'abcdefghjkmnpqrstuvwxyz';
    const numbers = '123456789';
    const special = '!@#$%^&*+-=?';

    // Pick random words from a friendly pool for readability
    const words = [
      'Tiger','Cloud','River','Stone','Flame','Eagle','Storm','Bloom',
      'Swift','Frost','Grove','Spark','Brave','Prime','Light','Forge'
    ];

    // Pattern: Word + 2 numbers + special + 3 random chars = guaranteed 12-16 chars
    const word    = words[Math.floor(Math.random() * words.length)];
    const num1    = numbers[Math.floor(Math.random() * numbers.length)];
    const num2    = numbers[Math.floor(Math.random() * numbers.length)];
    const spec    = special[Math.floor(Math.random() * special.length)];
    const extra1  = upper[Math.floor(Math.random() * upper.length)];
    const extra2  = lower[Math.floor(Math.random() * lower.length)];
    const extra3  = numbers[Math.floor(Math.random() * numbers.length)];

    // Shuffle the assembled password
    const raw = word + num1 + num2 + spec + extra1 + extra2 + extra3;
    return raw.split('').sort(() => Math.random() - 0.5).join('');
  }

  function validateGenerated(pwd) {
    return (
      pwd.length >= 10 &&
      /[A-Z]/.test(pwd) &&
      /[a-z]/.test(pwd) &&
      /[0-9]/.test(pwd) &&
      /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?~`]/.test(pwd)
    );
  }

  function getValidPassword() {
    let pwd;
    // Keep generating until it passes all criteria (usually first try)
    do { pwd = generateStrongPassword(); } while (!validateGenerated(pwd));
    return pwd;
  }

  function showGeneratedPassword(pwd) {
    const box       = document.getElementById('pw-generated-box');
    const valueEl   = document.getElementById('pw-generated-value');
    const copiedMsg = document.getElementById('pw-copied-msg');
    if (!box || !valueEl) return;
    valueEl.textContent = pwd;
    box.style.display   = 'block';
    if (copiedMsg) copiedMsg.style.display = 'none';
  }

  function applyPassword(pwd) {
    const pwInput  = document.getElementById('signupPassword');
    const cfInput  = document.getElementById('signupConfirmPassword');
    if (pwInput)  { pwInput.value  = pwd; pwInput.dispatchEvent(new Event('input')); }
    if (cfInput)  { cfInput.value  = pwd; }
  }

  // Generate button click
  document.getElementById('generatePasswordBtn')?.addEventListener('click', () => {
    const pwd = getValidPassword();
    showGeneratedPassword(pwd);
  });

  // Refresh button
  document.getElementById('pw-refresh-btn')?.addEventListener('click', () => {
    const pwd = getValidPassword();
    showGeneratedPassword(pwd);
  });

  // "Use this" button — fills both password fields and triggers strength checker
  document.getElementById('pw-use-btn')?.addEventListener('click', () => {
    const valueEl   = document.getElementById('pw-generated-value');
    const copiedMsg = document.getElementById('pw-copied-msg');
    if (!valueEl) return;
    const pwd = valueEl.textContent;
    applyPassword(pwd);

    // Copy to clipboard
    navigator.clipboard?.writeText(pwd).then(() => {
      if (copiedMsg) {
        copiedMsg.textContent = '✓ Applied & copied to clipboard!';
        copiedMsg.style.display = 'block';
        setTimeout(() => { copiedMsg.style.display = 'none'; }, 3000);
      }
    }).catch(() => {
      if (copiedMsg) {
        copiedMsg.textContent = '✓ Password applied to the fields below.';
        copiedMsg.style.display = 'block';
        setTimeout(() => { copiedMsg.style.display = 'none'; }, 3000);
      }
    });
  });

  // Clicking the code value itself also copies
  document.getElementById('pw-generated-value')?.addEventListener('click', function() {
    const copiedMsg = document.getElementById('pw-copied-msg');
    navigator.clipboard?.writeText(this.textContent).then(() => {
      if (copiedMsg) {
        copiedMsg.textContent = '✓ Copied to clipboard!';
        copiedMsg.style.display = 'block';
        setTimeout(() => { copiedMsg.style.display = 'none'; }, 2000);
      }
    });
  });
});
