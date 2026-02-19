const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();

app.use(cors());
app.use(express.json());

global.db = {
  users: [
    { id: 'STU001', name: 'Riya Kapoor', email: 'riya@university.edu', password: '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', role: 'student' },
    { id: 'FAC001', name: 'Dr. Priya Sharma', email: 'priya@university.edu', password: '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', role: 'faculty' },
    { id: 'ADM001', name: 'Admin User', email: 'admin@university.edu', password: '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', role: 'admin' }
  ],
  classes: [
    { id: 'CS301', name: 'Data Structures', faculty: 'FAC001', room: 'Lab 3B', time: '09:00-10:30', days: 'Mon/Wed/Fri' },
    { id: 'CS401', name: 'Machine Learning', faculty: 'FAC001', room: 'Hall A', time: '11:00-12:30', days: 'Tue/Thu' },
    { id: 'MATH201', name: 'Linear Algebra', faculty: 'FAC002', room: 'Room 204', time: '14:00-15:30', days: 'Mon/Wed' }
  ],
  enrollments: [
    { studentId: 'STU001', classId: 'CS301' },
    { studentId: 'STU001', classId: 'CS401' },
    { studentId: 'STU001', classId: 'MATH201' }
  ],
  attendance: [],
  activeQRTokens: []
};

const authMiddleware = require('./middleware/auth');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const QRCode = require('qrcode');

// ── AUTH ──────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const user = global.db.users.find(u => u.email === email.toLowerCase());
  if (!user) return res.status(401).json({ error: 'Invalid email or password' });
  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ error: 'Invalid email or password' });
  const token = jwt.sign({ id: user.id, role: user.role, name: user.name }, process.env.JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
});

app.post('/api/auth/register', async (req, res) => {
  const { name, email, password, role } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'All fields required' });
  if (global.db.users.find(u => u.email === email)) return res.status(409).json({ error: 'Email already registered' });
  const hashed = await bcrypt.hash(password, 10);
  const user = { id: 'USR' + Date.now(), name, email: email.toLowerCase(), password: hashed, role: role || 'student' };
  global.db.users.push(user);
  res.status(201).json({ message: 'Registered!', user: { id: user.id, name, email, role: user.role } });
});

app.get('/api/auth/me', authMiddleware, (req, res) => {
  const user = global.db.users.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json({ id: user.id, name: user.name, email: user.email, role: user.role });
});

// ── CLASSES ───────────────────────────────────
app.get('/api/classes', authMiddleware, (req, res) => {
  if (req.user.role === 'student') {
    const ids = global.db.enrollments.filter(e => e.studentId === req.user.id).map(e => e.classId);
    return res.json(global.db.classes.filter(c => ids.includes(c.id)));
  }
  if (req.user.role === 'faculty') return res.json(global.db.classes.filter(c => c.faculty === req.user.id));
  res.json(global.db.classes);
});

app.post('/api/classes', authMiddleware, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admins only' });
  const { id, name, faculty, room, time, days } = req.body;
  if (!id || !name) return res.status(400).json({ error: 'id and name required' });
  global.db.classes.push({ id, name, faculty, room, time, days });
  res.status(201).json({ message: 'Class created' });
});

app.post('/api/classes/:id/enroll', authMiddleware, (req, res) => {
  const { studentId } = req.body;
  const classId = req.params.id;
  if (global.db.enrollments.find(e => e.studentId === studentId && e.classId === classId))
    return res.status(409).json({ error: 'Already enrolled' });
  global.db.enrollments.push({ studentId, classId });
  res.json({ message: 'Enrolled!' });
});

// ── QR ────────────────────────────────────────
app.post('/api/qr/generate', authMiddleware, async (req, res) => {
  if (req.user.role !== 'student') return res.status(403).json({ error: 'Students only' });
  const { classId } = req.body;
  if (!classId) return res.status(400).json({ error: 'classId required' });
  if (!global.db.enrollments.find(e => e.studentId === req.user.id && e.classId === classId))
    return res.status(403).json({ error: 'Not enrolled in this class' });
  const token = uuidv4();
  const expiresAt = Date.now() + 60000;
  global.db.activeQRTokens = global.db.activeQRTokens.filter(t => t.expiresAt > Date.now());
  global.db.activeQRTokens.push({ token, studentId: req.user.id, classId, expiresAt });
  const qrImage = await QRCode.toDataURL(JSON.stringify({ token, studentId: req.user.id, classId }));
  res.json({ token, expiresAt, expiresInSeconds: 60, qrImage });
});

app.post('/api/qr/verify', authMiddleware, (req, res) => {
  if (req.user.role === 'student') return res.status(403).json({ error: 'Faculty only' });
  const { token } = req.body;
  const qr = global.db.activeQRTokens.find(t => t.token === token);
  if (!qr) return res.status(404).json({ error: 'Invalid QR code' });
  if (Date.now() > qr.expiresAt) return res.status(410).json({ error: 'QR code expired' });
  const today = new Date().toDateString();
  if (global.db.attendance.find(a => a.studentId === qr.studentId && a.classId === qr.classId && new Date(a.timestamp).toDateString() === today))
    return res.status(409).json({ error: 'Already marked today' });
  const record = { id: uuidv4(), studentId: qr.studentId, classId: qr.classId, facultyId: req.user.id, timestamp: new Date().toISOString(), method: 'qr' };
  global.db.attendance.push(record);
  global.db.activeQRTokens = global.db.activeQRTokens.filter(t => t.token !== token);
  const student = global.db.users.find(u => u.id === qr.studentId);
  res.json({ message: 'Attendance recorded!', student: { id: student.id, name: student.name }, classId: qr.classId });
});

// ── ATTENDANCE ────────────────────────────────
app.get('/api/attendance/class/:classId', authMiddleware, (req, res) => {
  res.json(global.db.attendance.filter(a => a.classId === req.params.classId));
});

app.get('/api/attendance/student/:studentId', authMiddleware, (req, res) => {
  res.json(global.db.attendance.filter(a => a.studentId === req.params.studentId));
});

app.post('/api/attendance/manual', authMiddleware, (req, res) => {
  if (req.user.role === 'student') return res.status(403).json({ error: 'Faculty only' });
  const { studentId, classId } = req.body;
  const record = { id: uuidv4(), studentId, classId, facultyId: req.user.id, timestamp: new Date().toISOString(), method: 'manual' };
  global.db.attendance.push(record);
  res.status(201).json({ message: 'Marked manually', record });
});

// ── START ─────────────────────────────────────
app.get('/', (req, res) => res.json({ message: '✅ AttendX API is running!', version: '1.0.0' }));

app.listen(process.env.PORT || 5000, () => {
  console.log('🚀 AttendX server running at http://localhost:5000');
});
