const API_BASE_URL = "http://localhost:5000";
const SCHOOL_DOMAIN = 'emalashira.sc.ke';

// ── Helpers ───────────────────────────────────────────────────
function isSchoolEmail(email) {
  if (!email || !email.includes('@')) return false;
  const domain = email.split('@')[1].toLowerCase().trim();
  return domain === SCHOOL_DOMAIN;
}

function getPasswordChecks(pwd) {
  return {
    length:  pwd.length >= 10,
    upper:   /[A-Z]/.test(pwd),
    lower:   /[a-z]/.test(pwd),
    number:  /[0-9]/.test(pwd),
    special: /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?~`]/.test(pwd)
  };
}

function isStrongPassword(pwd) {
  const c = getPasswordChecks(pwd);
  return c.length && c.upper && c.lower && c.number && c.special;
}

// ── Eye toggles ───────────────────────────────────────────────
document.getElementById('togglePassword').addEventListener('click', function() {
  const inp = document.getElementById('password');
  const icon = document.getElementById('eyeIcon');
  const show = inp.type === 'password';
  inp.type = show ? 'text' : 'password';
  icon.className = show ? 'fas fa-eye-slash' : 'fas fa-eye';
});

document.getElementById('toggleConfirm').addEventListener('click', function() {
  const inp = document.getElementById('confirmPassword');
  const icon = document.getElementById('eyeIconConfirm');
  const show = inp.type === 'password';
  inp.type = show ? 'text' : 'password';
  icon.className = show ? 'fas fa-eye-slash' : 'fas fa-eye';
});

// ── Email validation on blur ──────────────────────────────────
document.getElementById('email').addEventListener('blur', function() {
  const err = document.getElementById('emailError');
  err.style.display = this.value && !isSchoolEmail(this.value) ? 'flex' : 'none';
});

document.getElementById('email').addEventListener('input', function() {
  if (isSchoolEmail(this.value)) {
    document.getElementById('emailError').style.display = 'none';
  }
});

// ── Password strength checker ─────────────────────────────────
document.getElementById('password').addEventListener('input', function() {
  const pwd   = this.value;
  const reqs  = document.getElementById('pwRequirements');
  const bar   = document.getElementById('strengthBar');
  const fill  = document.getElementById('strengthFill');
  const label = document.getElementById('strengthLabel');

  if (!pwd) {
    reqs.classList.remove('visible');
    bar.style.display = 'none';
    label.textContent = '';
    return;
  }

  reqs.classList.add('visible');
  bar.style.display = 'block';

  const checks = getPasswordChecks(pwd);
  document.getElementById('req-length').className  = checks.length  ? 'good' : '';
  document.getElementById('req-upper').className   = checks.upper   ? 'good' : '';
  document.getElementById('req-lower').className   = checks.lower   ? 'good' : '';
  document.getElementById('req-number').className  = checks.number  ? 'good' : '';
  document.getElementById('req-special').className = checks.special ? 'good' : '';

  const score = Object.values(checks).filter(Boolean).length;
  const levels = [
    { color: '#ef4444', text: 'Very Weak',  width: '10%'  },
    { color: '#f97316', text: 'Weak',        width: '25%'  },
    { color: '#eab308', text: 'Fair',        width: '50%'  },
    { color: '#3b82f6', text: 'Strong',      width: '75%'  },
    { color: '#059669', text: 'Very Strong', width: '100%' }
  ];
  const level = levels[Math.max(score - 1, 0)];
  fill.style.width      = level.width;
  fill.style.background = level.color;
  label.textContent     = 'Password strength: ' + level.text;
  label.style.color     = level.color;

  checkMatch();
});

// ── Confirm password match ────────────────────────────────────
function checkMatch() {
  const pwd     = document.getElementById('password').value;
  const confirm = document.getElementById('confirmPassword').value;
  const msg     = document.getElementById('matchMsg');
  if (confirm) msg.style.display = pwd !== confirm ? 'flex' : 'none';
}

document.getElementById('confirmPassword').addEventListener('input', checkMatch);

// ── Form submit ───────────────────────────────────────────────
document.getElementById('adminForm').addEventListener('submit', async (e) => {
  e.preventDefault();

  const fullName        = document.getElementById('fullName').value.trim();
  const email           = document.getElementById('email').value.trim().toLowerCase();
  const password        = document.getElementById('password').value;
  const confirmPassword = document.getElementById('confirmPassword').value;

  if (!isSchoolEmail(email)) {
    document.getElementById('emailError').style.display = 'flex';
    document.getElementById('email').focus();
    return;
  }

  if (!isStrongPassword(password)) {
    alert('Please ensure your password meets all the requirements shown below the password field.');
    document.getElementById('password').focus();
    return;
  }

  if (password !== confirmPassword) {
    document.getElementById('matchMsg').style.display = 'flex';
    document.getElementById('confirmPassword').focus();
    return;
  }

  document.getElementById('recoveryForm').style.display = 'none';
  document.getElementById('loadingMessage').style.display = 'block';

  try {
    const response = await fetch(`${API_BASE_URL}/api/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fullName, email, password,
        role: 'Admin', status: 'active',
        phone: '', date_of_birth: null, gender: null, address: null
      })
    });
    if (!response.ok) throw new Error('API creation failed');
    console.log('Admin created via API');
  } catch (error) {
    console.log('Using localStorage fallback:', error.message);
    let users = [];
    try { users = JSON.parse(localStorage.getItem('emalashira_users') || '[]'); } catch(e) {}
    users = users.filter(u => u.email !== email);
    users.push({
      id: Date.now().toString(), fullName, email, password,
      role: 'Admin', status: 'active',
      createdAt: new Date().toISOString(), permissions: {}
    });
    localStorage.setItem('emalashira_users', JSON.stringify(users));
  }

  document.getElementById('loadingMessage').style.display = 'none';
  document.getElementById('successMessage').style.display = 'block';

  setTimeout(() => { window.location.href = 'login.html'; }, 3000);
});

// ── Password Generator ────────────────────────────────────────
function generateStrongPassword() {
  const upper   = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower   = 'abcdefghjkmnpqrstuvwxyz';
  const numbers = '23456789';
  const special = '!@#$%^&*+-=?';
  const words   = [
    'Tiger','Cloud','River','Stone','Flame','Eagle','Storm','Bloom',
    'Swift','Frost','Grove','Spark','Brave','Prime','Light','Forge'
  ];
  let pwd;
  do {
    const word  = words[Math.floor(Math.random() * words.length)];
    const n1    = numbers[Math.floor(Math.random() * numbers.length)];
    const n2    = numbers[Math.floor(Math.random() * numbers.length)];
    const spec  = special[Math.floor(Math.random() * special.length)];
    const ex1   = upper[Math.floor(Math.random() * upper.length)];
    const ex2   = lower[Math.floor(Math.random() * lower.length)];
    const ex3   = numbers[Math.floor(Math.random() * numbers.length)];
    const raw   = word + n1 + n2 + spec + ex1 + ex2 + ex3;
    pwd = raw.split('').sort(() => Math.random() - 0.5).join('');
  } while (!isStrongPassword(pwd));
  return pwd;
}

function showGeneratedPassword(pwd) {
  const box      = document.getElementById('pw-generated-box');
  const valueEl  = document.getElementById('pw-generated-value');
  const copiedMsg = document.getElementById('pw-copied-msg');
  valueEl.textContent  = pwd;
  box.style.display    = 'block';
  copiedMsg.style.display = 'none';
}

function applyPassword(pwd) {
  const pwInput = document.getElementById('password');
  const cfInput = document.getElementById('confirmPassword');
  pwInput.value = pwd;
  cfInput.value = pwd;
  pwInput.dispatchEvent(new Event('input')); // trigger strength checker
  checkMatch();
}

document.getElementById('generatePasswordBtn').addEventListener('click', () => {
  showGeneratedPassword(generateStrongPassword());
});

document.getElementById('pw-refresh-btn').addEventListener('click', () => {
  showGeneratedPassword(generateStrongPassword());
});

document.getElementById('pw-use-btn').addEventListener('click', () => {
  const pwd       = document.getElementById('pw-generated-value').textContent;
  const copiedMsg = document.getElementById('pw-copied-msg');
  applyPassword(pwd);
  navigator.clipboard?.writeText(pwd).then(() => {
    copiedMsg.textContent    = '✓ Applied & copied to clipboard!';
    copiedMsg.style.display  = 'block';
    setTimeout(() => { copiedMsg.style.display = 'none'; }, 3000);
  }).catch(() => {
    copiedMsg.textContent    = '✓ Password applied to the fields below.';
    copiedMsg.style.display  = 'block';
    setTimeout(() => { copiedMsg.style.display = 'none'; }, 3000);
  });
});

// Click the code value to copy
document.getElementById('pw-generated-value').addEventListener('click', function() {
  const copiedMsg = document.getElementById('pw-copied-msg');
  navigator.clipboard?.writeText(this.textContent).then(() => {
    copiedMsg.textContent   = '✓ Copied to clipboard!';
    copiedMsg.style.display = 'block';
    setTimeout(() => { copiedMsg.style.display = 'none'; }, 2000);
  });
});
