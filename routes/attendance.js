const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');

// GET /api/attendance/class/:classId — get attendance for a class
router.get('/class/:classId', authMiddleware, (req, res) => {
  const records = global.db.attendance.filter(a => a.classId === req.params.classId);
  res.json({ classId: req.params.classId, total: records.length, records });
});

// GET /api/attendance/student/:studentId — get a student's attendance
router.get('/student/:studentId', authMiddleware, (req, res) => {
  const records = global.db.attendance.filter(a => a.studentId === req.params.studentId);

  // Group by class with percentage
  const enrolled = global.db.enrollments.filter(e => e.studentId === req.params.studentId);
  const summary = enrolled.map(e => {
    const classRecords = records.filter(r => r.classId === e.classId);
    return {
      classId: e.classId,
      attended: classRecords.length,
      records: classRecords
    };
  });

  res.json({ studentId: req.params.studentId, summary });
});

// POST /api/attendance/manual — faculty marks manually
router.post('/manual', authMiddleware, (req, res) => {
  if (req.user.role !== 'faculty' && req.user.role !== 'admin')
    return res.status(403).json({ error: 'Faculty only' });

  const { studentId, classId } = req.body;
  if (!studentId || !classId)
    return res.status(400).json({ error: 'studentId and classId are required' });

  const { v4: uuidv4 } = require('uuid');
  const record = {
    id: uuidv4(),
    studentId,
    classId,
    facultyId: req.user.id,
    timestamp: new Date().toISOString(),
    method: 'manual'
  };

  global.db.attendance.push(record);
  res.status(201).json({ message: 'Attendance recorded manually', record });
});

module.exports = router;