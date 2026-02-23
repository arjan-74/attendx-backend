const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');
const { Expo } = require('expo-server-sdk');
const expo = new Expo();
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// ── CONNECT TO MONGODB ────────────────────────
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB connected!'))
  .catch(err => console.log('❌ MongoDB error:', err));

// ── MODELS ────────────────────────────────────
const UserSchema = new mongoose.Schema({
  id: String, name: String, email: String,
  password: String, role: String
});

const ClassSchema = new mongoose.Schema({
  id: String, name: String, faculty: String,
  room: String, time: String, days: String
});

const EnrollmentSchema = new mongoose.Schema({
  studentId: String, classId: String
});

const AttendanceSchema = new mongoose.Schema({
  id: String, studentId: String, classId: String,
  facultyId: String, timestamp: Date, method: String
});

const User       = mongoose.model('User', UserSchema);
const Class      = mongoose.model('Class', ClassSchema);
const Enrollment = mongoose.model('Enrollment', EnrollmentSchema);
const Attendance = mongoose.model('Attendance', AttendanceSchema);

// In-memory QR tokens (these don't need to persist)
let activeQRTokens = [];

// ── SEED DATA (runs once if DB is empty) ──────
async function seedDatabase() {
  const count = await User.countDocuments();
  if (count > 0) return; // already seeded

  console.log('🌱 Seeding database...');

  const hashed = await bcrypt.hash('password', 10);

  await User.insertMany([
    { id: 'STU001', name: 'Riya Kapoor',     email: 'riya@university.edu',  password: hashed, role: 'student' },
    { id: 'STU002', name: 'Aditya Singh',    email: 'aditya@university.edu',password: hashed, role: 'student' },
    { id: 'FAC001', name: 'Dr. Priya Sharma',email: 'priya@university.edu', password: hashed, role: 'faculty' },
    { id: 'ADM001', name: 'Admin User',      email: 'admin@university.edu', password: hashed, role: 'admin'   },
  ]);

  await Class.insertMany([
    { id: 'CS301',  name: 'Data Structures', faculty: 'FAC001', room: 'Lab 3B',  time: '09:00-10:30', days: 'Mon/Wed/Fri' },
    { id: 'CS401',  name: 'Machine Learning',faculty: 'FAC001', room: 'Hall A',  time: '11:00-12:30', days: 'Tue/Thu'     },
    { id: 'MATH201',name: 'Linear Algebra',  faculty: 'FAC001', room: 'Room 204',time: '14:00-15:30', days: 'Mon/Wed'     },
  ]);

  await Enrollment.insertMany([
    { studentId: 'STU001', classId: 'CS301'   },
    { studentId: 'STU001', classId: 'CS401'   },
    { studentId: 'STU001', classId: 'MATH201' },
    { studentId: 'STU002', classId: 'CS301'   },
  ]);

  console.log('✅ Database seeded!');
}

// ── AUTH MIDDLEWARE ────────────────────────────
const authMiddleware = (req, res, next) => {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(403).json({ error: 'Invalid or expired token' });
  }
};

// ── AUTH ROUTES ───────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const user = await User.findOne({ email: email.toLowerCase() });
  if (!user) return res.status(401).json({ error: 'Invalid email or password' });
  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ error: 'Invalid email or password' });
  const token = jwt.sign({ id: user.id, role: user.role, name: user.name }, process.env.JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
});

app.post('/api/auth/register', async (req, res) => {
  const { name, email, password, role } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'All fields required' });
  if (await User.findOne({ email })) return res.status(409).json({ error: 'Email already registered' });
  const hashed = await bcrypt.hash(password, 10);
  const user = await User.create({ id: 'USR' + Date.now(), name, email: email.toLowerCase(), password: hashed, role: role || 'student' });
  res.status(201).json({ message: 'Registered!', user: { id: user.id, name, email, role: user.role } });
});

app.post('/api/auth/push-token', authMiddleware, async (req, res) => {
  const { pushToken } = req.body;
  await User.updateOne({ id: req.user.id }, { pushToken });
  res.json({ message: 'Push token saved' });
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
  const user = await User.findOne({ id: req.user.id });
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json({ id: user.id, name: user.name, email: user.email, role: user.role });
});

// ── CLASS ROUTES ──────────────────────────────
app.get('/api/classes', authMiddleware, async (req, res) => {
  if (req.user.role === 'student') {
    const enrollments = await Enrollment.find({ studentId: req.user.id });
    const ids = enrollments.map(e => e.classId);
    return res.json(await Class.find({ id: { $in: ids } }));
  }
  if (req.user.role === 'faculty') return res.json(await Class.find({ faculty: req.user.id }));
  res.json(await Class.find());
});

app.post('/api/classes', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admins only' });
  const cls = await Class.create(req.body);
  res.status(201).json({ message: 'Class created', class: cls });
});

app.post('/api/classes/:id/enroll', authMiddleware, async (req, res) => {
  const { studentId } = req.body;
  const classId = req.params.id;
  if (await Enrollment.findOne({ studentId, classId }))
    return res.status(409).json({ error: 'Already enrolled' });
  await Enrollment.create({ studentId, classId });
  res.json({ message: 'Enrolled!' });
});

// ── QR ROUTES ─────────────────────────────────
app.post('/api/qr/generate', authMiddleware, async (req, res) => {
  if (req.user.role !== 'student') return res.status(403).json({ error: 'Students only' });
  const { classId } = req.body;
  if (!classId) return res.status(400).json({ error: 'classId required' });
  if (!await Enrollment.findOne({ studentId: req.user.id, classId }))
    return res.status(403).json({ error: 'Not enrolled in this class' });

  const token = uuidv4();
  const expiresAt = Date.now() + 60000;
  activeQRTokens = activeQRTokens.filter(t => t.expiresAt > Date.now());
  activeQRTokens.push({ token, studentId: req.user.id, classId, expiresAt });

  const qrImage = await QRCode.toDataURL(JSON.stringify({ token, studentId: req.user.id, classId }));
  res.json({ token, expiresAt, expiresInSeconds: 60, qrImage });
});

app.post('/api/qr/verify', authMiddleware, async (req, res) => {
  if (req.user.role === 'student') return res.status(403).json({ error: 'Faculty only' });
  const { token } = req.body;
  const qr = activeQRTokens.find(t => t.token === token);
  if (!qr) return res.status(404).json({ error: 'Invalid QR code' });
  if (Date.now() > qr.expiresAt) return res.status(410).json({ error: 'QR code expired' });

  const today = new Date().toDateString();
  const duplicate = await Attendance.findOne({ studentId: qr.studentId, classId: qr.classId });
  if (duplicate && new Date(duplicate.timestamp).toDateString() === today)
    return res.status(409).json({ error: 'Already marked today' });

  await Attendance.create({
    id: uuidv4(), studentId: qr.studentId, classId: qr.classId,
    facultyId: req.user.id, timestamp: new Date(), method: 'qr'
  });

  activeQRTokens = activeQRTokens.filter(t => t.token !== token);
 const student = await User.findOne({ id: qr.studentId });
  
  // Send push notification if student has a token
  if (student.pushToken && Expo.isExpoPushToken(student.pushToken)) {
    await expo.sendPushNotificationsAsync([{
      to: student.pushToken,
      title: '✅ Attendance Marked!',
      body: `You've been marked present for ${qr.classId}`,
      data: { classId: qr.classId }
    }]);
  }

  res.json({ message: 'Attendance recorded!', student: { id: student.id, name: student.name }, classId: qr.classId });
});

// ── ATTENDANCE ROUTES ─────────────────────────
app.get('/api/attendance/class/:classId', authMiddleware, async (req, res) => {
  res.json(await Attendance.find({ classId: req.params.classId }));
});

app.get('/api/attendance/student/:studentId', authMiddleware, async (req, res) => {
  res.json(await Attendance.find({ studentId: req.params.studentId }));
});

app.post('/api/attendance/manual', authMiddleware, async (req, res) => {
  if (req.user.role === 'student') return res.status(403).json({ error: 'Faculty only' });
  const { studentId, classId } = req.body;
  const record = await Attendance.create({
    id: uuidv4(), studentId, classId,
    facultyId: req.user.id, timestamp: new Date(), method: 'manual'
  });
  res.status(201).json({ message: 'Marked manually', record });
});

// ── START ─────────────────────────────────────
app.get('/', (req, res) => res.json({ message: '✅ AttendX API is running!', version: '2.0.0', db: 'MongoDB' }));

app.listen(process.env.PORT || 5000, async () => {
  await seedDatabase();
  console.log('🚀 AttendX server running at http://localhost:5000');
});