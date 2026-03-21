from flask import Flask, request, jsonify, render_template
from flask_cors import CORS
import bcrypt
import uuid
import os
import json
from datetime import datetime
import traceback

# ───────────────────────────────────────────────
# Create Flask app
# ───────────────────────────────────────────────
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
app = Flask(__name__,
            template_folder=os.path.join(BASE_DIR, 'templates'),
            static_folder=os.path.join(BASE_DIR, 'static'),
            static_url_path='/static')
CORS(app, origins=["http://localhost:5500", "http://127.0.0.1:5500", "*"])

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
            try: _turso_batch(self._q)
            except: pass
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

# School email domain configuration
SCHOOL_EMAIL_DOMAINS = ['emalashira.sc.ke', 'emalashira.ac.ke', 'emalashira.school.ke']

def validate_school_email(email):
    """Validate that email uses a school domain"""
    if not email or '@' not in email:
        return False
    domain = email.split('@')[1].lower()
    # Check if domain exactly matches or is a subdomain of school domains
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
    """Returns a Turso connection."""
    return TursoConn()


from contextlib import contextmanager

@contextmanager
def db_conn():
    """Context manager — always closes the connection, rolls back on unhandled error."""
    conn = get_db_connection()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

# ───────────────────────────────────────────────
# Role → Table mapping
# ───────────────────────────────────────────────
ROLE_TABLE = {
    'admin':      'admins',
    'teacher':    'teachers',
    'parent':     'parents',
    'accountant': 'accountants',
}

def table_for_role(role: str) -> str:
    return ROLE_TABLE.get((role or '').lower(), 'pending_users')

def _find_user_by_email(cursor, email: str):
    """Search all role tables + pending_users. Returns (row_dict, role_str) or (None, None)."""
    for role, tbl in ROLE_TABLE.items():
        cursor.execute(f"SELECT * FROM {tbl} WHERE email = ?", (email,))
        row = cursor.fetchone()
        if row:
            d = dict(row); d['role'] = role.lower()
            return d, role
    # Also search pending_users (self-registered users with no role yet)
    cursor.execute("SELECT * FROM pending_users WHERE email = ?", (email,))
    row = cursor.fetchone()
    if row:
        d = dict(row); d['role'] = 'pending'
        return d, 'pending'
    return None, None

def _find_user_by_id(cursor, user_id: str):
    """Search all role tables + pending_users. Returns (row_dict, role_str) or (None, None)."""
    for role, tbl in ROLE_TABLE.items():
        cursor.execute(f"SELECT * FROM {tbl} WHERE id = ?", (user_id,))
        row = cursor.fetchone()
        if row:
            d = dict(row); d['role'] = role.lower()
            return d, role
    # Also search pending_users
    cursor.execute("SELECT * FROM pending_users WHERE id = ?", (user_id,))
    row = cursor.fetchone()
    if row:
        d = dict(row); d['role'] = 'pending'
        return d, 'pending'
    return None, None

# ───────────────────────────────────────────────
# Database Init
# ───────────────────────────────────────────────
def init_db():
    # WAL mode is set HERE (once at startup) — not on every request connection.
    # The -shm and -wal files are normal WAL artefacts; they merge back into
    # system.db automatically on a clean shutdown.  If they are left over from
    # a previous crash they are safe to delete while the server is stopped.
    conn   = TursoConn()
    cursor = conn.cursor()

    # ── admins ──
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS admins (
            id TEXT PRIMARY KEY,
            fullName TEXT NOT NULL,
            email TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            phone TEXT, date_of_birth TEXT, gender TEXT, address TEXT,
            status TEXT DEFAULT 'active', last_login TEXT, createdAt TEXT NOT NULL
        )
    """)

    # ── teachers ──
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS teachers (
            id TEXT PRIMARY KEY,
            fullName TEXT NOT NULL,
            email TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            phone TEXT, date_of_birth TEXT, gender TEXT, address TEXT,
            subject TEXT,
            status TEXT DEFAULT 'active', last_login TEXT, createdAt TEXT NOT NULL
        )
    """)

    # ── parents ──
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS parents (
            id TEXT PRIMARY KEY,
            fullName TEXT NOT NULL,
            email TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            phone TEXT, date_of_birth TEXT, gender TEXT, address TEXT,
            children TEXT DEFAULT '[]',
            status TEXT DEFAULT 'active', last_login TEXT, createdAt TEXT NOT NULL
        )
    """)

    # ── accountants ──
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS accountants (
            id TEXT PRIMARY KEY,
            fullName TEXT NOT NULL,
            email TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            phone TEXT, date_of_birth TEXT, gender TEXT, address TEXT,
            status TEXT DEFAULT 'active', last_login TEXT, createdAt TEXT NOT NULL
        )
    """)

    # ── students ──
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS students (
            id TEXT PRIMARY KEY,
            fullName TEXT NOT NULL,
            admissionNumber TEXT UNIQUE NOT NULL,
            studentClass TEXT, gender TEXT, date_of_birth TEXT,
            parentName TEXT, parentPhone TEXT, address TEXT,
            status TEXT DEFAULT 'active', admissionDate TEXT, createdAt TEXT NOT NULL
        )
    """)

    # ── fees ──
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS fee_structure (
            id TEXT PRIMARY KEY, student_id TEXT NOT NULL,
            term TEXT NOT NULL, year INTEGER NOT NULL,
            total_fee REAL DEFAULT 0, created_at TEXT NOT NULL,
            UNIQUE(student_id, term, year)
        )
    """)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS fee_payments (
            id TEXT PRIMARY KEY, student_id TEXT NOT NULL,
            term TEXT, year INTEGER, amount REAL NOT NULL,
            method TEXT DEFAULT 'Cash', reference TEXT,
            status TEXT DEFAULT 'completed', notes TEXT, created_at TEXT NOT NULL
        )
    """)

    # ── announcements ──
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS announcements (
            id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL,
            author TEXT NOT NULL, author_role TEXT NOT NULL,
            audience TEXT DEFAULT 'all', priority TEXT DEFAULT 'normal',
            created_at TEXT NOT NULL, updated_at TEXT
        )
    """)

    # ── grades ──
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS grades (
            id TEXT PRIMARY KEY, student_id TEXT NOT NULL,
            admission_no TEXT, student_name TEXT, student_class TEXT,
            subject TEXT NOT NULL, score INTEGER NOT NULL, grade TEXT NOT NULL,
            performance TEXT, term TEXT NOT NULL, exam_type TEXT DEFAULT 'End of Term',
            teacher_name TEXT, teacher_id TEXT, remarks TEXT DEFAULT '',
            date_posted TEXT NOT NULL, created_at TEXT NOT NULL
        )
    """)

    # ── attendance ──
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS attendance (
            id TEXT PRIMARY KEY, student_id TEXT NOT NULL,
            admission_no TEXT, student_name TEXT, student_class TEXT,
            date TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('Present','Absent','Late','Excused')),
            remarks TEXT DEFAULT '', teacher_name TEXT, teacher_id TEXT,
            created_at TEXT NOT NULL, UNIQUE(student_id, date)
        )
    """)

    # ── roles ──
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS roles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL, description TEXT,
            is_system_role INTEGER DEFAULT 0,
            permissions TEXT, users_count INTEGER DEFAULT 0, created_at TEXT NOT NULL
        )
    """)
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


    # ── teacher_assignments ──
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS teacher_assignments (
            id TEXT PRIMARY KEY,
            teacher_id TEXT NOT NULL,
            class_name TEXT NOT NULL,
            subject TEXT NOT NULL,
            assigned_by TEXT DEFAULT 'Admin',
            assigned_at TEXT NOT NULL
        )
    """)

    # ── class_teacher_assignments (one class teacher per class, optional) ──
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS class_teacher_assignments (
            id          TEXT PRIMARY KEY,
            teacher_id  TEXT NOT NULL,
            class_name  TEXT NOT NULL UNIQUE,   -- only ONE class teacher per class
            assigned_by TEXT DEFAULT 'Admin',
            assigned_at TEXT NOT NULL,
            FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE CASCADE
        )
    """)

    # ── pending_users (self-registered via signup, awaiting admin role assignment) ──
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS pending_users (
            id TEXT PRIMARY KEY,
            fullName TEXT NOT NULL,
            email TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            phone TEXT, date_of_birth TEXT, gender TEXT, address TEXT,
            status TEXT DEFAULT 'pending', last_login TEXT, createdAt TEXT NOT NULL
        )
    """)

    conn.commit()
    conn.close()
    print("[DB] Initialised — per-role tables: admins, teachers, parents, accountants")


def _migrate_users_table(cursor):
    """Move existing rows from legacy users table into the correct role-specific table."""
    try:
        cursor.execute("SELECT * FROM users")
        rows = cursor.fetchall()
        if not rows:
            return
        count = 0
        for u in rows:
            u   = dict(u)
            role = (u.get('role') or 'admin').lower()
            uid  = u.get('id') or str(uuid.uuid4())
            now  = u.get('createdAt') or datetime.now().isoformat()
            pwd  = u.get('password', '')
            if role == 'student':
                continue   # already in students table
            tbl = table_for_role(role)
            if tbl == 'parents':
                cursor.execute("""
                    INSERT OR IGNORE INTO parents
                      (id,fullName,email,password,phone,date_of_birth,gender,address,children,status,last_login,createdAt)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
                """, (uid, u['fullName'], u['email'], pwd,
                      u.get('phone'), u.get('date_of_birth'), u.get('gender'),
                      u.get('address'), u.get('children','[]'),
                      u.get('status','active'), u.get('last_login'), now))
            elif tbl == 'teachers':
                cursor.execute("""
                    INSERT OR IGNORE INTO teachers
                      (id,fullName,email,password,phone,date_of_birth,gender,address,status,last_login,createdAt)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?)
                """, (uid, u['fullName'], u['email'], pwd,
                      u.get('phone'), u.get('date_of_birth'), u.get('gender'),
                      u.get('address'), u.get('status','active'), u.get('last_login'), now))
            else:
                cursor.execute(f"""
                    INSERT OR IGNORE INTO {tbl}
                      (id,fullName,email,password,phone,date_of_birth,gender,address,status,last_login,createdAt)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?)
                """, (uid, u['fullName'], u['email'], pwd,
                      u.get('phone'), u.get('date_of_birth'), u.get('gender'),
                      u.get('address'), u.get('status','active'), u.get('last_login'), now))
            count += 1
        print(f"[DB] Migrated {count} legacy users into role tables")
    except Exception as e:
        print(f"[DB] Migration note: {e}")


init_db()

# ───────────────────────────────────────────────
# Auth Routes
# ───────────────────────────────────────────────

@app.route('/')
def home():
    return render_template('index.html')

@app.route('/login.html')
@app.route('/login')
def login_page():
    return render_template('login.html')

@app.route('/dashboard.html')
@app.route('/dashboard')
def dashboard_page():
    return render_template('dashboard.html')

@app.route('/manage-users.html')
@app.route('/manage-users')
def manage_users_page():
    return render_template('manage-users.html')

@app.route('/roles-permissions.html')
@app.route('/roles-permissions')
def roles_permissions_page():
    return render_template('roles-permissions.html')

@app.route('/settings.html')
@app.route('/settings')
def settings_page():
    return render_template('settings.html')

@app.route('/backup-restore.html')
@app.route('/backup-restore')
def backup_restore_page():
    return render_template('backup-restore.html')

@app.route('/reports.html')
@app.route('/reports')
def reports_page():
    return render_template('reports.html')

@app.route('/students.html')
@app.route('/students-page')
def students_page():
    return render_template('students.html')

@app.route('/teacher-records.html')
@app.route('/teacher-records')
def teacher_records_page():
    return render_template('teacher-records.html')

@app.route('/finance.html')
@app.route('/finance')
def finance_page():
    return render_template('finance.html')

@app.route('/grades.html')
@app.route('/grades-page')
def grades_page():
    return render_template('grades.html')

@app.route('/attendance.html')
@app.route('/attendance-page')
def attendance_page():
    return render_template('attendance.html')

@app.route('/announcements.html')
@app.route('/announcements-page')
def announcements_page():
    return render_template('announcements.html')

@app.route('/profile.html')
@app.route('/profile')
def profile_page():
    return render_template('profile.html')

@app.route('/dashboard-overview.html')
@app.route('/dashboard-overview')
def dashboard_overview_page():
    return render_template('dashboard-overview.html')

@app.route('/teacher-dashboard.html')
@app.route('/teacher-dashboard')
def teacher_dashboard_page():
    return render_template('teacher-dashboard.html')

@app.route('/finance-dashboard.html')
@app.route('/finance-dashboard')
def finance_dashboard_page():
    return render_template('finance-dashboard.html')

@app.route('/parent-dashboard.html')
@app.route('/parent-dashboard')
def parent_dashboard_page():
    return render_template('parent-dashboard.html')

@app.route('/api/signup', methods=['POST'])
def signup():
    try:
        data     = request.get_json()
        fullName = data.get('fullName', '').strip()
        email    = data.get('email', '').strip().lower()
        password = data.get('password', '')
        
        if not all([fullName, email, password]):
            return jsonify({'message': 'All fields are required'}), 400
            
        # Validate school email domain
        if not validate_school_email(email):
            return jsonify({'message': f'Please use your school email address (@{SCHOOL_EMAIL_DOMAINS[0]})'}), 400
            
        if len(password) < 6:
            return jsonify({'message': 'Password must be at least 6 characters'}), 400

        conn   = get_db_connection()
        cursor = conn.cursor()
        existing, _ = _find_user_by_email(cursor, email)
        if existing:
            conn.close()
            return jsonify({'message': 'Email already exists'}), 409

        uid    = str(uuid.uuid4())
        hashed = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()
        now    = datetime.now().isoformat()
        # Self-registered users go into pending_users — no role, status pending
        # Admin must review and assign a role before they can access any dashboard
        cursor.execute("""
            INSERT INTO pending_users (id, fullName, email, password, status, createdAt)
            VALUES (?, ?, ?, ?, 'pending', ?)
        """, (uid, fullName, email, hashed, now))
        conn.commit(); conn.close()
        return jsonify({'message': 'Account created! Awaiting admin approval.',
                        'user': {'id': uid, 'fullName': fullName, 'email': email, 'role': 'Pending', 'status': 'pending'}}), 201
    except Exception as e:
        traceback.print_exc()
        return jsonify({'message': 'Server error'}), 500


@app.route('/api/login', methods=['POST'])
def login():
    try:
        data     = request.get_json()
        email    = data.get('email', '').strip().lower()
        password = data.get('password', '')
        if not email or not password:
            return jsonify({'message': 'Email and password required'}), 400

        with db_conn() as conn:
            cursor = conn.cursor()
            user, role = _find_user_by_email(cursor, email)
            if not user:
                raise ValueError('invalid_credentials')
            if not bcrypt.checkpw(password.encode(), user['password'].encode()):
                raise ValueError('invalid_credentials')

            tbl = table_for_role(role)
            uid = user['id'] or str(uuid.uuid4())
            cursor.execute(f"UPDATE {tbl} SET last_login = ? WHERE email = ?",
                           (datetime.now().isoformat(), email))
            if not user['id']:
                cursor.execute(f"UPDATE {tbl} SET id = ? WHERE email = ?", (uid, email))

        return jsonify({'message': 'Login successful',
                        'user': {'id': uid, 'fullName': user['fullName'], 'email': user['email'],
                                 'role': user.get('role', role.lower()),
                                 'status': user.get('status', 'active')}})
    except ValueError as ve:
        if str(ve) == 'invalid_credentials':
            return jsonify({'message': 'Invalid email or password'}), 401
        return jsonify({'message': 'Server error'}), 500
    except Exception as e:
        traceback.print_exc()
        return jsonify({'message': 'Server error'}), 500


@app.route('/api/forgot-password', methods=['POST'])
def forgot_password():
    return jsonify({'message': 'If an account exists, a reset link has been sent to your email.'})


@app.route('/api/change-password', methods=['POST'])
def change_password():
    try:
        data             = request.get_json()
        email            = data.get('email', '').strip().lower()
        current_password = data.get('currentPassword', '')
        new_password     = data.get('newPassword', '')
        if not all([email, current_password, new_password]):
            return jsonify({'message': 'All fields are required'}), 400
        if len(new_password) < 6:
            return jsonify({'message': 'New password must be at least 6 characters'}), 400

        conn   = get_db_connection()
        cursor = conn.cursor()
        user, role = _find_user_by_email(cursor, email)
        if not user:
            conn.close()
            return jsonify({'message': 'User not found'}), 404
        if not bcrypt.checkpw(current_password.encode(), user['password'].encode()):
            conn.close()
            return jsonify({'message': 'Current password is incorrect'}), 401
        tbl    = table_for_role(role)
        hashed = bcrypt.hashpw(new_password.encode(), bcrypt.gensalt()).decode()
        cursor.execute(f"UPDATE {tbl} SET password = ? WHERE email = ?", (hashed, email))
        conn.commit(); conn.close()
        return jsonify({'message': 'Password updated successfully'})
    except Exception as e:
        traceback.print_exc()
        return jsonify({'message': 'Server error'}), 500


# ───────────────────────────────────────────────
# User Management Routes
# ───────────────────────────────────────────────


@app.route('/api/users/counts', methods=['GET'])
def get_user_counts():
    """Return user counts per role — used by the stat cards on manage-users page."""
    try:
        conn   = get_db_connection()
        cursor = conn.cursor()
        counts = { 'Admin':0, 'Teacher':0, 'Parent':0, 'Accountant':0 }
        for role, tbl in ROLE_TABLE.items():
            cursor.execute(f"SELECT COUNT(*) as cnt FROM {tbl}")
            row = cursor.fetchone(); counts[role.lower()] = row["cnt"] if row else 0
        # Pending users (self-registered, no role yet)
        try:
            cursor.execute("SELECT COUNT(*) as cnt FROM pending_users")
            row = cursor.fetchone(); counts['Pending'] = row["cnt"] if row else 0
        except:
            counts['Pending'] = 0
        # Students
        try:
            cursor.execute("SELECT COUNT(*) as cnt FROM students")
            row = cursor.fetchone(); counts['Student'] = row["cnt"] if row else 0
        except:
            counts['Student'] = 0
        conn.close()
        # Total = only official members (excludes Pending — they haven't been approved yet)
        counts['Total'] = sum(v for k, v in counts.items() if k != 'Pending')
        return jsonify(counts)
    except Exception as e:
        traceback.print_exc()
        return jsonify({'message': 'Server error'}), 500


@app.route('/api/users', methods=['GET'])
def get_users():
    """Return all staff across all role tables combined."""
    try:
        conn   = get_db_connection()
        cursor = conn.cursor()
        all_users = []
        # Include self-registered pending users first so admin can see and approve them
        try:
            cursor.execute("""
                SELECT id, fullName, email, phone, date_of_birth, gender,
                       address, status, createdAt, last_login
                FROM pending_users ORDER BY createdAt DESC
            """)
            for row in cursor.fetchall():
                u = dict(row)
                u['role'] = 'Pending'
                all_users.append(u)
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
                u = dict(row)
                u['role'] = role.lower()
                if tbl == 'parents':
                    try:    u['children'] = json.loads(u.get('children') or '[]')
                    except: u['children'] = []
                else:
                    u['children'] = []
                all_users.append(u)
        conn.close()
        all_users.sort(key=lambda x: x.get('createdAt') or '', reverse=True)
        return jsonify(all_users)
    except Exception as e:
        traceback.print_exc()
        return jsonify({'message': 'Server error'}), 500


@app.route('/api/users/<user_id>', methods=['GET'])
def get_user(user_id):
    try:
        conn   = get_db_connection()
        cursor = conn.cursor()
        user, _ = _find_user_by_id(cursor, user_id)
        conn.close()
        if not user:
            return jsonify({'message': 'User not found'}), 404
        return jsonify(user)
    except Exception as e:
        traceback.print_exc()
        return jsonify({'message': 'Server error'}), 500


@app.route('/api/users', methods=['POST'])
def create_user():
    """Create a user in the appropriate role-specific table."""
    try:
        data          = request.get_json()
        fullName      = (data.get('fullName') or '').strip()
        email         = (data.get('email') or '').strip().lower()
        password      = data.get('password', '')
        assigned_role = (data.get('role') or 'admin').lower()

        if not all([fullName, email, password]):
            return jsonify({'message': 'Missing required fields'}), 400
            
        # Validate school email domain for admin-created users too
        if not validate_school_email(email):
            return jsonify({'message': f'Please use a school email address (@{SCHOOL_EMAIL_DOMAINS[0]})'}), 400

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
                  data.get('phone'), data.get('date_of_birth'), data.get('gender'),
                  data.get('address'), children_json, data.get('status','active'), now))
        elif tbl == 'teachers':
            cursor.execute("""
                INSERT INTO teachers
                  (id,fullName,email,password,phone,date_of_birth,gender,address,subject,status,createdAt)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)
            """, (uid, fullName, email, hashed,
                  data.get('phone'), data.get('date_of_birth'), data.get('gender'),
                  data.get('address'), data.get('subject'), data.get('status','active'), now))
        else:
            cursor.execute(f"""
                INSERT INTO {tbl}
                  (id,fullName,email,password,phone,date_of_birth,gender,address,status,createdAt)
                VALUES (?,?,?,?,?,?,?,?,?,?)
            """, (uid, fullName, email, hashed,
                  data.get('phone'), data.get('date_of_birth'), data.get('gender'),
                  data.get('address'), data.get('status','active'), now))

        cursor.execute("UPDATE roles SET users_count = users_count+1 WHERE LOWER(name) = ?",
                       (assigned_role,))
        conn.commit(); conn.close()
        return jsonify({'message': 'User created successfully',
                        'user': {'id': uid, 'fullName': fullName, 'email': email,
                                 'role': assigned_role.lower()}}), 201
    except Exception as e:
        traceback.print_exc()
        return jsonify({'message': 'Server error'}), 500


@app.route('/api/admin/create-user', methods=['POST'])
def admin_create_user():
    return create_user()


@app.route('/api/users/bulk', methods=['POST'])
def bulk_create_users():
    """
    Create up to 100 users in a SINGLE database transaction.
    Body: { "users": [ { fullName, email, password, role, phone?, ... }, ... ] }
    Returns a summary of successes and failures — never aborts the whole batch
    for one bad record.
    """
    try:
        data  = request.get_json()
        users = data.get('users') if data else None
        if not isinstance(users, list) or len(users) == 0:
            return jsonify({'message': '"users" array is required'}), 400
        if len(users) > 100:
            return jsonify({'message': 'Maximum 100 users per batch'}), 400

        results   = []
        succeeded = 0
        failed    = 0
        now       = datetime.now().isoformat()

        # One connection, one transaction for the entire batch
        with db_conn() as conn:
            cursor = conn.cursor()

            for u in users:
                fullName = (u.get('fullName') or '').strip()
                email    = (u.get('email')    or '').strip().lower()
                password = u.get('password', '')
                role     = (u.get('role')     or 'teacher').lower()

                # ── Validate ──
                if not all([fullName, email, password]):
                    results.append({'email': email or '?', 'status': 'failed',
                                    'reason': 'Missing fullName, email or password'})
                    failed += 1; continue

                if not validate_school_email(email):
                    results.append({'email': email, 'status': 'failed',
                                    'reason': f'Email must use a school domain (@{SCHOOL_EMAIL_DOMAINS[0]})'})
                    failed += 1; continue

                # ── Duplicate check (within this single connection) ──
                existing, _ = _find_user_by_email(cursor, email)
                if existing:
                    results.append({'email': email, 'status': 'failed', 'reason': 'Email already exists'})
                    failed += 1; continue

                tbl    = table_for_role(role)
                uid    = str(uuid.uuid4())
                hashed = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()

                try:
                    if tbl == 'parents':
                        children_json = json.dumps(u.get('children', []))
                        cursor.execute("""
                            INSERT INTO parents
                              (id,fullName,email,password,phone,date_of_birth,gender,address,children,status,createdAt)
                            VALUES (?,?,?,?,?,?,?,?,?,?,?)
                        """, (uid, fullName, email, hashed,
                              u.get('phone'), u.get('date_of_birth'), u.get('gender'),
                              u.get('address'), children_json, u.get('status','active'), now))
                    elif tbl == 'teachers':
                        cursor.execute("""
                            INSERT INTO teachers
                              (id,fullName,email,password,phone,date_of_birth,gender,address,subject,status,createdAt)
                            VALUES (?,?,?,?,?,?,?,?,?,?,?)
                        """, (uid, fullName, email, hashed,
                              u.get('phone'), u.get('date_of_birth'), u.get('gender'),
                              u.get('address'), u.get('subject'), u.get('status','active'), now))
                    else:
                        cursor.execute(f"""
                            INSERT INTO {tbl}
                              (id,fullName,email,password,phone,date_of_birth,gender,address,status,createdAt)
                            VALUES (?,?,?,?,?,?,?,?,?,?)
                        """, (uid, fullName, email, hashed,
                              u.get('phone'), u.get('date_of_birth'), u.get('gender'),
                              u.get('address'), u.get('status','active'), now))

                    cursor.execute("UPDATE roles SET users_count = users_count+1 WHERE LOWER(name) = ?", (role,))
                    results.append({'email': email, 'status': 'created', 'id': uid, 'role': role})
                    succeeded += 1

                except Exception as row_err:
                    results.append({'email': email, 'status': 'failed', 'reason': str(row_err)})
                    failed += 1
                    # Do NOT re-raise — continue with the rest of the batch

        return jsonify({
            'message':   f'{succeeded} created, {failed} failed',
            'succeeded': succeeded,
            'failed':    failed,
            'results':   results
        }), 207 if failed > 0 else 201

    except Exception as e:
        traceback.print_exc()
        return jsonify({'message': 'Server error: ' + str(e)}), 500


@app.route('/api/users/<user_id>', methods=['PUT'])
def update_user(user_id):
    try:
        data   = request.get_json()
        conn   = get_db_connection()
        cursor = conn.cursor()
        user, old_role = _find_user_by_id(cursor, user_id)
        if not user:
            conn.close()
            return jsonify({'message': 'User not found'}), 404

        new_role = (data.get('role') or old_role).lower()
        old_tbl  = table_for_role(old_role)
        new_tbl  = table_for_role(new_role)

        if old_tbl != new_tbl:
            # Move to new table
            cursor.execute(f"DELETE FROM {old_tbl} WHERE id = ?", (user_id,))
            uid = user['id']; now = user.get('createdAt') or datetime.now().isoformat()
            pwd = user['password']
            if new_tbl == 'parents':
                cursor.execute("""
                    INSERT OR IGNORE INTO parents
                      (id,fullName,email,password,phone,date_of_birth,gender,address,children,status,createdAt)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?)
                """, (uid, data.get('fullName',user['fullName']), user['email'], pwd,
                      data.get('phone'), data.get('date_of_birth'), data.get('gender'),
                      data.get('address'), json.dumps(data.get('children',[])),
                      data.get('status','active'), now))
            elif new_tbl == 'teachers':
                cursor.execute("""
                    INSERT OR IGNORE INTO teachers
                      (id,fullName,email,password,phone,date_of_birth,gender,address,subject,status,createdAt)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?)
                """, (uid, data.get('fullName',user['fullName']), user['email'], pwd,
                      data.get('phone'), data.get('date_of_birth'), data.get('gender'),
                      data.get('address'), data.get('subject'), data.get('status','active'), now))
            else:
                cursor.execute(f"""
                    INSERT OR IGNORE INTO {new_tbl}
                      (id,fullName,email,password,phone,date_of_birth,gender,address,status,createdAt)
                    VALUES (?,?,?,?,?,?,?,?,?,?)
                """, (uid, data.get('fullName',user['fullName']), user['email'], pwd,
                      data.get('phone'), data.get('date_of_birth'), data.get('gender'),
                      data.get('address'), data.get('status','active'), now))
            cursor.execute("UPDATE roles SET users_count=MAX(0,users_count-1) WHERE LOWER(name)=?", (old_role,))
            cursor.execute("UPDATE roles SET users_count=users_count+1 WHERE LOWER(name)=?", (new_role,))
        else:
            if new_tbl == 'parents':
                cursor.execute("""
                    UPDATE parents SET fullName=?,phone=?,date_of_birth=?,gender=?,
                      address=?,children=?,status=? WHERE id=?
                """, (data.get('fullName'), data.get('phone'), data.get('date_of_birth'),
                      data.get('gender'), data.get('address'),
                      json.dumps(data.get('children',[])),
                      data.get('status','active'), user_id))
            elif new_tbl == 'teachers':
                cursor.execute("""
                    UPDATE teachers SET fullName=?,phone=?,date_of_birth=?,gender=?,
                      address=?,subject=?,status=? WHERE id=?
                """, (data.get('fullName'), data.get('phone'), data.get('date_of_birth'),
                      data.get('gender'), data.get('address'), data.get('subject'),
                      data.get('status','active'), user_id))
            else:
                cursor.execute(f"""
                    UPDATE {new_tbl} SET fullName=?,phone=?,date_of_birth=?,gender=?,
                      address=?,status=? WHERE id=?
                """, (data.get('fullName'), data.get('phone'), data.get('date_of_birth'),
                      data.get('gender'), data.get('address'),
                      data.get('status','active'), user_id))
        conn.commit(); conn.close()
        return jsonify({'message': 'User updated successfully'})
    except Exception as e:
        traceback.print_exc()
        return jsonify({'message': 'Server error'}), 500


@app.route('/api/users/<user_id>', methods=['DELETE'])
def delete_user(user_id):
    try:
        conn   = get_db_connection()
        cursor = conn.cursor()
        # Check pending_users first (they won't be in ROLE_TABLE)
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
    except Exception as e:
        traceback.print_exc()
        return jsonify({'message': 'Server error'}), 500


@app.route('/api/users/<user_id>/reset-password', methods=['POST'])
def reset_user_password(user_id):
    try:
        data         = request.get_json()
        new_password = data.get('newPassword')
        if not new_password or len(new_password) < 6:
            return jsonify({'message': 'Password must be at least 6 characters'}), 400
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
    except Exception as e:
        traceback.print_exc()
        return jsonify({'message': 'Server error'}), 500


@app.route('/api/users/by-email-lookup', methods=['GET'])
def get_user_by_email():
    try:
        email = request.args.get('email', '').strip().lower()
        if not email:
            return jsonify({'message': 'Email is required'}), 400
        conn   = get_db_connection()
        cursor = conn.cursor()
        user, _ = _find_user_by_email(cursor, email)
        conn.close()
        if not user:
            return jsonify({'message': 'User not found'}), 404
        return jsonify(user)
    except Exception as e:
        traceback.print_exc()
        return jsonify({'message': 'Server error'}), 500


@app.route('/api/users/assign-role', methods=['POST'])
def assign_role():
    try:
        data   = request.get_json()
        email  = (data.get('email') or '').strip().lower()
        role   = (data.get('role') or '').strip().lower()
        status = data.get('status', 'active')
        if not email or not role:
            return jsonify({'message': 'Email and role are required'}), 400

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
                          user.get('address'), user.get('children','[]'), status, now))
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

        return jsonify({'message': 'Role assigned successfully', 'email': email, 'role': role.lower()})
    except Exception as e:
        traceback.print_exc()
        return jsonify({'message': 'Server error'}), 500


@app.route('/api/users/by-email', methods=['PATCH'])
def update_user_by_email_patch():
    try:
        data   = request.get_json()
        email  = (data.get('email') or '').strip().lower()
        role   = data.get('role'); status = data.get('status')
        if not email:
            return jsonify({'message': 'Email is required'}), 400
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
        return jsonify({'message': 'User updated successfully', 'email': email, 'role': new_role.lower()})
    except Exception as e:
        traceback.print_exc()
        return jsonify({'message': 'Server error'}), 500


@app.route('/api/users/update-by-email', methods=['PUT'])
def update_user_by_email_put():
    try:
        data         = request.get_json()
        target_email = (data.get('targetEmail') or data.get('email') or '').strip().lower()
        if not target_email:
            return jsonify({'message': 'Email is required'}), 400
        conn   = get_db_connection()
        cursor = conn.cursor()
        user, old_role = _find_user_by_email(cursor, target_email)
        if not user:
            conn.close()
            return jsonify({'message': 'User not found'}), 404
        new_role = (data.get('role') or old_role).lower()
        old_tbl  = table_for_role(old_role); new_tbl = table_for_role(new_role)
        if old_tbl != new_tbl:
            cursor.execute(f"DELETE FROM {old_tbl} WHERE email=?", (target_email,))
            uid = user['id']; now = user.get('createdAt') or datetime.now().isoformat()
            if new_tbl == 'parents':
                cursor.execute("""
                    INSERT OR IGNORE INTO parents
                      (id,fullName,email,password,phone,date_of_birth,gender,address,children,status,createdAt)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?)
                """, (uid, data.get('fullName',user['fullName']), target_email, user['password'],
                      data.get('phone'), data.get('date_of_birth'), data.get('gender'),
                      data.get('address'), json.dumps(data.get('children',[])),
                      data.get('status','active'), now))
            else:
                cursor.execute(f"""
                    INSERT OR IGNORE INTO {new_tbl}
                      (id,fullName,email,password,phone,date_of_birth,gender,address,status,createdAt)
                    VALUES (?,?,?,?,?,?,?,?,?,?)
                """, (uid, data.get('fullName',user['fullName']), target_email, user['password'],
                      data.get('phone'), data.get('date_of_birth'), data.get('gender'),
                      data.get('address'), data.get('status','active'), now))
            cursor.execute("UPDATE roles SET users_count=MAX(0,users_count-1) WHERE LOWER(name)=?", (old_role,))
            cursor.execute("UPDATE roles SET users_count=users_count+1 WHERE LOWER(name)=?", (new_role,))
        else:
            if new_tbl == 'parents':
                cursor.execute("""
                    UPDATE parents SET fullName=?,phone=?,date_of_birth=?,gender=?,
                      address=?,children=?,status=? WHERE email=?
                """, (data.get('fullName'), data.get('phone'), data.get('date_of_birth'),
                      data.get('gender'), data.get('address'),
                      json.dumps(data.get('children',[])),
                      data.get('status','active'), target_email))
            else:
                cursor.execute(f"""
                    UPDATE {new_tbl} SET fullName=?,phone=?,date_of_birth=?,gender=?,
                      address=?,status=? WHERE email=?
                """, (data.get('fullName'), data.get('phone'), data.get('date_of_birth'),
                      data.get('gender'), data.get('address'),
                      data.get('status','active'), target_email))
        conn.commit(); conn.close()
        return jsonify({'message': 'User updated successfully'})
    except Exception as e:
        traceback.print_exc()
        return jsonify({'message': 'Server error'}), 500


# ───────────────────────────────────────────────
# Profile Routes
# ───────────────────────────────────────────────

@app.route('/api/profile', methods=['GET'])
def get_profile():
    try:
        email = request.args.get('email', '').strip().lower()
        if not email:
            return jsonify({'message': 'Email is required'}), 400
        conn   = get_db_connection()
        cursor = conn.cursor()
        user, role = _find_user_by_email(cursor, email)
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
    except Exception as e:
        traceback.print_exc()
        return jsonify({'message': 'Server error'}), 500


@app.route('/api/profile', methods=['PUT'])
def update_profile():
    try:
        data  = request.get_json()
        email = (data.get('email') or '').strip().lower()
        if not email:
            return jsonify({'message': 'Email is required'}), 400
        conn   = get_db_connection()
        cursor = conn.cursor()
        user, role = _find_user_by_email(cursor, email)
        if not user:
            conn.close()
            return jsonify({'message': 'User not found'}), 404
        tbl     = table_for_role(role)
        allowed = ['fullName', 'phone', 'date_of_birth', 'gender', 'address']
        updates = {k: v.strip() if isinstance(v, str) else v
                   for k, v in data.items() if k in allowed and v is not None}
        if not updates:
            conn.close()
            return jsonify({'message': 'No fields to update'}), 400
        set_clause = ", ".join(f"{k} = ?" for k in updates)
        cursor.execute(f"UPDATE {tbl} SET {set_clause} WHERE email = ?",
                       list(updates.values()) + [email])
        conn.commit(); conn.close()
        return jsonify({'message': 'Profile updated successfully'})
    except Exception as e:
        traceback.print_exc()
        return jsonify({'message': 'Server error'}), 500
    
def change_password():
    conn = None  # define outside try so finally can see it
    try:
        data = request.get_json()
        if not data:
            return jsonify({"message": "Invalid request data"}), 400

        email = data.get('email')
        current_password = data.get('currentPassword')
        new_password = data.get('newPassword')

        if not all([email, current_password, new_password]):
            return jsonify({"message": "Missing required fields"}), 400

        if len(new_password) < 6:
            return jsonify({"message": "New password must be at least 6 characters"}), 400

        conn = TursoConn()
        cur = conn.cursor()

        # Find the user
        cur.execute("SELECT id, password_hash FROM users WHERE email = ?", (email,))
        user = cur.fetchone()

        if not user:
            return jsonify({"message": "User not found"}), 404

        # Verify current password
        stored_hash = user['password_hash']
        if not bcrypt.checkpw(current_password.encode('utf-8'), stored_hash.encode('utf-8')):
            return jsonify({"message": "Current password is incorrect"}), 401

        # Generate new hash
        new_hash = bcrypt.hashpw(new_password.encode('utf-8'), bcrypt.gensalt())

        # Update password and timestamp
        cur.execute("""
            UPDATE users
            SET password_hash = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        """, (new_hash.decode('utf-8'), user['id']))

        conn.commit()

        return jsonify({"message": "Password changed successfully"})

    except Exception as e:
        traceback.print_exc()
        return jsonify({"message": "Server error occurred"}), 500

    finally:
        if conn is not None:
            conn.close()

# ───────────────────────────────────────────────
# Parent Portal
# ───────────────────────────────────────────────

@app.route('/api/parent/children', methods=['GET'])
def get_parent_children():
    try:
        email = request.headers.get('X-User-Email', '').strip().lower()
        if not email:
            return jsonify({'message': 'Email header required'}), 400
        conn   = get_db_connection()
        cursor = conn.cursor()

        # Fetch the parent row — need both children JSON and fullName
        cursor.execute("SELECT fullName, children FROM parents WHERE email = ?", (email,))
        row = cursor.fetchone()
        if not row:
            conn.close()
            return jsonify({'message': 'Parent not found'}), 404

        parent_name = (row['fullName'] or '').strip()

        # ── Source 1: children stored in parent's JSON column ──────────────
        try:    kids = json.loads(row['children'] or '[]')
        except: kids = []

        # Build a dict keyed by normalised admission number so we can de-duplicate
        # when the same child appears in both sources
        seen_adm = {}   # adm_no.lower() → result entry

        for i, ch in enumerate(kids):
            adm_no = (
                ch.get('admissionNumber') or ch.get('admNo') or
                ch.get('admission_number') or ch.get('admissionNo') or ''
            ).strip()

            # Try to resolve to a real student record by admission number
            student_row = None
            if adm_no:
                cursor.execute(
                    "SELECT id, fullName, studentClass FROM students "
                    "WHERE admissionNumber = ? COLLATE NOCASE LIMIT 1",
                    (adm_no,)
                )
                student_row = cursor.fetchone()

            real_id = student_row['id'] if student_row else None
            name = (
                (student_row['fullName'] if student_row else None) or
                ch.get('childName') or ch.get('name') or
                ch.get('fullName') or ch.get('studentName') or ch.get('child_name') or
                'Unknown'
            )
            cls = (
                (student_row['studentClass'] if student_row else None) or
                ch.get('className') or ch.get('class') or
                ch.get('studentClass') or ch.get('student_class') or '—'
            )
            entry = {
                'id':              real_id or ch.get('id') or f'child_{i}_{email}',
                'name':            name,
                'admissionNumber': adm_no or '—',
                'class':           cls,
                'relationship':    ch.get('relationship') or 'Parent',
                'id_resolved':     real_id is not None,
            }
            key = adm_no.lower() if adm_no else f'__json_{i}'
            seen_adm[key] = entry

        # ── Source 2: students table where parentName matches ──────────────
        # This covers children registered via the students page directly
        if parent_name:
            cursor.execute(
                "SELECT id, fullName, admissionNumber, studentClass "
                "FROM students WHERE LOWER(TRIM(parentName)) = LOWER(TRIM(?)) "
                "AND (status IS NULL OR LOWER(status) != 'inactive')",
                (parent_name,)
            )
            for sr in cursor.fetchall():
                adm_no = (sr['admissionNumber'] or '').strip()
                key    = adm_no.lower() if adm_no else f'__db_{sr["id"]}'
                if key in seen_adm:
                    # Already present from JSON column — just ensure id_resolved is set
                    seen_adm[key]['id_resolved'] = True
                    seen_adm[key]['id']          = sr['id']
                    continue
                # New child — only known via the students table
                seen_adm[key] = {
                    'id':              sr['id'],
                    'name':            sr['fullName'] or 'Unknown',
                    'admissionNumber': adm_no or '—',
                    'class':           sr['studentClass'] or '—',
                    'relationship':    'Parent',
                    'id_resolved':     True,
                }

        conn.close()
        return jsonify(list(seen_adm.values()))
    except Exception as e:
        traceback.print_exc()
        return jsonify({'message': 'Server error'}), 500


# ───────────────────────────────────────────────
# Students Routes
# ───────────────────────────────────────────────

@app.route('/api/students', methods=['GET'])
def get_students():
    try:
        conn   = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("""
            SELECT id, fullName, admissionNumber, studentClass, gender,
                   date_of_birth, parentName, parentPhone, address,
                   status, admissionDate, createdAt
            FROM students ORDER BY fullName ASC
        """)
        rows = [dict(r) for r in cursor.fetchall()]
        conn.close()
        return jsonify(rows)
    except Exception as e:
        traceback.print_exc()
        return jsonify({'message': 'Server error'}), 500


@app.route('/api/students', methods=['POST'])
def create_student():
    try:
        data            = request.get_json()
        fullName        = (data.get('fullName') or '').strip()
        admissionNumber = (data.get('admissionNumber') or '').strip()
        if not fullName or not admissionNumber:
            return jsonify({'message': 'Full name and admission number are required'}), 400
        conn   = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT id FROM students WHERE admissionNumber = ?", (admissionNumber,))
        if cursor.fetchone():
            conn.close()
            return jsonify({'message': 'Admission number already exists'}), 409
        student_id = str(uuid.uuid4())
        now        = datetime.now().isoformat()
        cursor.execute("""
            INSERT INTO students
              (id,fullName,admissionNumber,studentClass,gender,date_of_birth,
               parentName,parentPhone,address,status,admissionDate,createdAt)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        """, (student_id, fullName, admissionNumber,
              data.get('studentClass'), data.get('gender'), data.get('date_of_birth'),
              data.get('parentName'), data.get('parentPhone'), data.get('address'),
              data.get('status','active'), data.get('admissionDate'), now))
        conn.commit(); conn.close()
        return jsonify({'message': 'Student created successfully', 'id': student_id}), 201
    except Exception as e:
        traceback.print_exc()
        return jsonify({'message': 'Server error'}), 500


@app.route('/api/students/sync', methods=['POST'])
def sync_students():
    try:
        conn   = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT COUNT(*) as cnt FROM students")
        count = cursor.fetchone()['cnt']
        conn.close()
        return jsonify({'message': f'{count} students in database', 'count': count})
    except Exception as e:
        traceback.print_exc()
        return jsonify({'message': 'Server error'}), 500


@app.route('/api/students/<student_id>', methods=['PUT'])
def update_student(student_id):
    try:
        data   = request.get_json()
        conn   = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT id FROM students WHERE id = ?", (student_id,))
        if not cursor.fetchone():
            conn.close()
            return jsonify({'message': 'Student not found'}), 404
        cursor.execute("""
            UPDATE students SET fullName=?,gender=?,date_of_birth=?,address=?,
              studentClass=?,admissionNumber=?,parentName=?,parentPhone=?,
              admissionDate=?,status=? WHERE id=?
        """, (data.get('fullName'), data.get('gender'), data.get('date_of_birth'),
              data.get('address'), data.get('studentClass'), data.get('admissionNumber'),
              data.get('parentName'), data.get('parentPhone'), data.get('admissionDate'),
              data.get('status','active'), student_id))
        conn.commit(); conn.close()
        return jsonify({'message': 'Student updated successfully'})
    except Exception as e:
        traceback.print_exc()
        return jsonify({'message': 'Server error'}), 500


@app.route('/api/students/<student_id>', methods=['DELETE'])
def delete_student(student_id):
    try:
        conn   = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("DELETE FROM students WHERE id = ?", (student_id,))
        if cursor.rowcount == 0:
            conn.close()
            return jsonify({'message': 'Student not found'}), 404
        conn.commit(); conn.close()
        return jsonify({'message': 'Student deleted successfully'})
    except Exception as e:
        traceback.print_exc()
        return jsonify({'message': 'Server error'}), 500


# ───────────────────────────────────────────────
# Roles & Permissions Routes
# ───────────────────────────────────────────────

@app.route('/api/roles', methods=['GET'])
def get_roles():
    try:
        conn   = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM roles ORDER BY name")
        roles = []
        for row in cursor.fetchall():
            r = dict(row)
            r['permissions'] = json.loads(r['permissions']) if r['permissions'] else {}
            roles.append(r)
        conn.close()
        return jsonify(roles)
    except Exception as e:
        traceback.print_exc()
        return jsonify({'message': 'Server error'}), 500

@app.route('/api/roles/<int:role_id>', methods=['GET'])
def get_role(role_id):
    try:
        conn   = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM roles WHERE id = ?", (role_id,))
        role = cursor.fetchone()
        conn.close()
        if not role:
            return jsonify({'message': 'Role not found'}), 404
        r = dict(role)
        r['permissions'] = json.loads(r['permissions']) if r['permissions'] else {}
        return jsonify(r)
    except Exception as e:
        traceback.print_exc()
        return jsonify({'message': 'Server error'}), 500

@app.route('/api/roles', methods=['POST'])
def create_role():
    try:
        data        = request.get_json()
        name        = data.get('name','').strip()
        description = data.get('description','').strip()
        if not name:
            return jsonify({'message': 'Role name is required'}), 400
        conn   = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT id FROM roles WHERE name = ?", (name,))
        if cursor.fetchone():
            conn.close()
            return jsonify({'message': 'Role already exists'}), 409
        empty_perms = {str(m): {str(p): False for p in range(1,6)} for m in range(1,11)}
        cursor.execute("""
            INSERT INTO roles (name,description,is_system_role,permissions,users_count,created_at)
            VALUES (?,?,0,?,0,?)
        """, (name, description, json.dumps(empty_perms), datetime.now().isoformat()))
        role_id = cursor.lastrowid
        conn.commit(); conn.close()
        return jsonify({'message': 'Role created successfully', 'id': role_id}), 201
    except Exception as e:
        traceback.print_exc()
        return jsonify({'message': 'Server error'}), 500

@app.route('/api/roles/<int:role_id>', methods=['PUT'])
def update_role(role_id):
    try:
        data   = request.get_json()
        conn   = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM roles WHERE id = ?", (role_id,))
        role = cursor.fetchone()
        if not role:
            conn.close()
            return jsonify({'message': 'Role not found'}), 404
        if 'permissions' in data:
            cursor.execute("UPDATE roles SET permissions=? WHERE id=?",
                           (json.dumps(data['permissions']), role_id))
        if 'name' in data or 'description' in data:
            cursor.execute("UPDATE roles SET name=?,description=? WHERE id=?",
                           (data.get('name', dict(role)['name']),
                            data.get('description', dict(role)['description']), role_id))
        conn.commit(); conn.close()
        return jsonify({'message': 'Role updated successfully'})
    except Exception as e:
        traceback.print_exc()
        return jsonify({'message': 'Server error'}), 500

@app.route('/api/roles/<int:role_id>', methods=['DELETE'])
def delete_role(role_id):
    try:
        conn   = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT is_system_role FROM roles WHERE id = ?", (role_id,))
        role = cursor.fetchone()
        if not role:
            conn.close()
            return jsonify({'message': 'Role not found'}), 404
        if role['is_system_role']:
            conn.close()
            return jsonify({'message': 'Cannot delete system roles'}), 403
        cursor.execute("DELETE FROM roles WHERE id=?", (role_id,))
        conn.commit(); conn.close()
        return jsonify({'message': 'Role deleted successfully'})
    except Exception as e:
        traceback.print_exc()
        return jsonify({'message': 'Server error'}), 500


# ───────────────────────────────────────────────
# Fees & Payments Routes
# ───────────────────────────────────────────────

@app.route('/api/fees', methods=['GET'])
def get_fees():
    try:
        student_id = request.args.get('student_id','').strip()
        if not student_id:
            return jsonify({'message': 'student_id required'}), 400
        conn   = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM fee_structure WHERE student_id=? ORDER BY year DESC, created_at DESC LIMIT 1",
                       (student_id,))
        structure = cursor.fetchone()
        total_fee = dict(structure)['total_fee'] if structure else 0
        term      = dict(structure)['term']      if structure else None
        cursor.execute("SELECT * FROM fee_payments WHERE student_id=? ORDER BY created_at DESC", (student_id,))
        payments = [dict(r) for r in cursor.fetchall()]
        conn.close()
        result = []
        for p in payments:
            p['total'] = total_fee; p['term'] = p.get('term') or term or '—'
            p['date']  = p.get('created_at',''); p['ref'] = p.get('reference','')
            result.append(p)
        if not result and total_fee:
            result = [{'id':None,'student_id':student_id,'total':total_fee,'amount':0,
                       'term':term or '—','method':None,'ref':None,'status':None,'date':None}]
        return jsonify(result)
    except Exception as e:
        traceback.print_exc()
        return jsonify({'message': 'Server error'}), 500

@app.route('/api/fees/structure', methods=['POST'])
def set_fee_structure():
    try:
        data       = request.get_json()
        student_id = data.get('student_id','').strip()
        term       = data.get('term','Term 1').strip()
        year       = data.get('year', datetime.now().year)
        total_fee  = float(data.get('total_fee',0))
        if not student_id:
            return jsonify({'message': 'student_id required'}), 400
        conn   = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("""
            INSERT INTO fee_structure (id,student_id,term,year,total_fee,created_at)
            VALUES (?,?,?,?,?,?)
            ON CONFLICT(student_id,term,year) DO UPDATE SET total_fee=excluded.total_fee
        """, (str(uuid.uuid4()), student_id, term, year, total_fee, datetime.now().isoformat()))
        conn.commit(); conn.close()
        return jsonify({'message': 'Fee structure updated'})
    except Exception as e:
        traceback.print_exc()
        return jsonify({'message': 'Server error'}), 500

@app.route('/api/fees/pay', methods=['POST'])
def make_payment():
    try:
        data       = request.get_json()
        student_id = data.get('student_id','').strip()
        amount     = float(data.get('amount',0))
        method     = data.get('method','Cash').strip()
        term       = data.get('term','').strip()
        notes      = data.get('notes','').strip()
        year       = data.get('year', datetime.now().year)
        if not student_id: return jsonify({'message': 'student_id required'}), 400
        if amount <= 0:    return jsonify({'message': 'Amount must be greater than 0'}), 400
        conn   = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT total_fee FROM fee_structure WHERE student_id=? ORDER BY year DESC LIMIT 1", (student_id,))
        row = cursor.fetchone()
        total_fee = row['total_fee'] if row else 0
        cursor.execute("SELECT COALESCE(SUM(amount),0) as paid FROM fee_payments WHERE student_id=?", (student_id,))
        paid    = cursor.fetchone()['paid']
        balance = total_fee - paid
        if total_fee > 0 and amount > balance:
            conn.close()
            return jsonify({'message': f'Amount KSh {amount:,.0f} exceeds balance of KSh {balance:,.0f}'}), 400
        reference = 'PAY-' + str(uuid.uuid4())[:8].upper()
        cursor.execute("""
            INSERT INTO fee_payments (id,student_id,term,year,amount,method,reference,status,notes,created_at)
            VALUES (?,?,?,?,?,?,?,'completed',?,?)
        """, (str(uuid.uuid4()), student_id, term or None, year, amount, method,
              reference, notes or None, datetime.now().isoformat()))
        conn.commit(); conn.close()
        return jsonify({'message':'Payment recorded successfully','reference':reference,
                        'amount':amount,'balance':max(0,balance-amount)}), 201
    except Exception as e:
        traceback.print_exc()
        return jsonify({'message': 'Server error'}), 500

@app.route('/api/fees/all', methods=['GET'])
def get_all_fees():
    try:
        conn   = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT id,fullName,admissionNumber,studentClass,status FROM students ORDER BY fullName ASC")
        students = [dict(r) for r in cursor.fetchall()]
        result = []
        for s in students:
            sid = s['id']
            cursor.execute("SELECT total_fee,term,year FROM fee_structure WHERE student_id=? ORDER BY year DESC, created_at DESC LIMIT 1", (sid,))
            fs = cursor.fetchone()
            total_fee = fs['total_fee'] if fs else 0; term = fs['term'] if fs else None
            cursor.execute("SELECT COALESCE(SUM(amount),0) as paid FROM fee_payments WHERE student_id=?", (sid,))
            paid    = cursor.fetchone()['paid']; balance = max(0, total_fee - paid)
            status  = ('No Structure' if total_fee==0 else 'Paid' if balance==0 else 'Pending' if paid==0 else 'Partial')
            result.append({'id':sid,'fullName':s['fullName'],'admissionNumber':s['admissionNumber'],
                           'studentClass':s['studentClass'] or '—','totalFee':total_fee,
                           'paid':paid,'balance':balance,'term':term or '—','status':status})
        conn.close()
        return jsonify({'students':result,
                        'totalCollected':sum(r['paid'] for r in result),
                        'totalArrears':sum(r['balance'] for r in result),
                        'fullyPaid':sum(1 for r in result if r['status']=='Paid'),
                        'totalStudents':len(result)})
    except Exception as e:
        traceback.print_exc()
        return jsonify({'message': 'Server error'}), 500

@app.route('/api/fees/payments/all', methods=['GET'])
def get_all_payments():
    try:
        term_filter = request.args.get('term','').strip()
        conn   = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("""
            SELECT fp.id,fp.student_id,fp.amount,fp.method,fp.reference,
                   fp.term,fp.year,fp.status,fp.notes,fp.created_at,
                   s.fullName,s.admissionNumber,s.studentClass
            FROM fee_payments fp LEFT JOIN students s ON s.id=fp.student_id
            ORDER BY fp.created_at DESC
        """)
        rows = [dict(r) for r in cursor.fetchall()]
        conn.close()
        if term_filter: rows = [r for r in rows if (r['term'] or '')==term_filter]
        return jsonify(rows)
    except Exception as e:
        traceback.print_exc()
        return jsonify({'message': 'Server error'}), 500

@app.route('/api/fees/payment/<payment_id>', methods=['DELETE'])
def delete_payment(payment_id):
    try:
        conn   = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("DELETE FROM fee_payments WHERE id=?", (payment_id,))
        if cursor.rowcount == 0:
            conn.close()
            return jsonify({'message': 'Payment not found'}), 404
        conn.commit(); conn.close()
        return jsonify({'message': 'Payment deleted'})
    except Exception as e:
        traceback.print_exc()
        return jsonify({'message': 'Server error'}), 500

@app.route('/api/fees/structure/all', methods=['GET'])
def get_all_fee_structures():
    try:
        conn   = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("""
            SELECT fs.*,s.fullName,s.admissionNumber,s.studentClass
            FROM fee_structure fs LEFT JOIN students s ON s.id=fs.student_id
            ORDER BY fs.year DESC, s.fullName ASC
        """)
        rows = [dict(r) for r in cursor.fetchall()]
        conn.close()
        return jsonify(rows)
    except Exception as e:
        traceback.print_exc()
        return jsonify({'message': 'Server error'}), 500


# ───────────────────────────────────────────────
# Attendance Routes
# ───────────────────────────────────────────────

@app.route('/api/attendance', methods=['GET'])
def get_attendance():
    try:
        conn   = get_db_connection()
        cursor = conn.cursor()
        student_id = request.args.get('student_id','').strip()
        cls        = request.args.get('class','').strip()
        date       = request.args.get('date','').strip()
        date_from  = request.args.get('date_from','').strip()
        date_to    = request.args.get('date_to','').strip()
        status     = request.args.get('status','').strip()
        query  = "SELECT * FROM attendance WHERE 1=1"; params = []
        if student_id: query += " AND (student_id=? OR admission_no=?)"; params += [student_id, student_id]
        if cls:        query += " AND student_class=?";  params.append(cls)
        if date:       query += " AND date=?";           params.append(date)
        if date_from:  query += " AND date>=?";          params.append(date_from)
        if date_to:    query += " AND date<=?";          params.append(date_to)
        if status:     query += " AND status=?";         params.append(status)
        query += " ORDER BY date DESC, student_name ASC"
        cursor.execute(query, params)
        rows = [dict(r) for r in cursor.fetchall()]
        conn.close()
        return jsonify(rows)
    except Exception as e:
        traceback.print_exc()
        return jsonify({'message': 'Server error'}), 500

@app.route('/api/attendance', methods=['POST'])
def save_attendance():
    try:
        data = request.get_json()
        if not data or not isinstance(data, list):
            return jsonify({'message': 'Expected a list of attendance entries'}), 400
        conn   = get_db_connection()
        cursor = conn.cursor()
        saved, errors = 0, []
        for entry in data:
            try:
                student_id   = entry.get('student_id','').strip()
                admission_no = entry.get('admissionNo', entry.get('admission_no','')).strip()
                if not student_id and admission_no:
                    cursor.execute("SELECT id FROM students WHERE admissionNumber=?", (admission_no,))
                    row = cursor.fetchone()
                    if row: student_id = row['id']
                if not student_id:
                    errors.append(f"Cannot resolve student for admissionNo={admission_no}"); continue
                student_name  = entry.get('studentName', entry.get('student_name','')).strip()
                student_class = entry.get('class', entry.get('student_class','')).strip()
                if not student_name or not student_class:
                    cursor.execute("SELECT fullName,studentClass FROM students WHERE id=?", (student_id,))
                    s = cursor.fetchone()
                    if s:
                        student_name  = student_name  or s['fullName']
                        student_class = student_class or s['studentClass']
                date         = entry.get('date', datetime.now().strftime('%Y-%m-%d')).strip()
                raw_status   = entry.get('status','Present').strip()
                valid        = {'Present','Absent','Late','Excused'}
                status       = raw_status.capitalize() if raw_status.capitalize() in valid else 'Present'
                remarks      = entry.get('remarks','').strip()
                teacher_name = entry.get('teacherName', entry.get('teacher_name','')).strip()
                teacher_id   = entry.get('teacher_id','').strip()
                now          = datetime.now().isoformat()
                cursor.execute("""
                    INSERT INTO attendance
                      (id,student_id,admission_no,student_name,student_class,
                       date,status,remarks,teacher_name,teacher_id,created_at)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?)
                    ON CONFLICT(student_id,date) DO UPDATE SET
                      status=excluded.status, remarks=excluded.remarks,
                      teacher_name=excluded.teacher_name, teacher_id=excluded.teacher_id,
                      student_class=excluded.student_class, created_at=excluded.created_at
                """, (str(uuid.uuid4()), student_id, admission_no, student_name, student_class,
                      date, status, remarks, teacher_name, teacher_id, now))
                saved += 1
            except Exception as row_err:
                errors.append(str(row_err))
        conn.commit(); conn.close()
        return jsonify({'saved': saved, 'errors': errors}), 200
    except Exception as e:
        traceback.print_exc()
        return jsonify({'message': 'Server error'}), 500

@app.route('/api/attendance/summary', methods=['GET'])
def attendance_summary():
    try:
        conn   = get_db_connection()
        cursor = conn.cursor()
        date   = request.args.get('date', datetime.now().strftime('%Y-%m-%d')).strip()
        cls    = request.args.get('class','').strip()
        query  = "SELECT * FROM attendance WHERE date=?"; params = [date]
        if cls: query += " AND student_class=?"; params.append(cls)
        cursor.execute(query, params)
        rows = [dict(r) for r in cursor.fetchall()]
        by_class = {}
        for r in rows: by_class.setdefault(r['student_class'] or 'Unknown', []).append(r)
        summary = []
        for class_name, records in sorted(by_class.items()):
            total   = len(records)
            present = sum(1 for r in records if r['status']=='Present')
            summary.append({'class':class_name,'date':date,'total':total,'present':present,
                            'absent':sum(1 for r in records if r['status']=='Absent'),
                            'late':sum(1 for r in records if r['status']=='Late'),
                            'excused':sum(1 for r in records if r['status']=='Excused'),
                            'attendance_rate':round(present/total*100,1) if total else 0})
        conn.close()
        return jsonify(summary)
    except Exception as e:
        traceback.print_exc()
        return jsonify({'message': 'Server error'}), 500

@app.route('/api/attendance/<record_id>', methods=['DELETE'])
def delete_attendance(record_id):
    try:
        conn   = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("DELETE FROM attendance WHERE id=?", (record_id,))
        conn.commit(); conn.close()
        return jsonify({'message': 'Deleted'}), 200
    except Exception as e:
        traceback.print_exc()
        return jsonify({'message': 'Server error'}), 500


# ───────────────────────────────────────────────
# Grades Routes
# ───────────────────────────────────────────────

@app.route('/api/grades', methods=['GET'])
def get_grades():
    try:
        conn   = get_db_connection()
        cursor = conn.cursor()
        student_id   = request.args.get('student_id','').strip()
        class_filter = request.args.get('class','').strip()
        subject      = request.args.get('subject','').strip()
        term         = request.args.get('term','').strip()
        exam_type    = request.args.get('exam_type','').strip()
        query  = "SELECT * FROM grades WHERE 1=1"; params = []
        if student_id:   query += " AND (student_id=? OR admission_no=?)"; params += [student_id, student_id]
        if class_filter: query += " AND student_class=?"; params.append(class_filter)
        if subject:      query += " AND subject=?";       params.append(subject)
        if term:         query += " AND term=?";          params.append(term)
        if exam_type:    query += " AND exam_type=?";     params.append(exam_type)
        query += " ORDER BY created_at DESC"
        cursor.execute(query, params)
        rows = [dict(r) for r in cursor.fetchall()]
        conn.close()
        return jsonify(rows)
    except Exception as e:
        traceback.print_exc()
        return jsonify({'message': 'Server error'}), 500

@app.route('/api/grades', methods=['POST'])
def save_grades():
    try:
        data = request.get_json()
        if not data or not isinstance(data, list):
            return jsonify({'message': 'Expected a list of grade entries'}), 400
        conn   = get_db_connection()
        cursor = conn.cursor()
        saved, errors = 0, []
        def sg(sc):
            if sc>=80: return 'A'
            if sc>=60: return 'B'
            if sc>=40: return 'C'
            if sc>=30: return 'D'
            return 'F'
        def sp(sc):
            if sc>=80: return 'Excellent'
            if sc>=60: return 'Good'
            if sc>=40: return 'Average'
            return 'Poor'
        for entry in data:
            try:
                student_id   = entry.get('student_id','').strip()
                admission_no = entry.get('admissionNo', entry.get('admission_no','')).strip()
                if not student_id and admission_no:
                    cursor.execute("SELECT id FROM students WHERE admissionNumber=?", (admission_no,))
                    row = cursor.fetchone()
                    if row: student_id = row['id']
                if not student_id:
                    errors.append(f"Could not resolve student for admissionNo={admission_no}"); continue
                student_name  = entry.get('studentName', entry.get('student_name','')).strip()
                student_class = entry.get('class', entry.get('student_class','')).strip()
                if not student_name or not student_class:
                    cursor.execute("SELECT fullName,studentClass FROM students WHERE id=?", (student_id,))
                    s = cursor.fetchone()
                    if s:
                        student_name  = student_name  or s['fullName']
                        student_class = student_class or s['studentClass']
                score        = max(0, min(100, int(entry.get('score',0))))
                term         = entry.get('term','Term 1').strip()
                subject      = entry.get('subject','').strip()
                exam_type    = entry.get('examType', entry.get('exam_type','End of Term')).strip()
                teacher_name = entry.get('teacherName', entry.get('teacher_name','')).strip()
                teacher_id   = entry.get('teacher_id','').strip()
                remarks      = entry.get('remarks','').strip()
                now          = datetime.now().isoformat()
                date_posted  = entry.get('datePosted', entry.get('date_posted', now[:10]))
                cursor.execute("""
                    SELECT id FROM grades WHERE student_id=? AND subject=? AND term=? AND exam_type=?
                """, (student_id, subject, term, exam_type))
                existing = cursor.fetchone()
                if existing:
                    cursor.execute("""
                        UPDATE grades SET score=?,grade=?,performance=?,teacher_name=?,
                          teacher_id=?,remarks=?,date_posted=?,created_at=?,
                          student_name=?,student_class=?,admission_no=? WHERE id=?
                    """, (score, sg(score), sp(score), teacher_name, teacher_id, remarks,
                          date_posted, now, student_name, student_class, admission_no, existing['id']))
                else:
                    cursor.execute("""
                        INSERT INTO grades
                          (id,student_id,admission_no,student_name,student_class,
                           subject,score,grade,performance,term,exam_type,
                           teacher_name,teacher_id,remarks,date_posted,created_at)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                    """, (str(uuid.uuid4()), student_id, admission_no, student_name, student_class,
                          subject, score, sg(score), sp(score), term, exam_type,
                          teacher_name, teacher_id, remarks, date_posted, now))
                saved += 1
            except Exception as row_err:
                errors.append(str(row_err))
        conn.commit(); conn.close()
        return jsonify({'saved': saved, 'errors': errors}), 200
    except Exception as e:
        traceback.print_exc()
        return jsonify({'message': 'Server error'}), 500

@app.route('/api/grades/<grade_id>', methods=['DELETE'])
def delete_grade(grade_id):
    try:
        conn   = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("DELETE FROM grades WHERE id=?", (grade_id,))
        conn.commit(); conn.close()
        return jsonify({'message': 'Deleted'}), 200
    except Exception as e:
        traceback.print_exc()
        return jsonify({'message': 'Server error'}), 500

@app.route('/api/grades/summary', methods=['GET'])
def grades_summary():
    try:
        conn   = get_db_connection()
        cursor = conn.cursor()
        term   = request.args.get('term','').strip()
        query  = "SELECT * FROM grades WHERE 1=1"; params = []
        if term: query += " AND term=?"; params.append(term)
        cursor.execute(query, params)
        rows = [dict(r) for r in cursor.fetchall()]
        conn.close()
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
    except Exception as e:
        traceback.print_exc()
        return jsonify({'message': 'Server error'}), 500


# ───────────────────────────────────────────────
# Announcements Routes
# ───────────────────────────────────────────────

@app.route('/api/announcements', methods=['GET'])
def get_announcements():
    try:
        conn   = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("""
            SELECT id,title,content,author,author_role,audience,priority,created_at,updated_at
            FROM announcements ORDER BY created_at DESC
        """)
        rows = [dict(r) for r in cursor.fetchall()]
        conn.close()
        return jsonify(rows)
    except Exception as e:
        traceback.print_exc()
        return jsonify({'message': 'Server error'}), 500

@app.route('/api/announcements', methods=['POST'])
def create_announcement():
    try:
        data     = request.get_json()
        title    = (data.get('title') or '').strip()
        content  = (data.get('content') or '').strip()
        author   = (data.get('author') or 'Admin').strip()
        aut_role = (data.get('author_role') or 'Admin').strip()
        if not title or not content:
            return jsonify({'message': 'Title and content are required'}), 400
        aid = str(uuid.uuid4()); now = datetime.now().isoformat()
        conn   = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("""
            INSERT INTO announcements (id,title,content,author,author_role,audience,priority,created_at)
            VALUES (?,?,?,?,?,?,?,?)
        """, (aid, title, content, author, aut_role,
              data.get('audience','all'), data.get('priority','normal'), now))
        conn.commit(); conn.close()
        return jsonify({'message': 'Announcement posted', 'id': aid}), 201
    except Exception as e:
        traceback.print_exc()
        return jsonify({'message': 'Server error'}), 500

@app.route('/api/announcements/<ann_id>', methods=['PUT'])
def update_announcement(ann_id):
    try:
        data = request.get_json(); now = datetime.now().isoformat()
        conn   = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("""
            UPDATE announcements SET title=?,content=?,audience=?,priority=?,updated_at=? WHERE id=?
        """, (data.get('title'), data.get('content'),
              data.get('audience','all'), data.get('priority','normal'), now, ann_id))
        conn.commit(); conn.close()
        return jsonify({'message': 'Announcement updated'})
    except Exception as e:
        traceback.print_exc()
        return jsonify({'message': 'Server error'}), 500

@app.route('/api/announcements/<ann_id>', methods=['DELETE'])
def delete_announcement(ann_id):
    try:
        conn   = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("DELETE FROM announcements WHERE id=?", (ann_id,))
        conn.commit(); conn.close()
        return jsonify({'message': 'Announcement deleted'})
    except Exception as e:
        traceback.print_exc()
        return jsonify({'message': 'Server error'}), 500


# ───────────────────────────────────────────────
# Backup & Restore
# ───────────────────────────────────────────────

@app.route('/api/backup', methods=['GET'])
def backup_system():
    try:
        conn   = get_db_connection()
        cursor = conn.cursor()
        all_users = []
        for role, tbl in ROLE_TABLE.items():
            cursor.execute(f"SELECT * FROM {tbl}")
            for row in cursor.fetchall():
                u = dict(row); u['role'] = role.lower(); all_users.append(u)
        cursor.execute("SELECT * FROM roles")
        roles = []
        for row in cursor.fetchall():
            r = dict(row); r['permissions'] = json.loads(r['permissions']) if r['permissions'] else {}
            roles.append(r)
        cursor.execute("SELECT * FROM students")
        students = [dict(r) for r in cursor.fetchall()]
        conn.close()
        return jsonify({'backup': {'timestamp': datetime.now().isoformat(), 'version': '2.0',
                                   'users': all_users, 'roles': roles, 'students': students}})
    except Exception as e:
        traceback.print_exc()
        return jsonify({'message': 'Backup failed'}), 500

@app.route('/api/restore', methods=['POST'])
def restore_system():
    try:
        data   = request.get_json()
        backup = data.get('backup')
        if not backup:
            return jsonify({'message': 'Invalid backup file'}), 400
        conn   = get_db_connection()
        cursor = conn.cursor()
        for rd in (backup.get('roles') or []):
            cursor.execute("""
                INSERT OR REPLACE INTO roles (id,name,description,is_system_role,permissions,users_count,created_at)
                VALUES (?,?,?,?,?,?,?)
            """, (rd['id'], rd['name'], rd.get('description',''), rd.get('is_system_role',0),
                  json.dumps(rd.get('permissions',{})), rd.get('users_count',0),
                  rd.get('created_at', datetime.now().isoformat())))
        for user in (backup.get('users') or []):
            role = (user.get('role') or 'admin').lower()
            tbl  = table_for_role(role)
            uid  = user.get('id') or str(uuid.uuid4())
            now  = user.get('createdAt') or user.get('created_at') or datetime.now().isoformat()
            pwd  = user.get('password','')
            if pwd and not pwd.startswith('$2b$'):
                pwd = bcrypt.hashpw(pwd.encode(), bcrypt.gensalt()).decode()
            if tbl == 'parents':
                cursor.execute("""
                    INSERT OR REPLACE INTO parents
                      (id,fullName,email,password,phone,date_of_birth,gender,address,children,status,last_login,createdAt)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
                """, (uid, user['fullName'], user['email'], pwd,
                      user.get('phone'), user.get('date_of_birth'), user.get('gender'),
                      user.get('address'), user.get('children','[]'),
                      user.get('status','active'), user.get('last_login'), now))
            elif tbl == 'teachers':
                cursor.execute("""
                    INSERT OR REPLACE INTO teachers
                      (id,fullName,email,password,phone,date_of_birth,gender,address,subject,status,last_login,createdAt)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
                """, (uid, user['fullName'], user['email'], pwd,
                      user.get('phone'), user.get('date_of_birth'), user.get('gender'),
                      user.get('address'), user.get('subject'),
                      user.get('status','active'), user.get('last_login'), now))
            else:
                cursor.execute(f"""
                    INSERT OR REPLACE INTO {tbl}
                      (id,fullName,email,password,phone,date_of_birth,gender,address,status,last_login,createdAt)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?)
                """, (uid, user['fullName'], user['email'], pwd,
                      user.get('phone'), user.get('date_of_birth'), user.get('gender'),
                      user.get('address'), user.get('status','active'),
                      user.get('last_login'), now))
        for s in (backup.get('students') or []):
            cursor.execute("""
                INSERT OR REPLACE INTO students
                  (id,fullName,admissionNumber,studentClass,gender,date_of_birth,
                   parentName,parentPhone,address,status,admissionDate,createdAt)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
            """, (s['id'], s['fullName'], s['admissionNumber'], s.get('studentClass'),
                  s.get('gender'), s.get('date_of_birth'), s.get('parentName'),
                  s.get('parentPhone'), s.get('address'), s.get('status','active'),
                  s.get('admissionDate'), s.get('createdAt', datetime.now().isoformat())))
        conn.commit(); conn.close()
        return jsonify({'message': 'Restore completed successfully'})
    except Exception as e:
        traceback.print_exc()
        return jsonify({'message': 'Restore failed'}), 500


# ───────────────────────────────────────────────
# Teacher Assignments Routes
# ───────────────────────────────────────────────

@app.route('/api/teacher-assignments/summary', methods=['GET'])
def get_teacher_assignments_summary():
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT id, fullName, email, phone, status FROM teachers ORDER BY fullName ASC")
        teachers = [dict(r) for r in cursor.fetchall()]
        result = []
        for t in teachers:
            cursor.execute(
                "SELECT * FROM teacher_assignments WHERE teacher_id = ? ORDER BY assigned_at DESC",
                (t['id'],)
            )
            assignments = [dict(r) for r in cursor.fetchall()]
            result.append({**t, 'assignments': assignments})
        conn.close()
        return jsonify(result)
    except Exception as e:
        traceback.print_exc()
        return jsonify({'message': 'Server error'}), 500


@app.route('/api/teacher-assignments', methods=['POST'])
def create_teacher_assignment():
    try:
        data = request.get_json()
        teacher_id  = (data.get('teacher_id')  or '').strip()
        class_name  = (data.get('class_name')   or '').strip()
        subject     = (data.get('subject')      or '').strip()
        assigned_by = data.get('assigned_by', 'Admin')
        if not teacher_id or not class_name or not subject:
            return jsonify({'message': 'teacher_id, class_name and subject are required'}), 400
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT fullName FROM teachers WHERE id = ?", (teacher_id,))
        row = cursor.fetchone()
        if not row:
            conn.close()
            return jsonify({'message': 'Teacher not found'}), 404
        teacher_name = row['fullName']
        aid = str(uuid.uuid4())
        now = datetime.now().isoformat()
        cursor.execute(
            "INSERT INTO teacher_assignments (id, teacher_id, class_name, subject, assigned_by, assigned_at) VALUES (?,?,?,?,?,?)",
            (aid, teacher_id, class_name, subject, assigned_by, now)
        )
        conn.commit(); conn.close()
        return jsonify({'message': 'Assignment created', 'id': aid, 'teacher_name': teacher_name}), 201
    except Exception as e:
        traceback.print_exc()
        return jsonify({'message': 'Server error'}), 500


@app.route('/api/teacher-assignments/<assignment_id>', methods=['DELETE'])
def delete_teacher_assignment(assignment_id):
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("DELETE FROM teacher_assignments WHERE id = ?", (assignment_id,))
        if cursor.rowcount == 0:
            conn.close()
            return jsonify({'message': 'Assignment not found'}), 404
        conn.commit(); conn.close()
        return jsonify({'message': 'Assignment removed'})
    except Exception as e:
        traceback.print_exc()
        return jsonify({'message': 'Server error'}), 500


# ───────────────────────────────────────────────
# Class Teacher Assignments Routes
# ───────────────────────────────────────────────

@app.route('/api/class-teacher-assignments', methods=['GET'])
def get_class_teachers():
    """Return all class-teacher assignments, joined with teacher info."""
    try:
        with db_conn() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT cta.id, cta.class_name, cta.assigned_by, cta.assigned_at,
                       t.id as teacher_id, t.fullName as teacher_name,
                       t.email as teacher_email, t.phone as teacher_phone
                FROM   class_teacher_assignments cta
                JOIN   teachers t ON t.id = cta.teacher_id
                ORDER  BY cta.class_name ASC
            """)
            rows = [dict(r) for r in cursor.fetchall()]
        return jsonify(rows)
    except Exception as e:
        traceback.print_exc()
        return jsonify({'message': 'Server error'}), 500


@app.route('/api/class-teacher-assignments', methods=['POST'])
def assign_class_teacher():
    """
    Assign a teacher as class teacher for a given class.
    A class can only have ONE class teacher — this upserts (replaces previous).
    Body: { teacher_id, class_name, assigned_by? }
    """
    try:
        data        = request.get_json()
        teacher_id  = (data.get('teacher_id') or '').strip()
        class_name  = (data.get('class_name') or '').strip()
        assigned_by = data.get('assigned_by', 'Admin')

        if not teacher_id or not class_name:
            return jsonify({'message': 'teacher_id and class_name are required'}), 400

        with db_conn() as conn:
            cursor = conn.cursor()
            # Verify teacher exists
            cursor.execute("SELECT fullName FROM teachers WHERE id = ?", (teacher_id,))
            row = cursor.fetchone()
            if not row:
                return jsonify({'message': 'Teacher not found'}), 404
            teacher_name = row['fullName']

            # Upsert — replace any existing class teacher for this class
            aid = str(uuid.uuid4())
            now = datetime.now().isoformat()
            cursor.execute("""
                INSERT INTO class_teacher_assignments (id, teacher_id, class_name, assigned_by, assigned_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(class_name) DO UPDATE SET
                    id          = excluded.id,
                    teacher_id  = excluded.teacher_id,
                    assigned_by = excluded.assigned_by,
                    assigned_at = excluded.assigned_at
            """, (aid, teacher_id, class_name, assigned_by, now))

        return jsonify({
            'message':      f'{teacher_name} set as class teacher for {class_name}',
            'id':           aid,
            'teacher_name': teacher_name,
            'class_name':   class_name
        }), 201
    except Exception as e:
        traceback.print_exc()
        return jsonify({'message': 'Server error'}), 500


@app.route('/api/class-teacher-assignments/<class_name>', methods=['DELETE'])
def remove_class_teacher(class_name):
    """Remove the class teacher assignment for a given class."""
    try:
        with db_conn() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "DELETE FROM class_teacher_assignments WHERE class_name = ?",
                (class_name,)
            )
            if cursor.rowcount == 0:
                return jsonify({'message': 'No class teacher assigned to this class'}), 404
        return jsonify({'message': f'Class teacher removed from {class_name}'})
    except Exception as e:
        traceback.print_exc()
        return jsonify({'message': 'Server error'}), 500




@app.route('/api/dashboard', methods=['GET'])
def dashboard():
    try:
        conn   = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT COUNT(*) as total FROM students")
        total_students = cursor.fetchone()['total']
        cursor.execute("SELECT COUNT(*) as active FROM students WHERE LOWER(status)='active'")
        active_students = cursor.fetchone()['active']
        cursor.execute("SELECT studentClass, COUNT(*) as cnt FROM students GROUP BY studentClass ORDER BY studentClass ASC")
        by_grade = [{'grade': r['studentClass'] or 'Unknown', 'count': r['cnt']} for r in cursor.fetchall()]
        cursor.execute("SELECT COUNT(*) as cnt FROM teachers")
        total_teachers = cursor.fetchone()['cnt']
        cursor.execute("SELECT COUNT(*) as cnt FROM parents")
        total_parents = cursor.fetchone()['cnt']
        cursor.execute("SELECT COALESCE(SUM(total_fee),0) as billed FROM fee_structure")
        total_billed = cursor.fetchone()['billed']
        cursor.execute("SELECT COALESCE(SUM(amount),0) as collected FROM fee_payments")
        total_collected = cursor.fetchone()['collected']
        total_arrears   = max(0, total_billed - total_collected)
        cursor.execute("SELECT COUNT(DISTINCT student_id) as cnt FROM fee_payments")
        students_paid = cursor.fetchone()['cnt']
        cursor.execute("""
            SELECT COUNT(DISTINCT fs.student_id) as cnt FROM fee_structure fs
            LEFT JOIN fee_payments fp ON fp.student_id=fs.student_id WHERE fp.id IS NULL
        """)
        students_no_payment = cursor.fetchone()['cnt']
        cursor.execute("""
            SELECT fp.id,fp.amount,fp.method,fp.term,fp.year,fp.status,fp.created_at,
                   s.fullName,s.studentClass,s.admissionNumber
            FROM fee_payments fp LEFT JOIN students s ON s.id=fp.student_id
            ORDER BY fp.created_at DESC LIMIT 10
        """)
        recent_payments = [dict(r) for r in cursor.fetchall()]
        cursor.execute("SELECT id,fullName,studentClass,admissionNumber,createdAt FROM students ORDER BY createdAt DESC LIMIT 5")
        recent_students = [dict(r) for r in cursor.fetchall()]
        cursor.execute("SELECT COUNT(*) as cnt FROM announcements")
        ann_count = cursor.fetchone()['cnt']
        conn.close()
        collection_rate = round(total_collected / total_billed * 100, 1) if total_billed > 0 else 0
        return jsonify({
            'students': {'total': total_students, 'active': active_students, 'by_grade': by_grade},
            'staff':    {'teachers': total_teachers, 'parents': total_parents},
            'fees': {'total_billed': total_billed, 'total_collected': total_collected,
                     'total_arrears': total_arrears, 'students_paid': students_paid,
                     'students_no_payment': students_no_payment, 'collection_rate': collection_rate},
            'recent_payments': recent_payments,
            'recent_students': recent_students,
            'announcements':   ann_count,
        })
    except Exception as e:
        traceback.print_exc()
        return jsonify({'message': 'Server error'}), 500

@app.route('/api/classes', methods=['GET'])
def get_classes():
    try:
        conn   = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("""
            SELECT DISTINCT studentClass 
            FROM students 
            WHERE studentClass IS NOT NULL AND studentClass != ''
            ORDER BY studentClass ASC
        """)
        classes = [row['studentClass'] for row in cursor.fetchall()]
        conn.close()
        return jsonify(classes)
    except Exception as e:
        traceback.print_exc()
        return jsonify({'message': 'Server error'}), 500


@app.route('/health', methods=['GET'])
def health():
    return jsonify({'status': 'OK', 'timestamp': datetime.now().isoformat()})

@app.errorhandler(404)
def not_found(e):
    return jsonify({"error": "Not Found",
                    "message": "Use /api/* endpoints or / for the login page."}), 404

if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=5000)
