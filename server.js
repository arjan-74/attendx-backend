const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const nodemailer = require('nodemailer');
const { Expo } = require('expo-server-sdk');
require('dotenv').config();

const app = express();
const expo = new Expo();
app.use(cors());
app.use(express.json());

// ─── EMAIL TRANSPORTER ────────────────────────
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  }
});

const sendEmail = async (to, subject, html) => {
  try {
    await transporter.sendMail({
      from: `"AttendX" <${process.env.EMAIL_USER}>`,
      to, subject, html
    });
    console.log(`Email sent to ${to}`);
  } catch (e) {
    console.error('Email error:', e.message);
  }
};

// ─── MONGOOSE ─────────────────────────────────
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('MongoDB connected'))
  .catch(e => console.error('MongoDB error:', e));

// ─── SCHEMAS ──────────────────────────────────
const UserSchema = new mongoose.Schema({
  id: { type: String, default: uuidv4 },
  name: String,
  email: { type: String, unique: true },
  password: String,
  role: { type: String, enum: ['student', 'faculty', 'admin'] },
  pushToken: String,
  resetToken: String,
  resetTokenExpiry: Date,
});
const ClassSchema = new mongoose.Schema({
  id: { type: String, default: uuidv4 },
  name: String, room: String, time: String, facultyId: String
});
const EnrollmentSchema = new mongoose.Schema({
  studentId: String, classId: String
});
const AttendanceSchema = new mongoose.Schema({
  id: { type: String, default: uuidv4 },
  studentId: String, classId: String, facultyId: String,
  timestamp: { type: Date, default: Date.now },
  method: { type: String, enum: ['qr', 'manual'] }
});

const User = mongoose.model('User', UserSchema);
const Class = mongoose.model('Class', ClassSchema);
const Enrollment = mongoose.model('Enrollment', EnrollmentSchema);
const Attendance = mongoose.model('Attendance', AttendanceSchema);

// ─── QR TOKEN STORE ───────────────────────────
const qrTokens = new Map();

// ─── AUTH MIDDLEWARE ──────────────────────────
const authMiddleware = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
};

// ─── SEED ─────────────────────────────────────
const seedDatabase = async () => {
  const count = await User.countDocuments();
  if (count === 0) {
    const hashed = await bcrypt.hash('Admin@1234', 10);
    await User.create({
      id: uuidv4(), name: 'Admin User',
      email: 'admin@university.edu',
      password: hashed, role: 'admin'
    });
    console.log('Admin seeded: admin@university.edu / Admin@1234');
  }
};
mongoose.connection.once('open', seedDatabase);

// ─── AUTH ROUTES ──────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ error: 'Invalid credentials' });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(400).json({ error: 'Invalid credentials' });
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, name: user.name },
      process.env.JWT_SECRET, { expiresIn: '7d' }
    );
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/push-token', authMiddleware, async (req, res) => {
  try {
    const { pushToken } = req.body;
    await User.updateOne({ id: req.user.id }, { pushToken });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── FORGOT PASSWORD ──────────────────────────
app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ error: 'No account found with this email' });

    const tempPassword = Math.random().toString(36).slice(-8) + Math.random().toString(36).slice(-4).toUpperCase();
    const hashed = await bcrypt.hash(tempPassword, 10);
    await User.updateOne({ email }, { password: hashed });

    await sendEmail(email, 'AttendX — Password Reset', `
      <div style="font-family:sans-serif;max-width:480px;margin:auto;background:#0a0a0f;color:#f0eeff;padding:32px;border-radius:16px;">
        <h1 style="color:#6c63ff;letter-spacing:-1px;">AttendX</h1>
        <h2 style="color:#f0eeff;">Password Reset</h2>
        <p>Hi <strong>${user.name}</strong>,</p>
        <p>Your password has been reset. Here are your new temporary credentials:</p>
        <div style="background:#13131a;border-radius:12px;padding:20px;margin:20px 0;">
          <p style="margin:0;color:#7a7a9a;font-size:12px;letter-spacing:2px;">EMAIL</p>
          <p style="margin:4px 0 16px;font-size:16px;font-weight:700;">${email}</p>
          <p style="margin:0;color:#7a7a9a;font-size:12px;letter-spacing:2px;">TEMPORARY PASSWORD</p>
          <p style="margin:4px 0;font-size:24px;font-weight:900;color:#6c63ff;letter-spacing:2px;">${tempPassword}</p>
        </div>
        <p style="color:#7a7a9a;font-size:13px;">Please log in and change your password immediately.</p>
        <p style="color:#7a7a9a;font-size:12px;margin-top:32px;">AttendX Smart Attendance System</p>
      </div>
    `);

    res.json({ success: true, message: 'Temporary password sent to your email' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── CLASSES ──────────────────────────────────
app.get('/api/classes', authMiddleware, async (req, res) => {
  try {
    const classes = await Class.find();
    res.json(classes);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── QR ROUTES ────────────────────────────────
app.post('/api/qr/generate', authMiddleware, async (req, res) => {
  try {
    const { classId } = req.body;
    const token = uuidv4();
    qrTokens.set(token, {
      studentId: req.user.id, classId,
      expiresAt: Date.now() + 60000
    });
    const qrImage = await QRCode.toDataURL(JSON.stringify({ token }));
    res.json({ token, qrImage, expiresAt: Date.now() + 60000 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/qr/verify', authMiddleware, async (req, res) => {
  try {
    const { token } = req.body;
    const qrData = qrTokens.get(token);
    if (!qrData) return res.status(400).json({ error: 'Invalid or expired QR code' });
    if (Date.now() > qrData.expiresAt) {
      qrTokens.delete(token);
      return res.status(400).json({ error: 'QR code expired' });
    }

    const existing = await Attendance.findOne({ studentId: qrData.studentId, classId: qrData.classId });
    if (existing) return res.status(400).json({ error: 'Attendance already marked' });

    await Attendance.create({
      id: uuidv4(), studentId: qrData.studentId,
      classId: qrData.classId, facultyId: req.user.id,
      method: 'qr'
    });
    qrTokens.delete(token);

    const student = await User.findOne({ id: qrData.studentId });
    const cls = await Class.findOne({ id: qrData.classId });

    // Push notification to student
    if (student?.pushToken && Expo.isExpoPushToken(student.pushToken)) {
      await expo.sendPushNotificationsAsync([{
        to: student.pushToken,
        title: '✅ Attendance Marked',
        body: `Your attendance for ${cls?.name || qrData.classId} has been recorded.`,
        data: { classId: qrData.classId }
      }]);
    }

    res.json({ success: true, student, classId: qrData.classId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── ATTENDANCE ───────────────────────────────
app.get('/api/attendance/class/:id', authMiddleware, async (req, res) => {
  try {
    const records = await Attendance.find({ classId: req.params.id });
    res.json(records);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/attendance/student/:id', authMiddleware, async (req, res) => {
  try {
    const records = await Attendance.find({ studentId: req.params.id });
    res.json(records);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/attendance/manual', authMiddleware, async (req, res) => {
  try {
    const { studentId, classId } = req.body;
    const existing = await Attendance.findOne({ studentId, classId });
    if (existing) return res.status(400).json({ error: 'Attendance already marked' });

    await Attendance.create({
      id: uuidv4(), studentId, classId,
      facultyId: req.user.id, method: 'manual'
    });

    const student = await User.findOne({ id: studentId });
    const cls = await Class.findOne({ id: classId });

    // Push notification to student
    if (student?.pushToken && Expo.isExpoPushToken(student.pushToken)) {
      await expo.sendPushNotificationsAsync([{
        to: student.pushToken,
        title: '✅ Attendance Marked',
        body: `Your attendance for ${cls?.name || classId} has been recorded manually.`,
        data: { classId }
      }]);
    }

    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── ADMIN ROUTES ─────────────────────────────
app.get('/api/admin/users', authMiddleware, async (req, res) => {
  try {
    const users = await User.find({}, '-password');
    res.json(users);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/users', authMiddleware, async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    const existing = await User.findOne({ email });
    if (existing) return res.status(400).json({ error: 'Email already exists' });

    const hashed = await bcrypt.hash(password, 10);
    const user = await User.create({ id: uuidv4(), name, email, password: hashed, role });

    // Send credentials email
    await sendEmail(email, 'Welcome to AttendX — Your Login Credentials', `
      <div style="font-family:sans-serif;max-width:480px;margin:auto;background:#0a0a0f;color:#f0eeff;padding:32px;border-radius:16px;">
        <h1 style="color:#6c63ff;letter-spacing:-1px;">AttendX</h1>
        <h2 style="color:#f0eeff;">Welcome, ${name}! 👋</h2>
        <p>Your account has been created. Here are your login credentials:</p>
        <div style="background:#13131a;border-radius:12px;padding:20px;margin:20px 0;">
          <p style="margin:0;color:#7a7a9a;font-size:12px;letter-spacing:2px;">EMAIL</p>
          <p style="margin:4px 0 16px;font-size:16px;font-weight:700;">${email}</p>
          <p style="margin:0;color:#7a7a9a;font-size:12px;letter-spacing:2px;">PASSWORD</p>
          <p style="margin:4px 0 16px;font-size:24px;font-weight:900;color:#6c63ff;letter-spacing:2px;">${password}</p>
          <p style="margin:0;color:#7a7a9a;font-size:12px;letter-spacing:2px;">ROLE</p>
          <p style="margin:4px 0;font-size:16px;font-weight:700;color:${role === 'faculty' ? '#00e5a0' : role === 'admin' ? '#ffd166' : '#6c63ff'};text-transform:uppercase;">${role}</p>
        </div>
        <p style="color:#7a7a9a;font-size:13px;">Download the AttendX app and log in with these credentials.</p>
        <p style="color:#7a7a9a;font-size:12px;margin-top:32px;">AttendX Smart Attendance System</p>
      </div>
    `);

    res.json({ success: true, user: { id: user.id, name, email, role } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/users/:userId', authMiddleware, async (req, res) => {
  try {
    await User.deleteOne({ id: req.params.userId });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/classes', authMiddleware, async (req, res) => {
  try {
    const { name, room, time } = req.body;
    const cls = await Class.create({ id: uuidv4(), name, room, time });
    res.json({ success: true, class: cls });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/classes/:classId', authMiddleware, async (req, res) => {
  try {
    await Class.deleteOne({ id: req.params.classId });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── HEALTH CHECK ─────────────────────────────
app.get('/setup-admin', async (req, res) => {
  try {
    await User.deleteMany({ email: 'admin@university.edu' });
    const hashed = await bcrypt.hash('Admin@1234', 10);
    await User.create({
      id: uuidv4(), name: 'Admin User',
      email: 'admin@university.edu',
      password: hashed, role: 'admin'
    });
    res.json({ success: true, message: 'Admin created! Email: admin@university.edu / Password: Admin@1234' });
  } catch (e) {
    res.json({ error: e.message });
  }
});
app.get('/', (req, res) => res.json({ status: 'AttendX backend running' }));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));