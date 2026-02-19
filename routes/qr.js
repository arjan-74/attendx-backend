const express = require('express');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');
const router = express.Router();
const authMiddleware = require('../middleware/auth');

// POST /api/qr/generate — student generates QR
router.post('/generate', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'student')
      return res.status(403).json({ error: 'Students only' });

    const { classId } = req.body;
    if (!classId) return res.status(400).json({ error: 'classId is required' });

    // Check enrollment
    const enrolled = global.db.enrollments.find(
      e => e.studentId === req.user.id && e.classId === classId
    );
    if (!enrolled)
      return res.status(403).json({ error: 'You are not enrolled in this class' });

    // Create token (expires in 60 seconds)
    const token = uuidv4();
    const expiresAt = Date.now() + 60000;

    global.db.activeQRTokens.push({
      token,
      studentId: req.user.id,
      classId,
      expiresAt
    });

    // Clean up old tokens
    global.db.activeQRTokens = global.db.activeQRTokens.filter(t => t.expiresAt > Date.now());

    // Generate QR image as base64
    const payload = JSON.stringify({ token, studentId: req.user.id, classId });
    const qrImage = await QRCode.toDataURL(payload);

    res.json({
      message: 'QR generated',
      token,
      expiresAt,
      expiresInSeconds: 60,
      qrImage // base64 PNG — display directly in app
    });

  } catch (err) {
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// POST /api/qr/verify — faculty scans QR
router.post('/verify', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'faculty' && req.user.role !== 'admin')
      return res.status(403).json({ error: 'Faculty only' });

    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'token is required' });

    // Find token
    const qrEntry = global.db.activeQRTokens.find(t => t.token === token);

    if (!qrEntry)
      return res.status(404).json({ error: 'Invalid QR code' });

    if (Date.now() > qrEntry.expiresAt)
      return res.status(410).json({ error: 'QR code has expired' });

    // Check duplicate attendance
    const today = new Date().toDateString();
    const duplicate = global.db.attendance.find(
      a => a.studentId === qrEntry.studentId &&
           a.classId === qrEntry.classId &&
           new Date(a.timestamp).toDateString() === today
    );

    if (duplicate)
      return res.status(409).json({ error: 'Attendance already recorded for today' });

    // Record attendance
    const record = {
      id: uuidv4(),
      studentId: qrEntry.studentId,
      classId: qrEntry.classId,
      facultyId: req.user.id,
      timestamp: new Date().toISOString(),
      method: 'qr'
    };

    global.db.attendance.push(record);

    // Remove used token
    global.db.activeQRTokens = global.db.activeQRTokens.filter(t => t.token !== token);

    const student = global.db.users.find(u => u.id === qrEntry.studentId);

    res.json({
      message: '✅ Attendance recorded!',
      student: { id: student.id, name: student.name },
      classId: qrEntry.classId,
      timestamp: record.timestamp
    });

  } catch (err) {
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

module.exports = router;