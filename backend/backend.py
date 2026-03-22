from flask import Flask, request, jsonify, render_template
from flask_cors import CORS
import bcrypt
import uuid
import os
import json
import logging
from datetime import datetime, timedelta
import traceback
import secrets
import hashlib
from functools import wraps

# ── NEW: rate limiting via a simple in-memory store ──────────────────
# In production, swap this for Redis (flask-limiter + Redis backend)
from collections import defaultdict
import time as _time

_rate_store = defaultdict(list)   # key -> [timestamp, ...]
_RATE_WINDOW = 60                 # seconds
_MAX_LOGIN_ATTEMPTS  = 10         # per IP per window
_MAX_SIGNUP_ATTEMPTS = 5

def _rate_limit(key: str, max_calls: int) -> bool:
    """Returns True if the call is allowed, False if rate-limited."""
    now = _time.monotonic()
    window = _rate_store[key]
    # Purge old entries
    _rate_store[key] = [t for t in window if now - t < _RATE_WINDOW]
    if len(_rate_store[key]) >= max_calls:
        return False
    _rate_store[key].append(now)
    return True

# ── NEW: simple session-token store ─────────────────────────────────
# In production replace with Redis or a signed JWT library (PyJWT).
_sessions = {}          # token -> {user_id, role, expires}
_SESSION_TTL = 86400    # 24 hours

def _create_session(user_id: str, role: str) -> str:
    token = secrets.token_hex(32)
    _sessions[token] = {
        "user_id": user_id,
        "role":    role,
        "expires": datetime.utcnow() + timedelta(seconds=_SESSION_TTL),
    }
    return token

def _get_session(token: str):
    s = _sessions.get(token)
    if not s:
        return None
    if datetime.utcnow() > s["expires"]:
        _sessions.pop(token, None)
        return None
    return s

def _delete_session(token: str):
    _sessions.pop(token, None)

# ── Auth decorator ───────────────────────────────────────────────────
# VULNERABILITY FIX #1: All protected endpoints now require a valid
# session token sent as  Authorization: Bearer <token>
def require_auth(roles=None):
    """
    Decorator factory.  Usage:
        @require_auth()                   — any authenticated user
        @require_auth(roles=['admin'])    — admin only
    """
    def decorator(f):
        @wraps(f)
        def wrapper(*args, **kwargs):
            auth_header = request.headers.get("Authorization", "")
            if not auth_header.startswith("Bearer "):
                return jsonify({"message": "Authentication required"}), 401
            token = auth_header[7:]
            session = _get_session(token)
            if not session:
                return jsonify({"message": "Invalid or expired session"}), 401
            if roles and session["role"] not in roles:
                return jsonify({"message": "Insufficient permissions"}), 403
            # Inject into request context so handlers can read it
            request.current_user = session
            return f(*args, **kwargs)
        return wrapper
    return decorator

# ───────────────────────────────────────────────
# Create Flask app
# ───────────────────────────────────────────────
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
app = Flask(__name__,
            template_folder=os.path.join(BASE_DIR, 'templates'),
            static_folder=os.path.join(BASE_DIR, 'static'),
            static_url_path='/static')

_RAW_ORIGINS = os.environ.get(
    "ALLOWED_ORIGINS",
    "http://localhost:5500,http://127.0.0.1:5500,http://localhost:5000"
)
ALLOWED_ORIGINS = [o.strip() for o in _RAW_ORIGINS.split(",") if o.strip()]
CORS(app, origins=ALLOWED_ORIGINS, supports_credentials=False)

@app.after_request
def add_security_headers(response):
    response.headers["X-Content-Type-Options"]  = "nosniff"
    response.headers["X-Frame-Options"]          = "DENY"
    response.headers["X-XSS-Protection"]         = "1; mode=block"
    response.headers["Referrer-Policy"]          = "strict-origin-when-cross-origin"
    response.headers["Cache-Control"]            = "no-store"
    response.headers["Pragma"]                   = "no-cache"
    response.headers.pop("Server", None)
    response.headers.pop("X-Powered-By", None)
    return response

log = logging.getLogger("werkzeug")
log.setLevel(logging.ERROR)

_SENSITIVE_FIELDS = {"password", "password_hash"}

def sanitize_user(user: dict) -> dict:
    if not user:
        return {}
    return {k: v for k, v in user.items() if k not in _SENSITIVE_FIELDS}

def sanitize_users(users: list) -> list:
    return [sanitize_user(u) for u in users]

# ───────────────────────────────────────────────
# Input validation helpers
# ───────────────────────────────────────────────
# VULNERABILITY FIX #8: Enforce maximum field lengths
_MAX_NAME_LEN     = 120
_MAX_EMAIL_LEN    = 254   # RFC 5321
_MAX_PASSWORD_LEN = 128
_MAX_PHONE_LEN    = 20
_MAX_ADDR_LEN     = 300
_MIN_PASSWORD_LEN = 10    # VULNERABILITY FIX #6: raised from 6 to 10

def _truncate(value, max_len: int) -> str:
    """Return value trimmed to max_len characters, or '' if falsy."""
    if not value:
        return ''
    return str(value)[:max_len]

def _validate_password_strength(password: str):
    """
    Returns (ok: bool, message: str).
    Enforces minimum length only here; extend with regex for more rules.
    """
    if len(password) < _MIN_PASSWORD_LEN:
        return False, f"Password must be at least {_MIN_PASSWORD_LEN} characters"
    if len(password) > _MAX_PASSWORD_LEN:
        return False, "Password is too long"
    return True, ""

# ───────────────────────────────────────────────
# Turso Database Configuration
# ───────────────────────────────────────────────
TURSO_URL   = os.environ.get("TURSO_DATABASE_URL", "").strip()
TURSO_TOKEN = os.environ.get("TURSO_AUTH_TOKEN",   "").strip()

import requests as _http

def _turso_exec(sql, params=None):
    url     = TURSO_URL.replace("libsql://", "https://") + "/v2/pipeline"
    headers = {"Authorization": "Bearer " + TURSO_TOKEN, "Content-Type": "application/json"}
    stmt    = {"type": "execute", "stmt": {"sql": sql}}
    if params:
        stmt["stmt"]["args"] = [_enc(p) for p in params]
    body = {"requests": [stmt, {"type": "close"}]}
    r    = _http.post(url, headers=headers, json=body, timeout=30)
    r.raise_for_status()
    res = r.json()["results"][0]
    if res["type"] == "error":
        raise Exception(res["error"]["message"])
    cols = [c["name"] for c in res["response"]["result"]["cols"]]
    return [{cols[i]: _dec(v) for i, v in enumerate(row)}
            for row in res["response"]["result"]["rows"]]

def _turso_batch(stmts):
    url     = TURSO_URL.replace("libsql://", "https://") + "/v2/pipeline"
    headers = {"Authorization": "Bearer " + TURSO_TOKEN, "Content-Type": "application/json"}
    reqs    = []
    for sql, params in stmts:
        s = {"type": "execute", "stmt": {"sql": sql}}
        if params:
            s["stmt"]["args"] = [_enc(p) for p in params]
        reqs.append(s)
    reqs.append({"type": "close"})
    r = _http.post(url, headers=headers, json={"requests": reqs}, timeout=30)
    r.raise_for_status()
    # VULNERABILITY FIX #4: removed bare except; errors now propagate

def _enc(v):
    if v is None:            return {"type": "null"}
    if isinstance(v, bool):  return {"type": "integer", "value": str(int(v))}
    if isinstance(v, int):   return {"type": "integer", "value": str(v)}
    if isinstance(v, float): return {"type": "float",   "value": str(v)}
    return {"type": "text", "value": str(v)}

def _dec(v):
    if v["type"] == "null":    return None
    if v["type"] == "integer": return int(v["value"])
    if v["type"] == "float":   return float(v["value"])
    return v["value"]

class TursoConn:
    def __init__(self): self._q = []
    def cursor(self):   return TursoCur(self)
    def commit(self):
        if self._q: _turso_batch(self._q); self._q = []
    def rollback(self): self._q = []
    def close(self):
        if self._q:
            # VULNERABILITY FIX #4: log the exception instead of swallowing it
            try:
                _turso_batch(self._q)
            except Exception as e:
                logging.getLogger(__name__).error("TursoConn.close batch error: %s", e)
            finally:
                self._q = []

class TursoCur:
    def __init__(self, c):
        self._c = c; self._rows = []; self._i = 0
        self.rowcount = 0; self.lastrowid = None
    def execute(self, sql, params=None):
        if sql.strip().upper().startswith("SELECT"):
            self._rows = _turso_exec(sql, params); self._i = 0; self.rowcount = len(self._rows)
        else:
            self._c._q.append((sql, params or []))
            try:    _turso_exec(sql, params); self.rowcount = 1
            except: self.rowcount = 0
        return self
    def fetchone(self):
        if self._rows and self._i < len(self._rows):
            r = self._rows[self._i]; self._i += 1; return r
        return None
    def fetchall(self):
        r = self._rows[self._i:]; self._i = len(self._rows); return r

SCHOOL_EMAIL_DOMAINS = ['emalashira.sc.ke', 'emalashira.ac.ke', 'emalashira.school.ke']

def validate_school_email(email):
    if not email or '@' not in email:
        return False
    domain = email.split('@')[1].lower()
    return any(domain == d.lower() or domain.endswith('.' + d.lower())
               for d in SCHOOL_EMAIL_DOMAINS)

# ───────────────────────────────────────────────
# Default Permissions
# ───────────────────────────────────────────────
def get_default_admin_permissions():
    return {str(m): {str(p): True for p in range(1, 6)} for m in range(1, 11)}

def get_default_teacher_permissions():
    perms = {}
    for m in range(1, 11):
        perms[str(m)] = {str(p): (True if m in [1, 2, 6, 7, 10] else p == 1) for p in range(1, 6)}
    return perms

def get_default_parent_permissions():
    perms = {}
    for m in range(1, 11):
        perms[str(m)] = {str(p): (p == 1 if m in [1, 2, 6, 10] else False) for p in range(1, 6)}
    return perms

def get_default_accountant_permissions():
    perms = {}
    for m in range(1, 11):
        perms[str(m)] = {str(p): (True if m == 4 else (p == 1 if m in [1, 5] else False)) for p in range(1, 6)}
    return perms

def get_db_connection():
    return TursoConn()

from contextlib import contextmanager

@contextmanager
def db_conn():
    conn = get_db_connection()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

ROLE_TABLE = {
    'admin':      'admins',
    'teacher':    'teachers',
    'parent':     'parents',
    'accountant': 'accountants',
}

# VULNERABILITY FIX #7: Only allow these specific roles to be assigned
ALLOWED_ROLES = set(ROLE_TABLE.keys())

def table_for_role(role: str) -> str:
    return ROLE_TABLE.get((role or '').lower(), 'pending_users')

def _find_user_by_email(cursor, email: str):
    for role, tbl in ROLE_TABLE.items():
        cursor.execute(f"SELECT * FROM {tbl} WHERE email = ?", (email,))
        row = cursor.fetchone()
        if row:
            d = dict(row); d['role'] = role.lower()
            return d, role
    cursor.execute("SELECT * FROM pending_users WHERE email = ?", (email,))
    row = cursor.fetchone()
    if row:
        d = dict(row); d['role'] = 'pending'
        return d, 'pending'
    return None, None

def _find_user_by_id(cursor, user_id: str):
    for role, tbl in ROLE_TABLE.items():
        cursor.execute(f"SELECT * FROM {tbl} WHERE id = ?", (user_id,))
        row = cursor.fetchone()
        if row:
            d = dict(row); d['role'] = role.lower()
            return d, role
    cursor.execute("SELECT * FROM pending_users WHERE id = ?", (user_id,))
    row = cursor.fetchone()
    if row:
        d = dict(row); d['role'] = 'pending'
        return d, 'pending'
    return None, None

# ───────────────────────────────────────────────
# Database Init  (unchanged — omitted for brevity)
# ───────────────────────────────────────────────
def init_db():
    conn   = TursoConn()
    cursor = conn.cursor()
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS admins (
            id TEXT PRIMARY KEY, fullName TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL, phone TEXT, date_of_birth TEXT, gender TEXT, address TEXT,
            status TEXT DEFAULT 'active', last_login TEXT, createdAt TEXT NOT NULL
        )""")
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS teachers (
            id TEXT PRIMARY KEY, fullName TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL, phone TEXT, date_of_birth TEXT, gender TEXT, address TEXT,
            subject TEXT, status TEXT DEFAULT 'active', last_login TEXT, createdAt TEXT NOT NULL
        )""")
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS parents (
            id TEXT PRIMARY KEY, fullName TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL, phone TEXT, date_of_birth TEXT, gender TEXT, address TEXT,
            children TEXT DEFAULT '[]', status TEXT DEFAULT 'active', last_login TEXT, createdAt TEXT NOT NULL
        )""")
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS accountants (
            id TEXT PRIMARY KEY, fullName TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL, phone TEXT, date_of_birth TEXT, gender TEXT, address TEXT,
            status TEXT DEFAULT 'active', last_login TEXT, createdAt TEXT NOT NULL
        )""")
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS students (
            id TEXT PRIMARY KEY, fullName TEXT NOT NULL, admissionNumber TEXT UNIQUE NOT NULL,
            studentClass TEXT, gender TEXT, date_of_birth TEXT, parentName TEXT, parentPhone TEXT,
            address TEXT, status TEXT DEFAULT 'active', admissionDate TEXT, createdAt TEXT NOT NULL
        )""")
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS fee_structure (
            id TEXT PRIMARY KEY, student_id TEXT NOT NULL, term TEXT NOT NULL, year INTEGER NOT NULL,
            total_fee REAL DEFAULT 0, created_at TEXT NOT NULL, UNIQUE(student_id, term, year)
        )""")
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS fee_payments (
            id TEXT PRIMARY KEY, student_id TEXT NOT NULL, term TEXT, year INTEGER,
            amount REAL NOT NULL, method TEXT DEFAULT 'Cash', reference TEXT,
            status TEXT DEFAULT 'completed', notes TEXT, created_at TEXT NOT NULL
        )""")
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS announcements (
            id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL,
            author TEXT NOT NULL, author_role TEXT NOT NULL,
            audience TEXT DEFAULT 'all', priority TEXT DEFAULT 'normal',
            created_at TEXT NOT NULL, updated_at TEXT
        )""")
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS grades (
            id TEXT PRIMARY KEY, student_id TEXT NOT NULL,
            admission_no TEXT, student_name TEXT, student_class TEXT,
            subject TEXT NOT NULL, score INTEGER NOT NULL, grade TEXT NOT NULL,
            performance TEXT, term TEXT NOT NULL, exam_type TEXT DEFAULT 'End of Term',
            teacher_name TEXT, teacher_id TEXT, remarks TEXT DEFAULT '',
            date_posted TEXT NOT NULL, created_at TEXT NOT NULL
        )""")
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS attendance (
            id TEXT PRIMARY KEY, student_id TEXT NOT NULL,
            admission_no TEXT, student_name TEXT, student_class TEXT,
            date TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('Present','Absent','Late','Excused')),
            remarks TEXT DEFAULT '', teacher_name TEXT, teacher_id TEXT,
            created_at TEXT NOT NULL, UNIQUE(student_id, date)
        )""")
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS roles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL, description TEXT,
            is_system_role INTEGER DEFAULT 0,
            permissions TEXT, users_count INTEGER DEFAULT 0, created_at TEXT NOT NULL
        )""")
    cursor.execute("SELECT COUNT(*) as cnt FROM roles")
    if (cursor.fetchone() or {}).get("cnt", 0) == 0:
        for name, desc, perms in [
            ('Admin',      'Full system access',                        get_default_admin_permissions()),
            ('Teacher',    'Access to teaching modules',                get_default_teacher_permissions()),
            ('Parent',     "View access to own children's information", get_default_parent_permissions()),
            ('Accountant', 'Access to financial modules',               get_default_accountant_permissions()),
        ]:
            cursor.execute("""
                INSERT INTO roles (name, description, is_system_role, permissions, users_count, created_at)
                VALUES (?, ?, 1, ?, 0, ?)
            """, (name, desc, json.dumps(perms), datetime.now().isoformat()))
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS teacher_assignments (
            id TEXT PRIMARY KEY, teacher_id TEXT NOT NULL,
            class_name TEXT NOT NULL, subject TEXT NOT NULL,
            assigned_by TEXT DEFAULT 'Admin', assigned_at TEXT NOT NULL
        )""")
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS class_teacher_assignments (
            id TEXT PRIMARY KEY, teacher_id TEXT NOT NULL,
            class_name TEXT NOT NULL UNIQUE,
            assigned_by TEXT DEFAULT 'Admin', assigned_at TEXT NOT NULL,
            FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE CASCADE
        )""")
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS pending_users (
            id TEXT PRIMARY KEY, fullName TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL, phone TEXT, date_of_birth TEXT, gender TEXT, address TEXT,
            status TEXT DEFAULT 'pending', last_login TEXT, createdAt TEXT NOT NULL
        )""")
    conn.commit()
    conn.close()
    print("[DB] Initialised")

init_db()

# ───────────────────────────────────────────────
# Page Routes (unchanged)
# ───────────────────────────────────────────────
@app.route('/')
def home(): return render_template('index.html')

@app.route('/login.html')
@app.route('/login')
def login_page(): return render_template('login.html')

@app.route('/settings.html')
@app.route('/settings')
def settings_page():
    return render_template('settings.html')

@app.route('/dashboard.html')
@app.route('/dashboard')
def dashboard_page(): return render_template('dashboard.html')

# (other page routes unchanged — omit for brevity)

# ───────────────────────────────────────────────
# Auth Routes
# ───────────────────────────────────────────────

@app.route('/api/signup', methods=['POST'])
def signup():
    # VULNERABILITY FIX #3: rate-limit signup by IP
    client_ip = request.remote_addr or "unknown"
    if not _rate_limit(f"signup:{client_ip}", _MAX_SIGNUP_ATTEMPTS):
        return jsonify({'message': 'Too many requests. Try again later.'}), 429

    try:
        data     = request.get_json()
        # VULNERABILITY FIX #8: truncate all inputs to safe lengths
        fullName = _truncate(data.get('fullName', ''), _MAX_NAME_LEN).strip()
        email    = _truncate(data.get('email', ''), _MAX_EMAIL_LEN).strip().lower()
        password = data.get('password', '')

        if not all([fullName, email, password]):
            return jsonify({'message': 'All fields are required'}), 400

        if not validate_school_email(email):
            return jsonify({'message': f'Please use your school email address (@{SCHOOL_EMAIL_DOMAINS[0]})'}), 400

        # VULNERABILITY FIX #6: stronger minimum password requirement
        ok, msg = _validate_password_strength(password)
        if not ok:
            return jsonify({'message': msg}), 400

        conn   = get_db_connection()
        cursor = conn.cursor()
        existing, _ = _find_user_by_email(cursor, email)
        if existing:
            conn.close()
            return jsonify({'message': 'Email already exists'}), 409

        uid    = str(uuid.uuid4())
        hashed = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()
        now    = datetime.now().isoformat()
        cursor.execute("""
            INSERT INTO pending_users (id, fullName, email, password, status, createdAt)
            VALUES (?, ?, ?, ?, 'pending', ?)
        """, (uid, fullName, email, hashed, now))
        conn.commit(); conn.close()
        return jsonify({'message': 'Account created! Awaiting admin approval.',
                        'user': {'id': uid, 'fullName': fullName, 'email': email,
                                 'role': 'Pending', 'status': 'pending'}}), 201
    except Exception:
        traceback.print_exc()
        return jsonify({'message': 'Server error'}), 500


@app.route('/api/login', methods=['POST'])
def login():
    # VULNERABILITY FIX #3: rate-limit login by IP
    client_ip = request.remote_addr or "unknown"
    if not _rate_limit(f"login:{client_ip}", _MAX_LOGIN_ATTEMPTS):
        return jsonify({'message': 'Too many login attempts. Try again later.'}), 429

    try:
        data     = request.get_json()
        email    = _truncate(data.get('email', ''), _MAX_EMAIL_LEN).strip().lower()
        password = data.get('password', '')
        if not email or not password:
            return jsonify({'message': 'Email and password required'}), 400

        with db_conn() as conn:
            cursor = conn.cursor()
            user, role = _find_user_by_email(cursor, email)

            # Use a constant-time comparison path regardless of whether the
            # user exists, to prevent user-enumeration via timing.
            if user:
                password_matches = bcrypt.checkpw(
                    password.encode(), user['password'].encode()
                )
            else:
                # Perform a dummy bcrypt check to keep timing consistent
                bcrypt.checkpw(b'dummy', bcrypt.hashpw(b'dummy', bcrypt.gensalt()))
                password_matches = False

            if not user or not password_matches:
                return jsonify({'message': 'Invalid email or password'}), 401

            tbl = table_for_role(role)
            uid = user['id'] or str(uuid.uuid4())
            cursor.execute(f"UPDATE {tbl} SET last_login = ? WHERE email = ?",
                           (datetime.now().isoformat(), email))
            if not user['id']:
                cursor.execute(f"UPDATE {tbl} SET id = ? WHERE email = ?", (uid, email))

        # VULNERABILITY FIX #1: issue a session token on successful login
        token = _create_session(uid, role)

        return jsonify({
            'message': 'Login successful',
            'token':   token,           # client stores this and sends as Authorization: Bearer <token>
            'user': {
                'id':       uid,
                'fullName': user['fullName'],
                'email':    user['email'],
                'role':     user.get('role', role.lower()),
                'status':   user.get('status', 'active'),
            }
        })
    except Exception:
        traceback.print_exc()
        return jsonify({'message': 'Server error'}), 500


@app.route('/api/logout', methods=['POST'])
def logout():
    """Invalidate the session token."""
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Bearer "):
        _delete_session(auth_header[7:])
    return jsonify({'message': 'Logged out'})


@app.route('/api/forgot-password', methods=['POST'])
def forgot_password():
    # VULNERABILITY FIX #5: This stub now at least validates the email exists
    # before claiming to send a reset link.  Wire up a real mailer here.
    try:
        data  = request.get_json()
        email = _truncate(data.get('email', ''), _MAX_EMAIL_LEN).strip().lower()
        conn  = get_db_connection()
        cursor = conn.cursor()
        user, _ = _find_user_by_email(cursor, email)
        conn.close()
        # Always return the same message to avoid user enumeration
        if user:
            # TODO: generate a reset token, store it, and email it
            pass
        return jsonify({'message': 'If an account exists, a reset link has been sent to your email.'})
    except Exception:
        traceback.print_exc()
        return jsonify({'message': 'Server error'}), 500


@app.route('/api/change-password', methods=['POST'])
# VULNERABILITY FIX #1 + #2: require auth; use the session identity — not
# the email supplied in the request body — to identify who is changing
# their password.  This prevents one user from changing another's password.
@require_auth()
def change_password():
    try:
        data             = request.get_json()
        current_password = data.get('currentPassword', '')
        new_password     = data.get('newPassword', '')

        if not all([current_password, new_password]):
            return jsonify({'message': 'All fields are required'}), 400

        # VULNERABILITY FIX #6: enforce password strength on the new password
        ok, msg = _validate_password_strength(new_password)
        if not ok:
            return jsonify({'message': msg}), 400

        # Use the identity from the verified session, not from the request body
        user_id = request.current_user['user_id']

        conn   = get_db_connection()
        cursor = conn.cursor()
        user, role = _find_user_by_id(cursor, user_id)
        if not user:
            conn.close()
            return jsonify({'message': 'User not found'}), 404
        if not bcrypt.checkpw(current_password.encode(), user['password'].encode()):
            conn.close()
            return jsonify({'message': 'Current password is incorrect'}), 401

        tbl    = table_for_role(role)
        hashed = bcrypt.hashpw(new_password.encode(), bcrypt.gensalt()).decode()
        cursor.execute(f"UPDATE {tbl} SET password = ? WHERE id = ?", (hashed, user_id))
        conn.commit(); conn.close()
        return jsonify({'message': 'Password updated successfully'})
    except Exception:
        traceback.print_exc()
        return jsonify({'message': 'Server error'}), 500


# ───────────────────────────────────────────────
# User Management Routes  (all now require auth)
# ───────────────────────────────────────────────

@app.route('/api/users/counts', methods=['GET'])
@require_auth(roles=['admin'])   # VULNERABILITY FIX #1
def get_user_counts():
    try:
        conn   = get_db_connection()
        cursor = conn.cursor()
        counts = {role: 0 for role in ROLE_TABLE}
        for role, tbl in ROLE_TABLE.items():
            cursor.execute(f"SELECT COUNT(*) as cnt FROM {tbl}")
            row = cursor.fetchone(); counts[role] = row["cnt"] if row else 0
        try:
            cursor.execute("SELECT COUNT(*) as cnt FROM pending_users")
            row = cursor.fetchone(); counts['Pending'] = row["cnt"] if row else 0
        except Exception:
            counts['Pending'] = 0
        try:
            cursor.execute("SELECT COUNT(*) as cnt FROM students")
            row = cursor.fetchone(); counts['Student'] = row["cnt"] if row else 0
        except Exception:
            counts['Student'] = 0
        conn.close()
        counts['Total'] = sum(v for k, v in counts.items() if k != 'Pending')
        return jsonify(counts)
    except Exception:
        traceback.print_exc()
        return jsonify({'message': 'Server error'}), 500


@app.route('/api/users', methods=['GET'])
@require_auth(roles=['admin'])   # VULNERABILITY FIX #1
def get_users():
    try:
        conn   = get_db_connection()
        cursor = conn.cursor()
        all_users = []
        try:
            cursor.execute("""
                SELECT id, fullName, email, phone, date_of_birth, gender,
                       address, status, createdAt, last_login
                FROM pending_users ORDER BY createdAt DESC
            """)
            for row in cursor.fetchall():
                u = dict(row); u['role'] = 'Pending'; all_users.append(u)
        except Exception as ex:
            print(f'[WARN] pending_users query failed: {ex}')
        for role, tbl in ROLE_TABLE.items():
            extra = ', children' if tbl == 'parents' else ''
            cursor.execute(f"""
                SELECT id, fullName, email, phone, date_of_birth, gender,
                       address, status, createdAt, last_login{extra}
                FROM {tbl} ORDER BY createdAt DESC
            """)
            for row in cursor.fetchall():
                u = dict(row); u['role'] = role.lower()
                if tbl == 'parents':
                    try:    u['children'] = json.loads(u.get('children') or '[]')
                    except: u['children'] = []
                else:
                    u['children'] = []
                all_users.append(u)
        conn.close()
        all_users.sort(key=lambda x: x.get('createdAt') or '', reverse=True)
        return jsonify(sanitize_users(all_users))
    except Exception:
        traceback.print_exc()
        return jsonify({'message': 'Server error'}), 500


@app.route('/api/users/<user_id>', methods=['GET'])
@require_auth()   # VULNERABILITY FIX #1: any logged-in user can view a profile
def get_user(user_id):
    try:
        # Non-admins may only view their own profile
        session = request.current_user
        if session['role'] != 'admin' and session['user_id'] != user_id:
            return jsonify({'message': 'Insufficient permissions'}), 403

        conn   = get_db_connection()
        cursor = conn.cursor()
        user, _ = _find_user_by_id(cursor, user_id)
        conn.close()
        if not user:
            return jsonify({'message': 'User not found'}), 404
        return jsonify(sanitize_user(user))
    except Exception:
        traceback.print_exc()
        return jsonify({'message': 'Server error'}), 500


@app.route('/api/users', methods=['POST'])
@require_auth(roles=['admin'])   # VULNERABILITY FIX #1 + #7
def create_user():
    try:
        data          = request.get_json()
        fullName      = _truncate(data.get('fullName') or '', _MAX_NAME_LEN).strip()
        email         = _truncate(data.get('email') or '', _MAX_EMAIL_LEN).strip().lower()
        password      = data.get('password', '')
        # VULNERABILITY FIX #7: validate role against allowlist
        requested_role = (data.get('role') or 'teacher').lower()
        if requested_role not in ALLOWED_ROLES:
            return jsonify({'message': f'Invalid role. Allowed: {", ".join(ALLOWED_ROLES)}'}), 400
        assigned_role = requested_role

        if not all([fullName, email, password]):
            return jsonify({'message': 'Missing required fields'}), 400
        if not validate_school_email(email):
            return jsonify({'message': f'Please use a school email address (@{SCHOOL_EMAIL_DOMAINS[0]})'}), 400
        ok, msg = _validate_password_strength(password)
        if not ok:
            return jsonify({'message': msg}), 400

        conn   = get_db_connection()
        cursor = conn.cursor()
        existing, _ = _find_user_by_email(cursor, email)
        if existing:
            conn.close()
            return jsonify({'message': 'Email already exists'}), 409

        tbl    = table_for_role(assigned_role)
        uid    = str(uuid.uuid4())
        hashed = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()
        now    = datetime.now().isoformat()

        if tbl == 'parents':
            children_json = json.dumps(data.get('children', []))
            cursor.execute("""
                INSERT INTO parents
                  (id,fullName,email,password,phone,date_of_birth,gender,address,children,status,createdAt)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)
            """, (uid, fullName, email, hashed,
                  _truncate(data.get('phone'), _MAX_PHONE_LEN),
                  data.get('date_of_birth'), data.get('gender'),
                  _truncate(data.get('address'), _MAX_ADDR_LEN),
                  children_json, data.get('status', 'active'), now))
        elif tbl == 'teachers':
            cursor.execute("""
                INSERT INTO teachers
                  (id,fullName,email,password,phone,date_of_birth,gender,address,subject,status,createdAt)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)
            """, (uid, fullName, email, hashed,
                  _truncate(data.get('phone'), _MAX_PHONE_LEN),
                  data.get('date_of_birth'), data.get('gender'),
                  _truncate(data.get('address'), _MAX_ADDR_LEN),
                  data.get('subject'), data.get('status', 'active'), now))
        else:
            cursor.execute(f"""
                INSERT INTO {tbl}
                  (id,fullName,email,password,phone,date_of_birth,gender,address,status,createdAt)
                VALUES (?,?,?,?,?,?,?,?,?,?)
            """, (uid, fullName, email, hashed,
                  _truncate(data.get('phone'), _MAX_PHONE_LEN),
                  data.get('date_of_birth'), data.get('gender'),
                  _truncate(data.get('address'), _MAX_ADDR_LEN),
                  data.get('status', 'active'), now))

        cursor.execute("UPDATE roles SET users_count = users_count+1 WHERE LOWER(name) = ?", (assigned_role,))
        conn.commit(); conn.close()
        return jsonify({'message': 'User created successfully',
                        'user': {'id': uid, 'fullName': fullName, 'email': email,
                                 'role': assigned_role.lower()}}), 201
    except Exception:
        traceback.print_exc()
        return jsonify({'message': 'Server error'}), 500


@app.route('/api/admin/create-user', methods=['POST'])
@require_auth(roles=['admin'])
def admin_create_user():
    return create_user()


@app.route('/api/users/bulk', methods=['POST'])
@require_auth(roles=['admin'])   # VULNERABILITY FIX #1
def bulk_create_users():
    try:
        data  = request.get_json()
        users = data.get('users') if data else None
        if not isinstance(users, list) or len(users) == 0:
            return jsonify({'message': '"users" array is required'}), 400
        if len(users) > 100:
            return jsonify({'message': 'Maximum 100 users per batch'}), 400

        results = []; succeeded = 0; failed = 0
        now = datetime.now().isoformat()

        with db_conn() as conn:
            cursor = conn.cursor()
            for u in users:
                fullName = _truncate(u.get('fullName') or '', _MAX_NAME_LEN).strip()
                email    = _truncate(u.get('email')    or '', _MAX_EMAIL_LEN).strip().lower()
                password = u.get('password', '')
                role     = (u.get('role') or 'teacher').lower()

                if not all([fullName, email, password]):
                    results.append({'email': email or '?', 'status': 'failed',
                                    'reason': 'Missing fullName, email or password'})
                    failed += 1; continue

                # VULNERABILITY FIX #7: validate role allowlist in bulk too
                if role not in ALLOWED_ROLES:
                    results.append({'email': email, 'status': 'failed',
                                    'reason': f'Invalid role: {role}'})
                    failed += 1; continue

                if not validate_school_email(email):
                    results.append({'email': email, 'status': 'failed',
                                    'reason': f'Email must use a school domain'})
                    failed += 1; continue

                ok, msg = _validate_password_strength(password)
                if not ok:
                    results.append({'email': email, 'status': 'failed', 'reason': msg})
                    failed += 1; continue

                existing, _ = _find_user_by_email(cursor, email)
                if existing:
                    results.append({'email': email, 'status': 'failed', 'reason': 'Email already exists'})
                    failed += 1; continue

                tbl    = table_for_role(role)
                uid    = str(uuid.uuid4())
                hashed = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()

                try:
                    if tbl == 'parents':
                        cursor.execute("""
                            INSERT INTO parents
                              (id,fullName,email,password,phone,date_of_birth,gender,address,children,status,createdAt)
                            VALUES (?,?,?,?,?,?,?,?,?,?,?)
                        """, (uid, fullName, email, hashed,
                              _truncate(u.get('phone'), _MAX_PHONE_LEN),
                              u.get('date_of_birth'), u.get('gender'),
                              _truncate(u.get('address'), _MAX_ADDR_LEN),
                              json.dumps(u.get('children', [])), u.get('status', 'active'), now))
                    elif tbl == 'teachers':
                        cursor.execute("""
                            INSERT INTO teachers
                              (id,fullName,email,password,phone,date_of_birth,gender,address,subject,status,createdAt)
                            VALUES (?,?,?,?,?,?,?,?,?,?,?)
                        """, (uid, fullName, email, hashed,
                              _truncate(u.get('phone'), _MAX_PHONE_LEN),
                              u.get('date_of_birth'), u.get('gender'),
                              _truncate(u.get('address'), _MAX_ADDR_LEN),
                              u.get('subject'), u.get('status', 'active'), now))
                    else:
                        cursor.execute(f"""
                            INSERT INTO {tbl}
                              (id,fullName,email,password,phone,date_of_birth,gender,address,status,createdAt)
                            VALUES (?,?,?,?,?,?,?,?,?,?)
                        """, (uid, fullName, email, hashed,
                              _truncate(u.get('phone'), _MAX_PHONE_LEN),
                              u.get('date_of_birth'), u.get('gender'),
                              _truncate(u.get('address'), _MAX_ADDR_LEN),
                              u.get('status', 'active'), now))

                    cursor.execute("UPDATE roles SET users_count=users_count+1 WHERE LOWER(name)=?", (role,))
                    results.append({'email': email, 'status': 'created', 'id': uid, 'role': role})
                    succeeded += 1

                except Exception as row_err:
                    results.append({'email': email, 'status': 'failed', 'reason': str(row_err)})
                    failed += 1

        return jsonify({
            'message':   f'{succeeded} created, {failed} failed',
            'succeeded': succeeded, 'failed': failed, 'results': results
        }), 207 if failed > 0 else 201

    except Exception:
        traceback.print_exc()
        return jsonify({'message': 'Server error'}), 500


@app.route('/api/users/<user_id>', methods=['PUT'])
@require_auth(roles=['admin'])   # VULNERABILITY FIX #1
def update_user(user_id):
    try:
        data   = request.get_json()
        conn   = get_db_connection()
        cursor = conn.cursor()
        user, old_role = _find_user_by_id(cursor, user_id)
        if not user:
            conn.close()
            return jsonify({'message': 'User not found'}), 404

        # VULNERABILITY FIX #7: validate new role against allowlist
        requested_new_role = (data.get('role') or old_role).lower()
        if requested_new_role not in ALLOWED_ROLES:
            conn.close()
            return jsonify({'message': f'Invalid role. Allowed: {", ".join(ALLOWED_ROLES)}'}), 400
        new_role = requested_new_role
        old_tbl  = table_for_role(old_role)
        new_tbl  = table_for_role(new_role)

        if old_tbl != new_tbl:
            cursor.execute(f"DELETE FROM {old_tbl} WHERE id = ?", (user_id,))
            uid = user['id']; now = user.get('createdAt') or datetime.now().isoformat()
            pwd = user['password']
            if new_tbl == 'parents':
                cursor.execute("""
                    INSERT OR IGNORE INTO parents
                      (id,fullName,email,password,phone,date_of_birth,gender,address,children,status,createdAt)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?)
                """, (uid, data.get('fullName', user['fullName']), user['email'], pwd,
                      _truncate(data.get('phone'), _MAX_PHONE_LEN),
                      data.get('date_of_birth'), data.get('gender'),
                      _truncate(data.get('address'), _MAX_ADDR_LEN),
                      json.dumps(data.get('children', [])), data.get('status', 'active'), now))
            elif new_tbl == 'teachers':
                cursor.execute("""
                    INSERT OR IGNORE INTO teachers
                      (id,fullName,email,password,phone,date_of_birth,gender,address,subject,status,createdAt)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?)
                """, (uid, data.get('fullName', user['fullName']), user['email'], pwd,
                      _truncate(data.get('phone'), _MAX_PHONE_LEN),
                      data.get('date_of_birth'), data.get('gender'),
                      _truncate(data.get('address'), _MAX_ADDR_LEN),
                      data.get('subject'), data.get('status', 'active'), now))
            else:
                cursor.execute(f"""
                    INSERT OR IGNORE INTO {new_tbl}
                      (id,fullName,email,password,phone,date_of_birth,gender,address,status,createdAt)
                    VALUES (?,?,?,?,?,?,?,?,?,?)
                """, (uid, data.get('fullName', user['fullName']), user['email'], pwd,
                      _truncate(data.get('phone'), _MAX_PHONE_LEN),
                      data.get('date_of_birth'), data.get('gender'),
                      _truncate(data.get('address'), _MAX_ADDR_LEN),
                      data.get('status', 'active'), now))
            cursor.execute("UPDATE roles SET users_count=MAX(0,users_count-1) WHERE LOWER(name)=?", (old_role,))
            cursor.execute("UPDATE roles SET users_count=users_count+1 WHERE LOWER(name)=?", (new_role,))
        else:
            if new_tbl == 'parents':
                cursor.execute("""
                    UPDATE parents SET fullName=?,phone=?,date_of_birth=?,gender=?,
                      address=?,children=?,status=? WHERE id=?
                """, (data.get('fullName'),
                      _truncate(data.get('phone'), _MAX_PHONE_LEN),
                      data.get('date_of_birth'), data.get('gender'),
                      _truncate(data.get('address'), _MAX_ADDR_LEN),
                      json.dumps(data.get('children', [])), data.get('status', 'active'), user_id))
            elif new_tbl == 'teachers':
                cursor.execute("""
                    UPDATE teachers SET fullName=?,phone=?,date_of_birth=?,gender=?,
                      address=?,subject=?,status=? WHERE id=?
                """, (data.get('fullName'),
                      _truncate(data.get('phone'), _MAX_PHONE_LEN),
                      data.get('date_of_birth'), data.get('gender'),
                      _truncate(data.get('address'), _MAX_ADDR_LEN),
                      data.get('subject'), data.get('status', 'active'), user_id))
            else:
                cursor.execute(f"""
                    UPDATE {new_tbl} SET fullName=?,phone=?,date_of_birth=?,gender=?,
                      address=?,status=? WHERE id=?
                """, (data.get('fullName'),
                      _truncate(data.get('phone'), _MAX_PHONE_LEN),
                      data.get('date_of_birth'), data.get('gender'),
                      _truncate(data.get('address'), _MAX_ADDR_LEN),
                      data.get('status', 'active'), user_id))
        conn.commit(); conn.close()
        return jsonify({'message': 'User updated successfully'})
    except Exception:
        traceback.print_exc()
        return jsonify({'message': 'Server error'}), 500


@app.route('/api/users/<user_id>', methods=['DELETE'])
@require_auth(roles=['admin'])   # VULNERABILITY FIX #1
def delete_user(user_id):
    try:
        conn   = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT id FROM pending_users WHERE id = ?", (user_id,))
        if cursor.fetchone():
            cursor.execute("DELETE FROM pending_users WHERE id = ?", (user_id,))
            conn.commit(); conn.close()
            return jsonify({'message': 'User deleted'})
        user, role = _find_user_by_id(cursor, user_id)
        if not user:
            conn.close()
            return jsonify({'message': 'User not found'}), 404
        tbl = table_for_role(role)
        cursor.execute(f"DELETE FROM {tbl} WHERE id = ?", (user_id,))
        cursor.execute("UPDATE roles SET users_count=MAX(0,users_count-1) WHERE LOWER(name)=?", (role,))
        conn.commit(); conn.close()
        return jsonify({'message': 'User deleted successfully'})
    except Exception:
        traceback.print_exc()
        return jsonify({'message': 'Server error'}), 500

# ─────────────────────────────────────────────────────────────────────────────
# PATCHED FILE — Part 2
# Assumes require_auth, _rate_limit, _validate_password_strength, ALLOWED_ROLES,
# _truncate, _MAX_* constants, and all DB helpers are imported from part 1.
# ─────────────────────────────────────────────────────────────────────────────

@app.route('/api/users/<user_id>/reset-password', methods=['POST'])
@require_auth(roles=['admin'])   # FIX #1: was open — anyone could reset any password
def reset_user_password(user_id):
    try:
        data         = request.get_json()
        new_password = data.get('newPassword', '')
        ok, msg = _validate_password_strength(new_password)  # FIX: min 10 chars
        if not ok:
            return jsonify({'message': msg}), 400
        conn   = get_db_connection()
        cursor = conn.cursor()
        user, role = _find_user_by_id(cursor, user_id)
        if not user:
            conn.close()
            return jsonify({'message': 'User not found'}), 404
        tbl    = table_for_role(role)
        hashed = bcrypt.hashpw(new_password.encode(), bcrypt.gensalt()).decode()
        cursor.execute(f"UPDATE {tbl} SET password = ? WHERE id = ?", (hashed, user_id))
        conn.commit(); conn.close()
        return jsonify({'message': 'Password reset successfully'})
    except Exception:
        traceback.print_exc()
        return jsonify({'message': 'Server error'}), 500


@app.route('/api/users/by-email-lookup', methods=['GET'])
@require_auth(roles=['admin'])   # FIX #2: was open — user enumeration risk
def get_user_by_email():
    try:
        email = _truncate(request.args.get('email', ''), _MAX_EMAIL_LEN).strip().lower()
        if not email:
            return jsonify({'message': 'Email is required'}), 400
        conn   = get_db_connection()
        cursor = conn.cursor()
        user, _ = _find_user_by_email(cursor, email)
        conn.close()
        if not user:
            return jsonify({'message': 'User not found'}), 404
        return jsonify(sanitize_user(user))
    except Exception:
        traceback.print_exc()
        return jsonify({'message': 'Server error'}), 500


@app.route('/api/users/assign-role', methods=['POST'])
@require_auth(roles=['admin'])   # FIX #3: was open — anyone could self-promote to admin
def assign_role():
    try:
        data   = request.get_json()
        email  = _truncate(data.get('email') or '', _MAX_EMAIL_LEN).strip().lower()
        role   = (data.get('role') or '').strip().lower()
        status = data.get('status', 'active')
        if not email or not role:
            return jsonify({'message': 'Email and role are required'}), 400
        if role not in ALLOWED_ROLES:   # FIX: validate allowlist
            return jsonify({'message': f'Invalid role. Allowed: {", ".join(ALLOWED_ROLES)}'}), 400
        with db_conn() as conn:
            cursor = conn.cursor()
            user, old_role = _find_user_by_email(cursor, email)
            if not user:
                return jsonify({'message': 'User not found'}), 404
            if old_role != role:
                old_tbl = table_for_role(old_role); new_tbl = table_for_role(role)
                cursor.execute(f"DELETE FROM {old_tbl} WHERE email = ?", (email,))
                uid = user['id']; now = user.get('createdAt') or datetime.now().isoformat()
                if new_tbl == 'parents':
                    cursor.execute("""
                        INSERT OR IGNORE INTO parents
                          (id,fullName,email,password,phone,date_of_birth,gender,address,children,status,createdAt)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?)
                    """, (uid, user['fullName'], email, user['password'],
                          user.get('phone'), user.get('date_of_birth'), user.get('gender'),
                          user.get('address'), user.get('children', '[]'), status, now))
                else:
                    cursor.execute(f"""
                        INSERT OR IGNORE INTO {new_tbl}
                          (id,fullName,email,password,phone,date_of_birth,gender,address,status,createdAt)
                        VALUES (?,?,?,?,?,?,?,?,?,?)
                    """, (uid, user['fullName'], email, user['password'],
                          user.get('phone'), user.get('date_of_birth'), user.get('gender'),
                          user.get('address'), status, now))
                cursor.execute("UPDATE roles SET users_count=MAX(0,users_count-1) WHERE LOWER(name)=?", (old_role,))
                cursor.execute("UPDATE roles SET users_count=users_count+1 WHERE LOWER(name)=?", (role,))
            else:
                tbl = table_for_role(role)
                cursor.execute(f"UPDATE {tbl} SET status=? WHERE email=?", (status, email))
        return jsonify({'message': 'Role assigned successfully', 'email': email, 'role': role})
    except Exception:
        traceback.print_exc()
        return jsonify({'message': 'Server error'}), 500


@app.route('/api/users/by-email', methods=['PATCH'])
@require_auth(roles=['admin'])
def update_user_by_email_patch():
    try:
        data   = request.get_json()
        email  = _truncate(data.get('email') or '', _MAX_EMAIL_LEN).strip().lower()
        role   = data.get('role'); status = data.get('status')
        if not email:
            return jsonify({'message': 'Email is required'}), 400
        if role and role.lower() not in ALLOWED_ROLES:
            return jsonify({'message': f'Invalid role. Allowed: {", ".join(ALLOWED_ROLES)}'}), 400
        conn   = get_db_connection()
        cursor = conn.cursor()
        user, old_role = _find_user_by_email(cursor, email)
        if not user:
            conn.close()
            return jsonify({'message': 'User not found'}), 404
        new_role = (role or old_role).lower(); new_status = status or 'active'
        if new_role != old_role:
            old_tbl = table_for_role(old_role); new_tbl = table_for_role(new_role)
            cursor.execute(f"DELETE FROM {old_tbl} WHERE email=?", (email,))
            cursor.execute(f"""
                INSERT OR IGNORE INTO {new_tbl}
                  (id,fullName,email,password,phone,date_of_birth,gender,address,status,createdAt)
                VALUES (?,?,?,?,?,?,?,?,?,?)
            """, (user['id'], user['fullName'], email, user['password'],
                  user.get('phone'), user.get('date_of_birth'), user.get('gender'),
                  user.get('address'), new_status,
                  user.get('createdAt') or datetime.now().isoformat()))
            cursor.execute("UPDATE roles SET users_count=MAX(0,users_count-1) WHERE LOWER(name)=?", (old_role,))
            cursor.execute("UPDATE roles SET users_count=users_count+1 WHERE LOWER(name)=?", (new_role,))
        else:
            tbl = table_for_role(new_role)
            cursor.execute(f"UPDATE {tbl} SET status=? WHERE email=?", (new_status, email))
        conn.commit(); conn.close()
        return jsonify({'message': 'User updated successfully', 'email': email, 'role': new_role})
    except Exception:
        traceback.print_exc()
        return jsonify({'message': 'Server error'}), 500


@app.route('/api/users/update-by-email', methods=['PUT'])
@require_auth(roles=['admin'])
def update_user_by_email_put():
    try:
        data         = request.get_json()
        target_email = _truncate(data.get('targetEmail') or data.get('email') or '', _MAX_EMAIL_LEN).strip().lower()
        if not target_email:
            return jsonify({'message': 'Email is required'}), 400
        requested_role = data.get('role')
        if requested_role and requested_role.lower() not in ALLOWED_ROLES:
            return jsonify({'message': f'Invalid role. Allowed: {", ".join(ALLOWED_ROLES)}'}), 400
        conn   = get_db_connection()
        cursor = conn.cursor()
        user, old_role = _find_user_by_email(cursor, target_email)
        if not user:
            conn.close()
            return jsonify({'message': 'User not found'}), 404
        new_role = (requested_role or old_role).lower()
        old_tbl  = table_for_role(old_role); new_tbl = table_for_role(new_role)
        if old_tbl != new_tbl:
            cursor.execute(f"DELETE FROM {old_tbl} WHERE email=?", (target_email,))
            uid = user['id']; now = user.get('createdAt') or datetime.now().isoformat()
            if new_tbl == 'parents':
                cursor.execute("""
                    INSERT OR IGNORE INTO parents
                      (id,fullName,email,password,phone,date_of_birth,gender,address,children,status,createdAt)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?)
                """, (uid, data.get('fullName', user['fullName']), target_email, user['password'],
                      _truncate(data.get('phone'), _MAX_PHONE_LEN), data.get('date_of_birth'),
                      data.get('gender'), _truncate(data.get('address'), _MAX_ADDR_LEN),
                      json.dumps(data.get('children', [])), data.get('status', 'active'), now))
            else:
                cursor.execute(f"""
                    INSERT OR IGNORE INTO {new_tbl}
                      (id,fullName,email,password,phone,date_of_birth,gender,address,status,createdAt)
                    VALUES (?,?,?,?,?,?,?,?,?,?)
                """, (uid, data.get('fullName', user['fullName']), target_email, user['password'],
                      _truncate(data.get('phone'), _MAX_PHONE_LEN), data.get('date_of_birth'),
                      data.get('gender'), _truncate(data.get('address'), _MAX_ADDR_LEN),
                      data.get('status', 'active'), now))
            cursor.execute("UPDATE roles SET users_count=MAX(0,users_count-1) WHERE LOWER(name)=?", (old_role,))
            cursor.execute("UPDATE roles SET users_count=users_count+1 WHERE LOWER(name)=?", (new_role,))
        else:
            if new_tbl == 'parents':
                cursor.execute("""
                    UPDATE parents SET fullName=?,phone=?,date_of_birth=?,gender=?,
                      address=?,children=?,status=? WHERE email=?
                """, (data.get('fullName'), _truncate(data.get('phone'), _MAX_PHONE_LEN),
                      data.get('date_of_birth'), data.get('gender'),
                      _truncate(data.get('address'), _MAX_ADDR_LEN),
                      json.dumps(data.get('children', [])), data.get('status', 'active'), target_email))
            else:
                cursor.execute(f"""
                    UPDATE {new_tbl} SET fullName=?,phone=?,date_of_birth=?,gender=?,
                      address=?,status=? WHERE email=?
                """, (data.get('fullName'), _truncate(data.get('phone'), _MAX_PHONE_LEN),
                      data.get('date_of_birth'), data.get('gender'),
                      _truncate(data.get('address'), _MAX_ADDR_LEN),
                      data.get('status', 'active'), target_email))
        conn.commit(); conn.close()
        return jsonify({'message': 'User updated successfully'})
    except Exception:
        traceback.print_exc()
        return jsonify({'message': 'Server error'}), 500


# ───────────────────────────────────────────────
# Profile Routes
# ───────────────────────────────────────────────

@app.route('/api/profile', methods=['GET'])
@require_auth()   # FIX #1 + #4: identity from session, not query string
def get_profile():
    try:
        user_id = request.current_user['user_id']   # FIX #4
        conn   = get_db_connection()
        cursor = conn.cursor()
        user, role = _find_user_by_id(cursor, user_id)
        conn.close()
        if not user:
            return jsonify({'message': 'User not found'}), 404
        return jsonify({
            'id':          user.get('id')           or '',
            'fullName':    user.get('fullName')      or '',
            'email':       user.get('email')         or '',
            'phone':       user.get('phone')         or '',
            'dateOfBirth': user.get('date_of_birth') or '',
            'gender':      user.get('gender')        or '',
            'address':     user.get('address')       or '',
            'role':        user.get('role')          or role.lower(),
            'status':      user.get('status')        or 'active',
            'createdAt':   user.get('createdAt')     or '',
            'lastLogin':   user.get('last_login')    or 'Never',
        })
    except Exception:
        traceback.print_exc()
        return jsonify({'message': 'Server error'}), 500


@app.route('/api/profile', methods=['PUT'])
@require_auth()   # FIX #1 + #4: identity from session, not request body
def update_profile():
    try:
        data    = request.get_json()
        user_id = request.current_user['user_id']   # FIX #4
        conn   = get_db_connection()
        cursor = conn.cursor()
        user, role = _find_user_by_id(cursor, user_id)
        if not user:
            conn.close()
            return jsonify({'message': 'User not found'}), 404
        tbl     = table_for_role(role)
        allowed = ['fullName', 'phone', 'date_of_birth', 'gender', 'address']
        updates = {}
        for k in allowed:
            if k in data and data[k] is not None:
                v = data[k]
                if k == 'fullName': v = _truncate(v, _MAX_NAME_LEN)
                if k == 'phone':    v = _truncate(v, _MAX_PHONE_LEN)
                if k == 'address':  v = _truncate(v, _MAX_ADDR_LEN)
                updates[k] = v.strip() if isinstance(v, str) else v
        if not updates:
            conn.close()
            return jsonify({'message': 'No fields to update'}), 400
        set_clause = ", ".join(f"{k} = ?" for k in updates)
        cursor.execute(f"UPDATE {tbl} SET {set_clause} WHERE id = ?",
                       list(updates.values()) + [user_id])
        conn.commit(); conn.close()
        return jsonify({'message': 'Profile updated successfully'})
    except Exception:
        traceback.print_exc()
        return jsonify({'message': 'Server error'}), 500


# FIX #5: Dead orphaned change_password() function removed entirely.
# The registered route lives in part 1 and uses session identity.


# ───────────────────────────────────────────────
# Parent Portal
# ───────────────────────────────────────────────

@app.route('/api/parent/children', methods=['GET'])
@require_auth(roles=['parent', 'admin'])   # FIX #1 + #4: X-User-Email header was trusted blindly
def get_parent_children():
    try:
        user_id = request.current_user['user_id']
        role    = request.current_user['role']
        conn   = get_db_connection()
        cursor = conn.cursor()
        target_id = request.args.get('parent_id', user_id).strip() if role == 'admin' else user_id
        cursor.execute("SELECT fullName, children FROM parents WHERE id = ?", (target_id,))
        row = cursor.fetchone()
        if not row:
            conn.close()
            return jsonify({'message': 'Parent not found'}), 404
        parent_name = (row['fullName'] or '').strip()
        try:    kids = json.loads(row['children'] or '[]')
        except: kids = []
        seen_adm = {}
        for i, ch in enumerate(kids):
            adm_no = (ch.get('admissionNumber') or ch.get('admNo') or
                      ch.get('admission_number') or ch.get('admissionNo') or '').strip()
            student_row = None
            if adm_no:
                cursor.execute("SELECT id, fullName, studentClass FROM students "
                               "WHERE admissionNumber = ? COLLATE NOCASE LIMIT 1", (adm_no,))
                student_row = cursor.fetchone()
            real_id = student_row['id'] if student_row else None
            name = ((student_row['fullName'] if student_row else None) or
                    ch.get('childName') or ch.get('name') or ch.get('fullName') or 'Unknown')
            cls  = ((student_row['studentClass'] if student_row else None) or
                    ch.get('className') or ch.get('class') or '—')
            entry = {'id': real_id or ch.get('id') or f'child_{i}', 'name': name,
                     'admissionNumber': adm_no or '—', 'class': cls,
                     'relationship': ch.get('relationship') or 'Parent',
                     'id_resolved': real_id is not None}
            seen_adm[adm_no.lower() if adm_no else f'__json_{i}'] = entry
        if parent_name:
            cursor.execute("SELECT id, fullName, admissionNumber, studentClass FROM students "
                           "WHERE LOWER(TRIM(parentName)) = LOWER(TRIM(?)) "
                           "AND (status IS NULL OR LOWER(status) != 'inactive')", (parent_name,))
            for sr in cursor.fetchall():
                adm_no = (sr['admissionNumber'] or '').strip()
                key    = adm_no.lower() if adm_no else f'__db_{sr["id"]}'
                if key in seen_adm:
                    seen_adm[key]['id_resolved'] = True; seen_adm[key]['id'] = sr['id']; continue
                seen_adm[key] = {'id': sr['id'], 'name': sr['fullName'] or 'Unknown',
                                 'admissionNumber': adm_no or '—', 'class': sr['studentClass'] or '—',
                                 'relationship': 'Parent', 'id_resolved': True}
        conn.close()
        return jsonify(list(seen_adm.values()))
    except Exception:
        traceback.print_exc()
        return jsonify({'message': 'Server error'}), 500


# ───────────────────────────────────────────────
# Students Routes
# ───────────────────────────────────────────────

@app.route('/api/students', methods=['GET'])
@require_auth(roles=['admin', 'teacher', 'accountant'])
def get_students():
    try:
        conn = get_db_connection(); cursor = conn.cursor()
        cursor.execute("SELECT id,fullName,admissionNumber,studentClass,gender,date_of_birth,"
                       "parentName,parentPhone,address,status,admissionDate,createdAt "
                       "FROM students ORDER BY fullName ASC")
        rows = [dict(r) for r in cursor.fetchall()]; conn.close()
        return jsonify(rows)
    except Exception:
        traceback.print_exc(); return jsonify({'message': 'Server error'}), 500


@app.route('/api/students', methods=['POST'])
@require_auth(roles=['admin'])
def create_student():
    try:
        data            = request.get_json()
        fullName        = _truncate(data.get('fullName') or '', _MAX_NAME_LEN).strip()
        admissionNumber = _truncate(data.get('admissionNumber') or '', 30).strip()
        if not fullName or not admissionNumber:
            return jsonify({'message': 'Full name and admission number are required'}), 400
        conn = get_db_connection(); cursor = conn.cursor()
        cursor.execute("SELECT id FROM students WHERE admissionNumber = ?", (admissionNumber,))
        if cursor.fetchone():
            conn.close(); return jsonify({'message': 'Admission number already exists'}), 409
        sid = str(uuid.uuid4()); now = datetime.now().isoformat()
        cursor.execute("""
            INSERT INTO students
              (id,fullName,admissionNumber,studentClass,gender,date_of_birth,
               parentName,parentPhone,address,status,admissionDate,createdAt)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        """, (sid, fullName, admissionNumber, data.get('studentClass'), data.get('gender'),
              data.get('date_of_birth'), _truncate(data.get('parentName'), _MAX_NAME_LEN),
              _truncate(data.get('parentPhone'), _MAX_PHONE_LEN),
              _truncate(data.get('address'), _MAX_ADDR_LEN),
              data.get('status', 'active'), data.get('admissionDate'), now))
        conn.commit(); conn.close()
        return jsonify({'message': 'Student created successfully', 'id': sid}), 201
    except Exception:
        traceback.print_exc(); return jsonify({'message': 'Server error'}), 500


@app.route('/api/students/sync', methods=['POST'])
@require_auth(roles=['admin'])
def sync_students():
    try:
        conn = get_db_connection(); cursor = conn.cursor()
        cursor.execute("SELECT COUNT(*) as cnt FROM students")
        count = cursor.fetchone()['cnt']; conn.close()
        return jsonify({'message': f'{count} students in database', 'count': count})
    except Exception:
        traceback.print_exc(); return jsonify({'message': 'Server error'}), 500


@app.route('/api/students/<student_id>', methods=['PUT'])
@require_auth(roles=['admin'])
def update_student(student_id):
    try:
        data = request.get_json(); conn = get_db_connection(); cursor = conn.cursor()
        cursor.execute("SELECT id FROM students WHERE id = ?", (student_id,))
        if not cursor.fetchone():
            conn.close(); return jsonify({'message': 'Student not found'}), 404
        cursor.execute("""
            UPDATE students SET fullName=?,gender=?,date_of_birth=?,address=?,
              studentClass=?,admissionNumber=?,parentName=?,parentPhone=?,admissionDate=?,status=?
            WHERE id=?
        """, (_truncate(data.get('fullName'), _MAX_NAME_LEN), data.get('gender'),
              data.get('date_of_birth'), _truncate(data.get('address'), _MAX_ADDR_LEN),
              data.get('studentClass'), _truncate(data.get('admissionNumber'), 30),
              _truncate(data.get('parentName'), _MAX_NAME_LEN),
              _truncate(data.get('parentPhone'), _MAX_PHONE_LEN),
              data.get('admissionDate'), data.get('status', 'active'), student_id))
        conn.commit(); conn.close()
        return jsonify({'message': 'Student updated successfully'})
    except Exception:
        traceback.print_exc(); return jsonify({'message': 'Server error'}), 500


@app.route('/api/students/<student_id>', methods=['DELETE'])
@require_auth(roles=['admin'])
def delete_student(student_id):
    try:
        conn = get_db_connection(); cursor = conn.cursor()
        cursor.execute("DELETE FROM students WHERE id = ?", (student_id,))
        if cursor.rowcount == 0:
            conn.close(); return jsonify({'message': 'Student not found'}), 404
        conn.commit(); conn.close()
        return jsonify({'message': 'Student deleted successfully'})
    except Exception:
        traceback.print_exc(); return jsonify({'message': 'Server error'}), 500


# ───────────────────────────────────────────────
# Roles & Permissions
# ───────────────────────────────────────────────

@app.route('/api/roles', methods=['GET'])
@require_auth(roles=['admin'])
def get_roles():
    try:
        conn = get_db_connection(); cursor = conn.cursor()
        cursor.execute("SELECT * FROM roles ORDER BY name")
        roles = []
        for row in cursor.fetchall():
            r = dict(row); r['permissions'] = json.loads(r['permissions']) if r['permissions'] else {}
            roles.append(r)
        conn.close(); return jsonify(roles)
    except Exception:
        traceback.print_exc(); return jsonify({'message': 'Server error'}), 500


@app.route('/api/roles/<int:role_id>', methods=['GET'])
@require_auth(roles=['admin'])
def get_role(role_id):
    try:
        conn = get_db_connection(); cursor = conn.cursor()
        cursor.execute("SELECT * FROM roles WHERE id = ?", (role_id,))
        role = cursor.fetchone(); conn.close()
        if not role: return jsonify({'message': 'Role not found'}), 404
        r = dict(role); r['permissions'] = json.loads(r['permissions']) if r['permissions'] else {}
        return jsonify(r)
    except Exception:
        traceback.print_exc(); return jsonify({'message': 'Server error'}), 500


@app.route('/api/roles', methods=['POST'])
@require_auth(roles=['admin'])
def create_role():
    try:
        data = request.get_json()
        name = _truncate(data.get('name', ''), 60).strip()
        desc = _truncate(data.get('description', ''), 300).strip()
        if not name: return jsonify({'message': 'Role name is required'}), 400
        conn = get_db_connection(); cursor = conn.cursor()
        cursor.execute("SELECT id FROM roles WHERE name = ?", (name,))
        if cursor.fetchone():
            conn.close(); return jsonify({'message': 'Role already exists'}), 409
        empty_perms = {str(m): {str(p): False for p in range(1, 6)} for m in range(1, 11)}
        cursor.execute("INSERT INTO roles (name,description,is_system_role,permissions,users_count,created_at) VALUES (?,?,0,?,0,?)",
                       (name, desc, json.dumps(empty_perms), datetime.now().isoformat()))
        role_id = cursor.lastrowid; conn.commit(); conn.close()
        return jsonify({'message': 'Role created successfully', 'id': role_id}), 201
    except Exception:
        traceback.print_exc(); return jsonify({'message': 'Server error'}), 500


@app.route('/api/roles/<int:role_id>', methods=['PUT'])
@require_auth(roles=['admin'])
def update_role(role_id):
    try:
        data = request.get_json(); conn = get_db_connection(); cursor = conn.cursor()
        cursor.execute("SELECT * FROM roles WHERE id = ?", (role_id,))
        role = cursor.fetchone()
        if not role: conn.close(); return jsonify({'message': 'Role not found'}), 404
        if 'permissions' in data:
            cursor.execute("UPDATE roles SET permissions=? WHERE id=?", (json.dumps(data['permissions']), role_id))
        if 'name' in data or 'description' in data:
            cursor.execute("UPDATE roles SET name=?,description=? WHERE id=?",
                           (data.get('name', dict(role)['name']), data.get('description', dict(role)['description']), role_id))
        conn.commit(); conn.close()
        return jsonify({'message': 'Role updated successfully'})
    except Exception:
        traceback.print_exc(); return jsonify({'message': 'Server error'}), 500


@app.route('/api/roles/<int:role_id>', methods=['DELETE'])
@require_auth(roles=['admin'])
def delete_role(role_id):
    try:
        conn = get_db_connection(); cursor = conn.cursor()
        cursor.execute("SELECT is_system_role FROM roles WHERE id = ?", (role_id,))
        role = cursor.fetchone()
        if not role: conn.close(); return jsonify({'message': 'Role not found'}), 404
        if role['is_system_role']: conn.close(); return jsonify({'message': 'Cannot delete system roles'}), 403
        cursor.execute("DELETE FROM roles WHERE id=?", (role_id,)); conn.commit(); conn.close()
        return jsonify({'message': 'Role deleted successfully'})
    except Exception:
        traceback.print_exc(); return jsonify({'message': 'Server error'}), 500


# ───────────────────────────────────────────────
# Fees & Payments
# ───────────────────────────────────────────────

@app.route('/api/fees', methods=['GET'])
@require_auth(roles=['admin', 'accountant', 'parent'])
def get_fees():
    try:
        student_id = request.args.get('student_id', '').strip()
        if not student_id: return jsonify({'message': 'student_id required'}), 400
        conn = get_db_connection(); cursor = conn.cursor()
        cursor.execute("SELECT * FROM fee_structure WHERE student_id=? ORDER BY year DESC, created_at DESC LIMIT 1", (student_id,))
        structure = cursor.fetchone()
        total_fee = dict(structure)['total_fee'] if structure else 0
        term      = dict(structure)['term']      if structure else None
        cursor.execute("SELECT * FROM fee_payments WHERE student_id=? ORDER BY created_at DESC", (student_id,))
        payments = [dict(r) for r in cursor.fetchall()]; conn.close()
        result = []
        for p in payments:
            p['total'] = total_fee; p['term'] = p.get('term') or term or '—'
            p['date'] = p.get('created_at', ''); p['ref'] = p.get('reference', '')
            result.append(p)
        if not result and total_fee:
            result = [{'id': None, 'student_id': student_id, 'total': total_fee, 'amount': 0,
                       'term': term or '—', 'method': None, 'ref': None, 'status': None, 'date': None}]
        return jsonify(result)
    except Exception:
        traceback.print_exc(); return jsonify({'message': 'Server error'}), 500


@app.route('/api/fees/structure', methods=['POST'])
@require_auth(roles=['admin', 'accountant'])
def set_fee_structure():
    try:
        data = request.get_json()
        student_id = data.get('student_id', '').strip()
        term       = _truncate(data.get('term', 'Term 1'), 20).strip()
        year       = int(data.get('year', datetime.now().year))
        total_fee  = float(data.get('total_fee', 0))
        if not student_id: return jsonify({'message': 'student_id required'}), 400
        if total_fee < 0:  return jsonify({'message': 'total_fee cannot be negative'}), 400
        conn = get_db_connection(); cursor = conn.cursor()
        cursor.execute("""
            INSERT INTO fee_structure (id,student_id,term,year,total_fee,created_at)
            VALUES (?,?,?,?,?,?)
            ON CONFLICT(student_id,term,year) DO UPDATE SET total_fee=excluded.total_fee
        """, (str(uuid.uuid4()), student_id, term, year, total_fee, datetime.now().isoformat()))
        conn.commit(); conn.close()
        return jsonify({'message': 'Fee structure updated'})
    except Exception:
        traceback.print_exc(); return jsonify({'message': 'Server error'}), 500


@app.route('/api/fees/pay', methods=['POST'])
@require_auth(roles=['admin', 'accountant'])
def make_payment():
    try:
        data = request.get_json()
        student_id = data.get('student_id', '').strip()
        amount = float(data.get('amount', 0))
        method = _truncate(data.get('method', 'Cash'), 30).strip()
        term   = _truncate(data.get('term', ''), 20).strip()
        notes  = _truncate(data.get('notes', ''), 300).strip()
        year   = int(data.get('year', datetime.now().year))
        if not student_id: return jsonify({'message': 'student_id required'}), 400
        if amount <= 0:    return jsonify({'message': 'Amount must be greater than 0'}), 400
        conn = get_db_connection(); cursor = conn.cursor()
        cursor.execute("SELECT total_fee FROM fee_structure WHERE student_id=? ORDER BY year DESC LIMIT 1", (student_id,))
        row = cursor.fetchone(); total_fee = row['total_fee'] if row else 0
        cursor.execute("SELECT COALESCE(SUM(amount),0) as paid FROM fee_payments WHERE student_id=?", (student_id,))
        paid = cursor.fetchone()['paid']; balance = total_fee - paid
        if total_fee > 0 and amount > balance:
            conn.close(); return jsonify({'message': f'Amount KSh {amount:,.0f} exceeds balance of KSh {balance:,.0f}'}), 400
        reference = 'PAY-' + str(uuid.uuid4())[:8].upper()
        cursor.execute("""
            INSERT INTO fee_payments (id,student_id,term,year,amount,method,reference,status,notes,created_at)
            VALUES (?,?,?,?,?,?,?,'completed',?,?)
        """, (str(uuid.uuid4()), student_id, term or None, year, amount, method,
              reference, notes or None, datetime.now().isoformat()))
        conn.commit(); conn.close()
        return jsonify({'message': 'Payment recorded successfully', 'reference': reference,
                        'amount': amount, 'balance': max(0, balance - amount)}), 201
    except Exception:
        traceback.print_exc(); return jsonify({'message': 'Server error'}), 500


@app.route('/api/fees/all', methods=['GET'])
@require_auth(roles=['admin', 'accountant'])
def get_all_fees():
    try:
        conn = get_db_connection(); cursor = conn.cursor()
        cursor.execute("SELECT id,fullName,admissionNumber,studentClass,status FROM students ORDER BY fullName ASC")
        students = [dict(r) for r in cursor.fetchall()]; result = []
        for s in students:
            sid = s['id']
            cursor.execute("SELECT total_fee,term,year FROM fee_structure WHERE student_id=? ORDER BY year DESC, created_at DESC LIMIT 1", (sid,))
            fs = cursor.fetchone(); total_fee = fs['total_fee'] if fs else 0; term = fs['term'] if fs else None
            cursor.execute("SELECT COALESCE(SUM(amount),0) as paid FROM fee_payments WHERE student_id=?", (sid,))
            paid = cursor.fetchone()['paid']; balance = max(0, total_fee - paid)
            status = ('No Structure' if total_fee == 0 else 'Paid' if balance == 0 else 'Pending' if paid == 0 else 'Partial')
            result.append({'id': sid, 'fullName': s['fullName'], 'admissionNumber': s['admissionNumber'],
                           'studentClass': s['studentClass'] or '—', 'totalFee': total_fee,
                           'paid': paid, 'balance': balance, 'term': term or '—', 'status': status})
        conn.close()
        return jsonify({'students': result,
                        'totalCollected': sum(r['paid'] for r in result),
                        'totalArrears':   sum(r['balance'] for r in result),
                        'fullyPaid':      sum(1 for r in result if r['status'] == 'Paid'),
                        'totalStudents':  len(result)})
    except Exception:
        traceback.print_exc(); return jsonify({'message': 'Server error'}), 500


@app.route('/api/fees/payments/all', methods=['GET'])
@require_auth(roles=['admin', 'accountant'])
def get_all_payments():
    try:
        term_filter = request.args.get('term', '').strip()
        conn = get_db_connection(); cursor = conn.cursor()
        cursor.execute("""
            SELECT fp.id,fp.student_id,fp.amount,fp.method,fp.reference,
                   fp.term,fp.year,fp.status,fp.notes,fp.created_at,
                   s.fullName,s.admissionNumber,s.studentClass
            FROM fee_payments fp LEFT JOIN students s ON s.id=fp.student_id
            ORDER BY fp.created_at DESC
        """)
        rows = [dict(r) for r in cursor.fetchall()]; conn.close()
        if term_filter: rows = [r for r in rows if (r['term'] or '') == term_filter]
        return jsonify(rows)
    except Exception:
        traceback.print_exc(); return jsonify({'message': 'Server error'}), 500


@app.route('/api/fees/payment/<payment_id>', methods=['DELETE'])
@require_auth(roles=['admin', 'accountant'])
def delete_payment(payment_id):
    try:
        conn = get_db_connection(); cursor = conn.cursor()
        cursor.execute("DELETE FROM fee_payments WHERE id=?", (payment_id,))
        if cursor.rowcount == 0:
            conn.close(); return jsonify({'message': 'Payment not found'}), 404
        conn.commit(); conn.close(); return jsonify({'message': 'Payment deleted'})
    except Exception:
        traceback.print_exc(); return jsonify({'message': 'Server error'}), 500


@app.route('/api/fees/structure/all', methods=['GET'])
@require_auth(roles=['admin', 'accountant'])
def get_all_fee_structures():
    try:
        conn = get_db_connection(); cursor = conn.cursor()
        cursor.execute("SELECT fs.*,s.fullName,s.admissionNumber,s.studentClass "
                       "FROM fee_structure fs LEFT JOIN students s ON s.id=fs.student_id "
                       "ORDER BY fs.year DESC, s.fullName ASC")
        rows = [dict(r) for r in cursor.fetchall()]; conn.close(); return jsonify(rows)
    except Exception:
        traceback.print_exc(); return jsonify({'message': 'Server error'}), 500


# ───────────────────────────────────────────────
# Attendance
# ───────────────────────────────────────────────

@app.route('/api/attendance', methods=['GET'])
@require_auth(roles=['admin', 'teacher', 'parent'])
def get_attendance():
    try:
        conn = get_db_connection(); cursor = conn.cursor()
        student_id = request.args.get('student_id','').strip(); cls = request.args.get('class','').strip()
        date = request.args.get('date','').strip(); date_from = request.args.get('date_from','').strip()
        date_to = request.args.get('date_to','').strip(); status = request.args.get('status','').strip()
        query = "SELECT * FROM attendance WHERE 1=1"; params = []
        if student_id: query += " AND (student_id=? OR admission_no=?)"; params += [student_id, student_id]
        if cls:        query += " AND student_class=?";  params.append(cls)
        if date:       query += " AND date=?";           params.append(date)
        if date_from:  query += " AND date>=?";          params.append(date_from)
        if date_to:    query += " AND date<=?";          params.append(date_to)
        if status:     query += " AND status=?";         params.append(status)
        query += " ORDER BY date DESC, student_name ASC"
        cursor.execute(query, params); rows = [dict(r) for r in cursor.fetchall()]; conn.close()
        return jsonify(rows)
    except Exception:
        traceback.print_exc(); return jsonify({'message': 'Server error'}), 500


@app.route('/api/attendance', methods=['POST'])
@require_auth(roles=['admin', 'teacher'])
def save_attendance():
    try:
        data = request.get_json()
        if not data or not isinstance(data, list):
            return jsonify({'message': 'Expected a list of attendance entries'}), 400
        if len(data) > 500: return jsonify({'message': 'Maximum 500 entries per request'}), 400
        conn = get_db_connection(); cursor = conn.cursor(); saved, errors = 0, []
        for entry in data:
            try:
                student_id = entry.get('student_id','').strip()
                admission_no = entry.get('admissionNo', entry.get('admission_no','')).strip()
                if not student_id and admission_no:
                    cursor.execute("SELECT id FROM students WHERE admissionNumber=?", (admission_no,))
                    row = cursor.fetchone()
                    if row: student_id = row['id']
                if not student_id: errors.append(f"Cannot resolve student for admissionNo={admission_no}"); continue
                student_name  = _truncate(entry.get('studentName', entry.get('student_name','')), _MAX_NAME_LEN).strip()
                student_class = _truncate(entry.get('class', entry.get('student_class','')), 30).strip()
                if not student_name or not student_class:
                    cursor.execute("SELECT fullName,studentClass FROM students WHERE id=?", (student_id,))
                    s = cursor.fetchone()
                    if s: student_name = student_name or s['fullName']; student_class = student_class or s['studentClass']
                date = entry.get('date', datetime.now().strftime('%Y-%m-%d')).strip()
                raw_status = entry.get('status','Present').strip(); valid = {'Present','Absent','Late','Excused'}
                status = raw_status.capitalize() if raw_status.capitalize() in valid else 'Present'
                remarks = _truncate(entry.get('remarks',''), 300).strip()
                teacher_name = _truncate(entry.get('teacherName', entry.get('teacher_name','')), _MAX_NAME_LEN).strip()
                teacher_id = entry.get('teacher_id','').strip(); now = datetime.now().isoformat()
                cursor.execute("""
                    INSERT INTO attendance
                      (id,student_id,admission_no,student_name,student_class,date,status,remarks,teacher_name,teacher_id,created_at)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?)
                    ON CONFLICT(student_id,date) DO UPDATE SET
                      status=excluded.status,remarks=excluded.remarks,teacher_name=excluded.teacher_name,
                      teacher_id=excluded.teacher_id,student_class=excluded.student_class,created_at=excluded.created_at
                """, (str(uuid.uuid4()), student_id, admission_no, student_name, student_class,
                      date, status, remarks, teacher_name, teacher_id, now))
                saved += 1
            except Exception as row_err: errors.append(str(row_err))
        conn.commit(); conn.close(); return jsonify({'saved': saved, 'errors': errors}), 200
    except Exception:
        traceback.print_exc(); return jsonify({'message': 'Server error'}), 500


@app.route('/api/attendance/summary', methods=['GET'])
@require_auth(roles=['admin', 'teacher'])
def attendance_summary():
    try:
        conn = get_db_connection(); cursor = conn.cursor()
        date = request.args.get('date', datetime.now().strftime('%Y-%m-%d')).strip()
        cls  = request.args.get('class','').strip()
        query = "SELECT * FROM attendance WHERE date=?"; params = [date]
        if cls: query += " AND student_class=?"; params.append(cls)
        cursor.execute(query, params); rows = [dict(r) for r in cursor.fetchall()]
        by_class = {}
        for r in rows: by_class.setdefault(r['student_class'] or 'Unknown', []).append(r)
        summary = []
        for class_name, records in sorted(by_class.items()):
            total = len(records); present = sum(1 for r in records if r['status']=='Present')
            summary.append({'class':class_name,'date':date,'total':total,'present':present,
                            'absent':sum(1 for r in records if r['status']=='Absent'),
                            'late':sum(1 for r in records if r['status']=='Late'),
                            'excused':sum(1 for r in records if r['status']=='Excused'),
                            'attendance_rate':round(present/total*100,1) if total else 0})
        conn.close(); return jsonify(summary)
    except Exception:
        traceback.print_exc(); return jsonify({'message': 'Server error'}), 500


@app.route('/api/attendance/<record_id>', methods=['DELETE'])
@require_auth(roles=['admin', 'teacher'])
def delete_attendance(record_id):
    try:
        conn = get_db_connection(); cursor = conn.cursor()
        cursor.execute("DELETE FROM attendance WHERE id=?", (record_id,))
        conn.commit(); conn.close(); return jsonify({'message': 'Deleted'}), 200
    except Exception:
        traceback.print_exc(); return jsonify({'message': 'Server error'}), 500


# ───────────────────────────────────────────────
# Grades
# ───────────────────────────────────────────────

@app.route('/api/grades', methods=['GET'])
@require_auth(roles=['admin', 'teacher', 'parent'])
def get_grades():
    try:
        conn = get_db_connection(); cursor = conn.cursor()
        student_id = request.args.get('student_id','').strip(); class_filter = request.args.get('class','').strip()
        subject = request.args.get('subject','').strip(); term = request.args.get('term','').strip()
        exam_type = request.args.get('exam_type','').strip()
        query = "SELECT * FROM grades WHERE 1=1"; params = []
        if student_id:   query += " AND (student_id=? OR admission_no=?)"; params += [student_id, student_id]
        if class_filter: query += " AND student_class=?"; params.append(class_filter)
        if subject:      query += " AND subject=?";       params.append(subject)
        if term:         query += " AND term=?";          params.append(term)
        if exam_type:    query += " AND exam_type=?";     params.append(exam_type)
        query += " ORDER BY created_at DESC"
        cursor.execute(query, params); rows = [dict(r) for r in cursor.fetchall()]; conn.close()
        return jsonify(rows)
    except Exception:
        traceback.print_exc(); return jsonify({'message': 'Server error'}), 500


@app.route('/api/grades', methods=['POST'])
@require_auth(roles=['admin', 'teacher'])
def save_grades():
    try:
        data = request.get_json()
        if not data or not isinstance(data, list):
            return jsonify({'message': 'Expected a list of grade entries'}), 400
        if len(data) > 500: return jsonify({'message': 'Maximum 500 entries per request'}), 400
        conn = get_db_connection(); cursor = conn.cursor(); saved, errors = 0, []
        def sg(sc): return 'A' if sc>=80 else 'B' if sc>=60 else 'C' if sc>=40 else 'D' if sc>=30 else 'F'
        def sp(sc): return 'Excellent' if sc>=80 else 'Good' if sc>=60 else 'Average' if sc>=40 else 'Poor'
        for entry in data:
            try:
                student_id = entry.get('student_id','').strip()
                admission_no = entry.get('admissionNo', entry.get('admission_no','')).strip()
                if not student_id and admission_no:
                    cursor.execute("SELECT id FROM students WHERE admissionNumber=?", (admission_no,))
                    row = cursor.fetchone()
                    if row: student_id = row['id']
                if not student_id: errors.append(f"Could not resolve student for admissionNo={admission_no}"); continue
                student_name  = _truncate(entry.get('studentName', entry.get('student_name','')), _MAX_NAME_LEN).strip()
                student_class = _truncate(entry.get('class', entry.get('student_class','')), 30).strip()
                if not student_name or not student_class:
                    cursor.execute("SELECT fullName,studentClass FROM students WHERE id=?", (student_id,))
                    s = cursor.fetchone()
                    if s: student_name = student_name or s['fullName']; student_class = student_class or s['studentClass']
                score = max(0, min(100, int(entry.get('score',0))))
                term = _truncate(entry.get('term','Term 1'), 20).strip()
                subject = _truncate(entry.get('subject',''), 60).strip()
                exam_type = _truncate(entry.get('examType', entry.get('exam_type','End of Term')), 40).strip()
                teacher_name = _truncate(entry.get('teacherName', entry.get('teacher_name','')), _MAX_NAME_LEN).strip()
                teacher_id = entry.get('teacher_id','').strip()
                remarks = _truncate(entry.get('remarks',''), 300).strip()
                now = datetime.now().isoformat(); date_posted = entry.get('datePosted', entry.get('date_posted', now[:10]))
                cursor.execute("SELECT id FROM grades WHERE student_id=? AND subject=? AND term=? AND exam_type=?",
                               (student_id, subject, term, exam_type))
                existing = cursor.fetchone()
                if existing:
                    cursor.execute("""
                        UPDATE grades SET score=?,grade=?,performance=?,teacher_name=?,teacher_id=?,
                          remarks=?,date_posted=?,created_at=?,student_name=?,student_class=?,admission_no=? WHERE id=?
                    """, (score, sg(score), sp(score), teacher_name, teacher_id, remarks,
                          date_posted, now, student_name, student_class, admission_no, existing['id']))
                else:
                    cursor.execute("""
                        INSERT INTO grades
                          (id,student_id,admission_no,student_name,student_class,subject,score,grade,performance,
                           term,exam_type,teacher_name,teacher_id,remarks,date_posted,created_at)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                    """, (str(uuid.uuid4()), student_id, admission_no, student_name, student_class,
                          subject, score, sg(score), sp(score), term, exam_type,
                          teacher_name, teacher_id, remarks, date_posted, now))
                saved += 1
            except Exception as row_err: errors.append(str(row_err))
        conn.commit(); conn.close(); return jsonify({'saved': saved, 'errors': errors}), 200
    except Exception:
        traceback.print_exc(); return jsonify({'message': 'Server error'}), 500


@app.route('/api/grades/<grade_id>', methods=['DELETE'])
@require_auth(roles=['admin', 'teacher'])
def delete_grade(grade_id):
    try:
        conn = get_db_connection(); cursor = conn.cursor()
        cursor.execute("DELETE FROM grades WHERE id=?", (grade_id,))
        conn.commit(); conn.close(); return jsonify({'message': 'Deleted'}), 200
    except Exception:
        traceback.print_exc(); return jsonify({'message': 'Server error'}), 500


@app.route('/api/grades/summary', methods=['GET'])
@require_auth(roles=['admin', 'teacher'])
def grades_summary():
    try:
        conn = get_db_connection(); cursor = conn.cursor()
        term = request.args.get('term','').strip()
        query = "SELECT * FROM grades WHERE 1=1"; params = []
        if term: query += " AND term=?"; params.append(term)
        cursor.execute(query, params); rows = [dict(r) for r in cursor.fetchall()]; conn.close()
        by_class = {}
        for r in rows: by_class.setdefault(r['student_class'] or 'Unknown', []).append(r)
        summary = []
        for cls, entries in sorted(by_class.items()):
            scores = [e['score'] for e in entries]
            summary.append({'class':cls,'avg_score':round(sum(scores)/len(scores),1) if scores else 0,
                            'students':len(set(e['student_id'] for e in entries)),
                            'subjects':len(set(e['subject'] for e in entries)),
                            'excellent':sum(1 for e in entries if e['performance']=='Excellent'),
                            'poor':sum(1 for e in entries if e['performance']=='Poor'),
                            'total_entries':len(entries)})
        return jsonify(summary)
    except Exception:
        traceback.print_exc(); return jsonify({'message': 'Server error'}), 500


# ───────────────────────────────────────────────
# Announcements
# ───────────────────────────────────────────────

@app.route('/api/announcements', methods=['GET'])
@require_auth()
def get_announcements():
    try:
        conn = get_db_connection(); cursor = conn.cursor()
        cursor.execute("SELECT id,title,content,author,author_role,audience,priority,created_at,updated_at "
                       "FROM announcements ORDER BY created_at DESC")
        rows = [dict(r) for r in cursor.fetchall()]; conn.close(); return jsonify(rows)
    except Exception:
        traceback.print_exc(); return jsonify({'message': 'Server error'}), 500


@app.route('/api/announcements', methods=['POST'])
@require_auth(roles=['admin', 'teacher'])
def create_announcement():
    try:
        data = request.get_json()
        title   = _truncate(data.get('title') or '', 200).strip()
        content = _truncate(data.get('content') or '', 5000).strip()
        # FIX #4: author from session, not client-supplied field
        session  = request.current_user
        author   = session.get('user_id', 'Unknown')
        aut_role = session.get('role', 'admin').capitalize()
        if not title or not content:
            return jsonify({'message': 'Title and content are required'}), 400
        aid = str(uuid.uuid4()); now = datetime.now().isoformat()
        conn = get_db_connection(); cursor = conn.cursor()
        cursor.execute("INSERT INTO announcements (id,title,content,author,author_role,audience,priority,created_at) VALUES (?,?,?,?,?,?,?,?)",
                       (aid, title, content, author, aut_role, data.get('audience','all'), data.get('priority','normal'), now))
        conn.commit(); conn.close(); return jsonify({'message': 'Announcement posted', 'id': aid}), 201
    except Exception:
        traceback.print_exc(); return jsonify({'message': 'Server error'}), 500


@app.route('/api/announcements/<ann_id>', methods=['PUT'])
@require_auth(roles=['admin', 'teacher'])
def update_announcement(ann_id):
    try:
        data = request.get_json(); now = datetime.now().isoformat()
        conn = get_db_connection(); cursor = conn.cursor()
        cursor.execute("UPDATE announcements SET title=?,content=?,audience=?,priority=?,updated_at=? WHERE id=?",
                       (_truncate(data.get('title'), 200), _truncate(data.get('content'), 5000),
                        data.get('audience','all'), data.get('priority','normal'), now, ann_id))
        conn.commit(); conn.close(); return jsonify({'message': 'Announcement updated'})
    except Exception:
        traceback.print_exc(); return jsonify({'message': 'Server error'}), 500


@app.route('/api/announcements/<ann_id>', methods=['DELETE'])
@require_auth(roles=['admin'])
def delete_announcement(ann_id):
    try:
        conn = get_db_connection(); cursor = conn.cursor()
        cursor.execute("DELETE FROM announcements WHERE id=?", (ann_id,))
        conn.commit(); conn.close(); return jsonify({'message': 'Announcement deleted'})
    except Exception:
        traceback.print_exc(); return jsonify({'message': 'Server error'}), 500


# ───────────────────────────────────────────────
# Backup & Restore
# ───────────────────────────────────────────────

@app.route('/api/backup', methods=['GET'])
@require_auth(roles=['admin'])   # FIX #1 + strip passwords from output
def backup_system():
    try:
        conn = get_db_connection(); cursor = conn.cursor(); all_users = []
        for role, tbl in ROLE_TABLE.items():
            cursor.execute(f"SELECT * FROM {tbl}")
            for row in cursor.fetchall():
                u = dict(row); u['role'] = role.lower()
                u.pop('password', None)   # FIX: never export password hashes
                all_users.append(u)
        cursor.execute("SELECT * FROM roles"); roles = []
        for row in cursor.fetchall():
            r = dict(row); r['permissions'] = json.loads(r['permissions']) if r['permissions'] else {}; roles.append(r)
        cursor.execute("SELECT * FROM students"); students = [dict(r) for r in cursor.fetchall()]; conn.close()
        return jsonify({'backup': {'timestamp': datetime.now().isoformat(), 'version': '2.0',
                                   'users': all_users, 'roles': roles, 'students': students}})
    except Exception:
        traceback.print_exc(); return jsonify({'message': 'Backup failed'}), 500


@app.route('/api/restore', methods=['POST'])
@require_auth(roles=['admin'])   # FIX #1: was open — anyone could overwrite the entire DB
def restore_system():
    try:
        data = request.get_json(); backup = data.get('backup')
        if not backup: return jsonify({'message': 'Invalid backup file'}), 400
        if not isinstance(backup.get('users'), list) or not isinstance(backup.get('students'), list):
            return jsonify({'message': 'Backup format invalid'}), 400
        conn = get_db_connection(); cursor = conn.cursor()
        for rd in (backup.get('roles') or []):
            cursor.execute("INSERT OR REPLACE INTO roles (id,name,description,is_system_role,permissions,users_count,created_at) VALUES (?,?,?,?,?,?,?)",
                           (rd['id'], rd['name'], rd.get('description',''), rd.get('is_system_role',0),
                            json.dumps(rd.get('permissions',{})), rd.get('users_count',0),
                            rd.get('created_at', datetime.now().isoformat())))
        for user in (backup.get('users') or []):
            role = (user.get('role') or 'admin').lower()
            if role not in ALLOWED_ROLES: continue   # FIX: skip invalid roles
            tbl = table_for_role(role); uid = user.get('id') or str(uuid.uuid4())
            now = user.get('createdAt') or user.get('created_at') or datetime.now().isoformat()
            pwd = user.get('password', '')
            if not pwd: pwd = bcrypt.hashpw(secrets.token_hex(16).encode(), bcrypt.gensalt()).decode()
            elif not pwd.startswith('$2b$'): pwd = bcrypt.hashpw(pwd.encode(), bcrypt.gensalt()).decode()
            if tbl == 'parents':
                cursor.execute("INSERT OR REPLACE INTO parents (id,fullName,email,password,phone,date_of_birth,gender,address,children,status,last_login,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                               (uid, user['fullName'], user['email'], pwd, user.get('phone'), user.get('date_of_birth'),
                                user.get('gender'), user.get('address'), user.get('children','[]'),
                                user.get('status','active'), user.get('last_login'), now))
            elif tbl == 'teachers':
                cursor.execute("INSERT OR REPLACE INTO teachers (id,fullName,email,password,phone,date_of_birth,gender,address,subject,status,last_login,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                               (uid, user['fullName'], user['email'], pwd, user.get('phone'), user.get('date_of_birth'),
                                user.get('gender'), user.get('address'), user.get('subject'),
                                user.get('status','active'), user.get('last_login'), now))
            else:
                cursor.execute(f"INSERT OR REPLACE INTO {tbl} (id,fullName,email,password,phone,date_of_birth,gender,address,status,last_login,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                               (uid, user['fullName'], user['email'], pwd, user.get('phone'), user.get('date_of_birth'),
                                user.get('gender'), user.get('address'), user.get('status','active'),
                                user.get('last_login'), now))
        for s in (backup.get('students') or []):
            cursor.execute("INSERT OR REPLACE INTO students (id,fullName,admissionNumber,studentClass,gender,date_of_birth,parentName,parentPhone,address,status,admissionDate,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                           (s['id'], s['fullName'], s['admissionNumber'], s.get('studentClass'), s.get('gender'),
                            s.get('date_of_birth'), s.get('parentName'), s.get('parentPhone'), s.get('address'),
                            s.get('status','active'), s.get('admissionDate'), s.get('createdAt', datetime.now().isoformat())))
        conn.commit(); conn.close(); return jsonify({'message': 'Restore completed successfully'})
    except Exception:
        traceback.print_exc(); return jsonify({'message': 'Restore failed'}), 500


# ───────────────────────────────────────────────
# Teacher Assignments
# ───────────────────────────────────────────────

@app.route('/api/teacher-assignments/summary', methods=['GET'])
@require_auth(roles=['admin'])
def get_teacher_assignments_summary():
    try:
        conn = get_db_connection(); cursor = conn.cursor()
        cursor.execute("SELECT id,fullName,email,phone,status FROM teachers ORDER BY fullName ASC")
        teachers = [dict(r) for r in cursor.fetchall()]; result = []
        for t in teachers:
            cursor.execute("SELECT * FROM teacher_assignments WHERE teacher_id=? ORDER BY assigned_at DESC", (t['id'],))
            result.append({**t, 'assignments': [dict(r) for r in cursor.fetchall()]})
        conn.close(); return jsonify(result)
    except Exception:
        traceback.print_exc(); return jsonify({'message': 'Server error'}), 500


@app.route('/api/teacher-assignments', methods=['POST'])
@require_auth(roles=['admin'])
def create_teacher_assignment():
    try:
        data = request.get_json()
        teacher_id  = (data.get('teacher_id') or '').strip()
        class_name  = _truncate(data.get('class_name') or '', 50).strip()
        subject     = _truncate(data.get('subject') or '', 60).strip()
        assigned_by = _truncate(data.get('assigned_by', 'Admin'), _MAX_NAME_LEN)
        if not teacher_id or not class_name or not subject:
            return jsonify({'message': 'teacher_id, class_name and subject are required'}), 400
        conn = get_db_connection(); cursor = conn.cursor()
        cursor.execute("SELECT fullName FROM teachers WHERE id=?", (teacher_id,))
        row = cursor.fetchone()
        if not row: conn.close(); return jsonify({'message': 'Teacher not found'}), 404
        aid = str(uuid.uuid4()); now = datetime.now().isoformat()
        cursor.execute("INSERT INTO teacher_assignments (id,teacher_id,class_name,subject,assigned_by,assigned_at) VALUES (?,?,?,?,?,?)",
                       (aid, teacher_id, class_name, subject, assigned_by, now))
        conn.commit(); conn.close()
        return jsonify({'message': 'Assignment created', 'id': aid, 'teacher_name': row['fullName']}), 201
    except Exception:
        traceback.print_exc(); return jsonify({'message': 'Server error'}), 500


@app.route('/api/teacher-assignments/<assignment_id>', methods=['DELETE'])
@require_auth(roles=['admin'])
def delete_teacher_assignment(assignment_id):
    try:
        conn = get_db_connection(); cursor = conn.cursor()
        cursor.execute("DELETE FROM teacher_assignments WHERE id=?", (assignment_id,))
        if cursor.rowcount == 0: conn.close(); return jsonify({'message': 'Assignment not found'}), 404
        conn.commit(); conn.close(); return jsonify({'message': 'Assignment removed'})
    except Exception:
        traceback.print_exc(); return jsonify({'message': 'Server error'}), 500


@app.route('/api/class-teacher-assignments', methods=['GET'])
@require_auth(roles=['admin', 'teacher'])
def get_class_teachers():
    try:
        with db_conn() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT cta.id,cta.class_name,cta.assigned_by,cta.assigned_at,
                       t.id as teacher_id,t.fullName as teacher_name,t.email as teacher_email,t.phone as teacher_phone
                FROM class_teacher_assignments cta JOIN teachers t ON t.id=cta.teacher_id
                ORDER BY cta.class_name ASC
            """)
            rows = [dict(r) for r in cursor.fetchall()]
        return jsonify(rows)
    except Exception:
        traceback.print_exc(); return jsonify({'message': 'Server error'}), 500


@app.route('/api/class-teacher-assignments', methods=['POST'])
@require_auth(roles=['admin'])
def assign_class_teacher():
    try:
        data = request.get_json()
        teacher_id  = (data.get('teacher_id') or '').strip()
        class_name  = _truncate(data.get('class_name') or '', 50).strip()
        assigned_by = _truncate(data.get('assigned_by', 'Admin'), _MAX_NAME_LEN)
        if not teacher_id or not class_name:
            return jsonify({'message': 'teacher_id and class_name are required'}), 400
        with db_conn() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT fullName FROM teachers WHERE id=?", (teacher_id,))
            row = cursor.fetchone()
            if not row: return jsonify({'message': 'Teacher not found'}), 404
            aid = str(uuid.uuid4()); now = datetime.now().isoformat()
            cursor.execute("""
                INSERT INTO class_teacher_assignments (id,teacher_id,class_name,assigned_by,assigned_at)
                VALUES (?,?,?,?,?)
                ON CONFLICT(class_name) DO UPDATE SET id=excluded.id,teacher_id=excluded.teacher_id,
                    assigned_by=excluded.assigned_by,assigned_at=excluded.assigned_at
            """, (aid, teacher_id, class_name, assigned_by, now))
        return jsonify({'message': f'{row["fullName"]} set as class teacher for {class_name}',
                        'id': aid, 'teacher_name': row['fullName'], 'class_name': class_name}), 201
    except Exception:
        traceback.print_exc(); return jsonify({'message': 'Server error'}), 500


@app.route('/api/class-teacher-assignments/<class_name>', methods=['DELETE'])
@require_auth(roles=['admin'])
def remove_class_teacher(class_name):
    try:
        with db_conn() as conn:
            cursor = conn.cursor()
            cursor.execute("DELETE FROM class_teacher_assignments WHERE class_name=?", (class_name,))
            if cursor.rowcount == 0: return jsonify({'message': 'No class teacher assigned to this class'}), 404
        return jsonify({'message': f'Class teacher removed from {class_name}'})
    except Exception:
        traceback.print_exc(); return jsonify({'message': 'Server error'}), 500


# ───────────────────────────────────────────────
# Dashboard & Misc
# ───────────────────────────────────────────────

@app.route('/api/dashboard', methods=['GET'])
@require_auth(roles=['admin', 'accountant'])   # FIX #1: exposes all financial data
def dashboard():
    try:
        conn = get_db_connection(); cursor = conn.cursor()
        cursor.execute("SELECT COUNT(*) as total FROM students"); total_students = cursor.fetchone()['total']
        cursor.execute("SELECT COUNT(*) as active FROM students WHERE LOWER(status)='active'"); active_students = cursor.fetchone()['active']
        cursor.execute("SELECT studentClass,COUNT(*) as cnt FROM students GROUP BY studentClass ORDER BY studentClass ASC")
        by_grade = [{'grade': r['studentClass'] or 'Unknown', 'count': r['cnt']} for r in cursor.fetchall()]
        cursor.execute("SELECT COUNT(*) as cnt FROM teachers"); total_teachers = cursor.fetchone()['cnt']
        cursor.execute("SELECT COUNT(*) as cnt FROM parents");  total_parents  = cursor.fetchone()['cnt']
        cursor.execute("SELECT COALESCE(SUM(total_fee),0) as billed FROM fee_structure"); total_billed    = cursor.fetchone()['billed']
        cursor.execute("SELECT COALESCE(SUM(amount),0) as collected FROM fee_payments");  total_collected = cursor.fetchone()['collected']
        total_arrears = max(0, total_billed - total_collected)
        cursor.execute("SELECT COUNT(DISTINCT student_id) as cnt FROM fee_payments"); students_paid = cursor.fetchone()['cnt']
        cursor.execute("SELECT COUNT(DISTINCT fs.student_id) as cnt FROM fee_structure fs LEFT JOIN fee_payments fp ON fp.student_id=fs.student_id WHERE fp.id IS NULL")
        students_no_payment = cursor.fetchone()['cnt']
        cursor.execute("SELECT fp.id,fp.amount,fp.method,fp.term,fp.year,fp.status,fp.created_at,s.fullName,s.studentClass,s.admissionNumber FROM fee_payments fp LEFT JOIN students s ON s.id=fp.student_id ORDER BY fp.created_at DESC LIMIT 10")
        recent_payments = [dict(r) for r in cursor.fetchall()]
        cursor.execute("SELECT id,fullName,studentClass,admissionNumber,createdAt FROM students ORDER BY createdAt DESC LIMIT 5")
        recent_students = [dict(r) for r in cursor.fetchall()]
        cursor.execute("SELECT COUNT(*) as cnt FROM announcements"); ann_count = cursor.fetchone()['cnt']; conn.close()
        collection_rate = round(total_collected / total_billed * 100, 1) if total_billed > 0 else 0
        return jsonify({'students':{'total':total_students,'active':active_students,'by_grade':by_grade},
                        'staff':{'teachers':total_teachers,'parents':total_parents},
                        'fees':{'total_billed':total_billed,'total_collected':total_collected,'total_arrears':total_arrears,
                                'students_paid':students_paid,'students_no_payment':students_no_payment,'collection_rate':collection_rate},
                        'recent_payments':recent_payments,'recent_students':recent_students,'announcements':ann_count})
    except Exception:
        traceback.print_exc(); return jsonify({'message': 'Server error'}), 500


@app.route('/api/classes', methods=['GET'])
@require_auth()
def get_classes():
    try:
        conn = get_db_connection(); cursor = conn.cursor()
        cursor.execute("SELECT DISTINCT studentClass FROM students WHERE studentClass IS NOT NULL AND studentClass != '' ORDER BY studentClass ASC")
        classes = [row['studentClass'] for row in cursor.fetchall()]; conn.close(); return jsonify(classes)
    except Exception:
        traceback.print_exc(); return jsonify({'message': 'Server error'}), 500


@app.route('/health', methods=['GET'])
def health():
    return jsonify({'status': 'OK', 'timestamp': datetime.now().isoformat()})


@app.errorhandler(404)
def not_found(e):
    return jsonify({"error": "Not Found", "message": "Use /api/* endpoints or / for the login page."}), 404


if __name__ == '__main__':
    debug_mode = os.environ.get("FLASK_DEBUG", "false").lower() == "true"
    app.run(debug=debug_mode, host='0.0.0.0', port=5000)
